/**
 * Bilagsmail IMAP transport (#181) — polls a hosted mailbox and feeds each
 * fetched message into the EXISTING #122 bilagsmail pipeline.
 *
 * Scope: this file is ONLY the transport. Attachment extraction, message-id
 * + attachment-hash dedup (via the `mail_intake_messages` table) and
 * exception routing are already implemented in `mail-intake.ts` — this
 * module fetches raw RFC-822 messages over IMAP, materialises them into a
 * scratch maildrop directory, and hands that directory to `ingestMailDrop`.
 * Nothing about extraction or dedup is reimplemented here.
 *
 * Determinism: the IMAP client is INJECTED behind the `ImapClient`
 * interface, so unit tests never touch a real server. Dedup is rerun-stable
 * because it is keyed on the message's own `Message-ID` + attachment hash —
 * a second poll that re-fetches the same message creates no new documents.
 * Messages with no usable attachment route into the exception queue, exactly
 * as the local maildrop slice already does.
 *
 * Provider-specific OAuth (Gmail / Microsoft 365) and SMTP sending (#180)
 * are explicitly OUT OF SCOPE.
 *
 * Credentials: IMAP host/port/username/password live in env/config only and
 * are NEVER written to the ledger DB.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { connect as netConnect, type Socket } from "node:net";
import { removePathWithRetry } from "./fs-cleanup";
import type { Database } from "bun:sqlite";
import {
  ingestMailDrop,
  type IngestMailDropOptions,
  type IngestMailDropResult,
} from "./mail-intake";

/*
 * No new rule ID is minted here: the IMAP transport reuses the #122
 * bilagsmail pipeline, whose `MAIL_INTAKE_RULES` (dedup / exception /
 * transport) already govern extraction, dedup and exception routing. This
 * module only changes HOW raw messages arrive, not the bookkeeping rules
 * applied to them.
 */

/** A raw message as returned by an IMAP server. */
export type ImapMessage = {
  /** Server-assigned UID — stable within a mailbox/uidvalidity window. */
  uid: number;
  /** Raw RFC-822 bytes of the message (headers + body). */
  raw: string | Buffer;
};

/**
 * The transport seam. Production code supplies a real IMAP-speaking
 * implementation; tests inject a deterministic in-memory fake. Keeping the
 * surface this small means the poller logic is fully unit-testable without
 * a network and without a new npm dependency for the deterministic slice.
 */
export type ImapClient = {
  /** Opens the connection, authenticates, and selects the target mailbox. */
  connect(): Promise<void>;
  /**
   * Returns the messages to consider for intake. `sinceUid` is an optional
   * lower bound a client MAY use to fetch only newer UIDs; correctness never
   * depends on it because dedup is content-keyed downstream — re-fetching an
   * already-ingested message is always safe.
   */
  fetchSince(sinceUid?: number): Promise<ImapMessage[]>;
  /** Closes the connection and releases the socket. */
  close(): Promise<void>;
};

/** Connection settings for a hosted IMAP mailbox. Never persisted in the ledger. */
export type ImapConfig = {
  host: string;
  port: number;
  username: string;
  password: string;
  /** TLS on connect (IMAPS). Defaults to true. */
  tls?: boolean;
  /** Mailbox to select. Defaults to "INBOX". */
  mailbox?: string;
};

export type PollImapOptions = IngestMailDropOptions & {
  /** Optional UID lower bound forwarded to `ImapClient.fetchSince`. */
  sinceUid?: number;
};

export type PollImapResult = IngestMailDropResult & {
  /** Number of raw messages fetched from the mailbox this poll. */
  messagesFetched: number;
};

/**
 * Polls an IMAP mailbox via the injected `ImapClient`, materialises each
 * fetched message into a scratch maildrop directory, and forwards that
 * directory to the existing `ingestMailDrop` pipeline.
 *
 * The pipeline owns extraction, dedup and exception routing — so:
 *  - re-polling a message that was already ingested produces zero new
 *    documents (dedup is keyed on Message-ID + attachment hash);
 *  - a message with no usable attachment is routed to the exception queue;
 *  - reruns are idempotent and rerun-stable across polls.
 *
 * The client is always `close()`d, even when fetch/ingest throws.
 */
export async function pollImapMailbox(
  db: Database,
  companyRoot: string,
  client: ImapClient,
  options: PollImapOptions = {},
): Promise<PollImapResult> {
  const empty: PollImapResult = {
    ok: true,
    messagesFetched: 0,
    messagesProcessed: 0,
    attachmentsIngested: 0,
    attachmentsSkipped: 0,
    exceptionsCreated: 0,
    documents: [],
    errors: [],
  };

  let messages: ImapMessage[];
  try {
    await client.connect();
    messages = await client.fetchSince(options.sinceUid);
  } catch (error) {
    try {
      await client.close();
    } catch {
      // close() failure after a fetch failure must not mask the root cause.
    }
    return {
      ...empty,
      ok: false,
      errors: [`IMAP poll failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  let dropDir: string | null = null;
  try {
    if (messages.length === 0) {
      return empty;
    }

    // Materialise fetched messages into a deterministic scratch maildrop:
    // filenames are zero-padded by UID so `ingestMailDrop`'s sorted-order
    // processing is stable, and the directory is removed in `finally`.
    dropDir = mkdtempSync(join(tmpdir(), "rentemester-imap-maildrop-"));
    const sorted = [...messages].sort((a, b) => a.uid - b.uid);
    for (const message of sorted) {
      const name = `imap-${String(message.uid).padStart(12, "0")}.eml`;
      const raw = typeof message.raw === "string" ? Buffer.from(message.raw, "utf8") : message.raw;
      writeFileSync(join(dropDir, name), raw);
    }

    const ingestOptions: IngestMailDropOptions = {
      metadata: options.metadata,
      metadataPerMessage: options.metadataPerMessage,
      ingestOptions: options.ingestOptions,
    };
    const result = ingestMailDrop(db, companyRoot, dropDir, ingestOptions);
    return { ...result, messagesFetched: messages.length };
  } finally {
    if (dropDir) removePathWithRetry(dropDir);
    try {
      await client.close();
    } catch {
      // A close() failure does not invalidate an otherwise-successful poll.
    }
  }
}

// ----------------------------------------------------------------------
// Production IMAP client (stdlib only — node:tls / node:net).
//
// A deliberately minimal IMAP4rev1 client: LOGIN, SELECT, UID SEARCH and
// UID FETCH BODY.PEEK[] over a TLS socket. It is intentionally not a full
// IMAP library — it covers exactly what `pollImapMailbox` needs to hand raw
// RFC-822 messages to the existing pipeline. No new npm dependency.
//
// Unit tests never reach this code: they inject a fake `ImapClient`. This
// implementation is exercised only against a real mailbox via the CLI.
// ----------------------------------------------------------------------

/**
 * Builds a production `ImapClient` for a hosted mailbox from connection
 * settings sourced from env/config. Credentials stay in this object's
 * closure and are never written to the ledger DB.
 */
/**
 * SEC-10 (Audit 2026-06-11): hard cap on a single IMAP `{n}` literal. The
 * server declares the literal size; without a bound a malicious or buggy
 * server could announce a multi-gigabyte literal and `readBytes` would buffer
 * the whole thing in memory, OOM-ing the daemon. 64 MiB comfortably exceeds the
 * #122 `DEFAULT_MAX_EML_SIZE_BYTES` (25 MiB) ceiling for a whole message, so a
 * legitimate receipt is never rejected here while a hostile literal is.
 */
const MAX_IMAP_LITERAL_BYTES = 64 * 1024 * 1024;

export function createImapClient(config: ImapConfig): ImapClient {
  const useTls = config.tls !== false;
  const mailbox = config.mailbox ?? "INBOX";
  let socket: TLSSocket | Socket | null = null;
  let buffer = "";
  let tagCounter = 0;

  /** Awaits the next chunk of server data on the socket. */
  function readChunk(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        cleanup();
        buffer += chunk.toString("binary");
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onEnd = () => {
        cleanup();
        reject(new Error("IMAP connection closed by server"));
      };
      function cleanup() {
        socket!.off("data", onData);
        socket!.off("error", onError);
        socket!.off("end", onEnd);
      }
      socket!.once("data", onData);
      socket!.once("error", onError);
      socket!.once("end", onEnd);
    });
  }

  /** Reads until the buffer contains a complete line ending in CRLF. */
  async function readLine(): Promise<string> {
    while (!buffer.includes("\r\n")) await readChunk();
    const idx = buffer.indexOf("\r\n");
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    return line;
  }

  /** Reads exactly `n` bytes from the stream (for IMAP `{n}` literals). */
  async function readBytes(n: number): Promise<string> {
    while (buffer.length < n) await readChunk();
    const data = buffer.slice(0, n);
    buffer = buffer.slice(n);
    return data;
  }

  /**
   * Sends a tagged command and collects the full response: untagged lines,
   * literal payloads, and the final tagged completion line. A non-OK
   * completion is surfaced as an error.
   */
  async function command(text: string): Promise<{ lines: string[]; literals: string[] }> {
    tagCounter += 1;
    const tag = `A${String(tagCounter).padStart(4, "0")}`;
    socket!.write(`${tag} ${text}\r\n`, "binary");
    const lines: string[] = [];
    const literals: string[] = [];
    for (;;) {
      const line = await readLine();
      const literalMatch = /\{(\d+)\}$/.exec(line);
      if (literalMatch) {
        const size = Number(literalMatch[1]);
        literals.push(await readBytes(size));
        lines.push(line);
        continue;
      }
      lines.push(line);
      if (line.startsWith(`${tag} `)) {
        const status = line.slice(tag.length + 1).split(" ")[0];
        if (status !== "OK") {
          throw new Error(`IMAP command failed: ${text.split(" ")[0]} -> ${line}`);
        }
        break;
      }
    }
    return { lines, literals };
  }

  return {
    async connect() {
      socket = await new Promise<TLSSocket | Socket>((resolve, reject) => {
        const opts = { host: config.host, port: config.port };
        const s = useTls
          ? tlsConnect({ ...opts, servername: config.host }, () => resolve(s))
          : netConnect(opts, () => resolve(s));
        s.once("error", reject);
      });
      socket.setEncoding("binary");
      // Consume the server greeting line before issuing commands.
      await readLine();
      await command(`LOGIN ${quote(config.username)} ${quote(config.password)}`);
      await command(`SELECT ${quote(mailbox)}`);
    },

    async fetchSince(sinceUid?: number) {
      // UID SEARCH for the candidate set; dedup downstream means re-fetching
      // an already-ingested message is harmless, so the bound is best-effort.
      const criterion = sinceUid && sinceUid > 0 ? `UID ${sinceUid + 1}:*` : "ALL";
      const search = await command(`UID SEARCH ${criterion}`);
      const uids = new Set<number>();
      for (const line of search.lines) {
        const match = /^\* SEARCH(.*)$/.exec(line);
        if (!match) continue;
        for (const token of match[1]!.trim().split(/\s+/)) {
          const uid = Number(token);
          if (Number.isInteger(uid) && uid > 0) uids.add(uid);
        }
      }
      const messages: ImapMessage[] = [];
      for (const uid of [...uids].sort((a, b) => a - b)) {
        const fetched = await command(`UID FETCH ${uid} BODY.PEEK[]`);
        if (fetched.literals.length > 0) {
          messages.push({ uid, raw: Buffer.from(fetched.literals[0]!, "binary") });
        }
      }
      return messages;
    },

    async close() {
      if (!socket) return;
      try {
        await command("LOGOUT");
      } catch {
        // Best-effort logout; tear the socket down regardless.
      }
      socket.end();
      socket.destroy();
      socket = null;
    },
  };
}

/** Quotes an IMAP astring argument (backslash-escapes `"` and `\`). */
function quote(value: string): string {
  return `"${value.replace(/([\\"])/g, "\\$1")}"`;
}

/**
 * Resolves IMAP connection settings from a config object merged over
 * environment variables. Credentials come from env/config ONLY — never the
 * ledger. Returns either a complete config or the list of missing fields.
 */
export function resolveImapConfig(
  partial: Partial<ImapConfig> = {},
): { ok: true; config: ImapConfig } | { ok: false; errors: string[] } {
  const host = partial.host ?? process.env.RENTEMESTER_IMAP_HOST;
  const portRaw = partial.port ?? process.env.RENTEMESTER_IMAP_PORT;
  const username = partial.username ?? process.env.RENTEMESTER_IMAP_USERNAME;
  const password = partial.password ?? process.env.RENTEMESTER_IMAP_PASSWORD;
  const mailbox = partial.mailbox ?? process.env.RENTEMESTER_IMAP_MAILBOX ?? "INBOX";
  const tlsEnv = process.env.RENTEMESTER_IMAP_TLS;
  const tls = partial.tls ?? (tlsEnv === undefined ? true : tlsEnv !== "false" && tlsEnv !== "0");

  const errors: string[] = [];
  if (!host) errors.push("IMAP host missing (--imap-host or RENTEMESTER_IMAP_HOST)");
  if (!username) errors.push("IMAP username missing (--imap-username or RENTEMESTER_IMAP_USERNAME)");
  if (!password) errors.push("IMAP password missing (RENTEMESTER_IMAP_PASSWORD)");
  const port = portRaw === undefined ? (tls ? 993 : 143) : Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) errors.push("IMAP port must be a positive integer");
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    config: { host: host!, port, username: username!, password: password!, tls, mailbox },
  };
}
