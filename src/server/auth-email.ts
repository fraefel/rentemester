/**
 * Provider-neutral delivery seam for Better Auth email verification and
 * password-reset messages. Production transport is deliberately outside this
 * foundation; a missing transport must fail closed rather than silently losing
 * a security message.
 */
export type AuthEmailKind = "verification" | "password-reset" | "workspace-invitation";

export type AuthEmailMessage = {
  kind: AuthEmailKind;
  recipient: string;
  url: string;
  token: string;
};

export interface AuthEmailSender {
  send(message: AuthEmailMessage): Promise<void>;
}

export class AuthEmailDeliveryDisabledError extends Error {
  constructor() {
    super("auth email delivery is disabled");
    this.name = "AuthEmailDeliveryDisabledError";
  }
}

/** Intentionally generic: callers never receive a provider response or body. */
export class AuthEmailDeliveryError extends Error {
  constructor() {
    super("auth email delivery failed");
    this.name = "AuthEmailDeliveryError";
  }
}

export type AuthEmailHttpJsonV1Config = {
  url: string;
  bearerToken: string;
  from: string;
  /** Domain-separated HMAC key. The hosted Better Auth secret is injected here. */
  idempotencySecret: string;
};

export type AuthEmailHttpJsonV1Dependencies = {
  fetch?: (request: Request) => Promise<Response>;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  clock?: () => number;
};

const DELIVERY_VERSION = "rentemester-auth-email-v1";
const TOTAL_DEADLINE_MS = 8_000;
const MAX_ATTEMPTS = 3;

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function parseGatewayUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("auth email gateway URL must be an absolute HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("auth email gateway URL must be HTTPS without userinfo or fragment");
  }
  return url;
}

/** Validates injected gateway configuration without ever reflecting its values. */
export function validateAuthEmailHttpJsonV1Config(config: AuthEmailHttpJsonV1Config): void {
  parseGatewayUrl(config.url);
  if (!config.bearerToken?.trim()) throw new Error("auth email gateway bearer token is required");
  if (!looksLikeEmail(config.from)) throw new Error("auth email gateway from address is invalid");
  if (!config.idempotencySecret?.trim()) throw new Error("auth email idempotency secret is required");
}

function subjectAndText(kind: AuthEmailKind): { subject: string; text: string } {
  if (kind === "verification") {
    return {
      subject: "Bekræft din e-mailadresse i Rentemester",
      text: "Bekræft din e-mailadresse ved at åbne linket.",
    };
  }
  if (kind === "workspace-invitation") {
    return {
      subject: "Du er inviteret til Rentemester",
      text: "Åbn invitationen for at oprette eller forbinde din bruger.",
    };
  }
  return {
    subject: "Nulstil din adgangskode til Rentemester",
    text: "Nulstil din adgangskode ved at åbne linket.",
  };
}

function idempotencyKey(config: AuthEmailHttpJsonV1Config, message: AuthEmailMessage): string {
  return createHmac("sha256", config.idempotencySecret)
    .update(`${DELIVERY_VERSION}\0${message.kind}\0${message.token}`)
    .digest("hex");
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function retryDelay(attempt: number): number {
  return 100 * (2 ** (attempt - 1));
}

/**
 * Hosted transactional-email gateway. It has no persistence and no logger:
 * action URLs/tokens are sensitive, while Better Auth deliberately waits for
 * this callback before reporting a verification/reset message as delivered.
 */
export function createHttpJsonV1AuthEmailSender(
  config: AuthEmailHttpJsonV1Config,
  dependencies: AuthEmailHttpJsonV1Dependencies = {},
): AuthEmailSender {
  validateAuthEmailHttpJsonV1Config(config);
  const endpoint = parseGatewayUrl(config.url).toString();
  const doFetch = dependencies.fetch ?? ((request) => fetch(request));
  const sleep = dependencies.sleep ?? defaultSleep;
  const clock = dependencies.clock ?? Date.now;

  return {
    async send(message): Promise<void> {
      const deadline = clock() + TOTAL_DEADLINE_MS;
      const key = idempotencyKey(config, message);
      const content = subjectAndText(message.kind);
      const body = JSON.stringify({
        version: DELIVERY_VERSION,
        kind: message.kind,
        to: message.recipient,
        from: config.from.trim(),
        subject: content.subject,
        text: content.text,
        actionUrl: message.url,
      });

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const remaining = deadline - clock();
        if (remaining <= 0) throw new AuthEmailDeliveryError();
        const abort = new AbortController();
        const timeoutAbort = new AbortController();
        let timedOut = false;
        const timeout = sleep(remaining, timeoutAbort.signal).then(() => {
          timedOut = true;
          abort.abort();
          return null;
        });
        let response: Response | null = null;
        let retryable = false;
        try {
          response = await Promise.race([
            doFetch(new Request(endpoint, {
              method: "POST",
              headers: {
                authorization: `Bearer ${config.bearerToken}`,
                "content-type": "application/json",
                "idempotency-key": key,
                "x-rentemester-auth-event": message.kind,
              },
              body,
              signal: abort.signal,
            })),
            timeout,
          ]);
          timeoutAbort.abort();
          if (response && response.status >= 200 && response.status < 300) return;
          retryable = response?.status === 429 || (response?.status ?? 0) >= 500 || timedOut;
        } catch {
          timeoutAbort.abort();
          retryable = true;
        }
        if (!retryable || attempt === MAX_ATTEMPTS || deadline - clock() <= 0) {
          throw new AuthEmailDeliveryError();
        }
        const delay = Math.min(retryDelay(attempt), Math.max(0, deadline - clock()));
        if (delay <= 0) throw new AuthEmailDeliveryError();
        await sleep(delay);
      }
      throw new AuthEmailDeliveryError();
    },
  };
}

/** The safe default until a deployment supplies a reviewed mail provider. */
export function createDisabledAuthEmailSender(): AuthEmailSender {
  return {
    async send(): Promise<void> {
      throw new AuthEmailDeliveryDisabledError();
    },
  };
}

/** Test-only in-memory transport. It never performs I/O. */
export function createFakeAuthEmailSender(): AuthEmailSender & {
  readonly messages: AuthEmailMessage[];
} {
  const messages: AuthEmailMessage[] = [];
  return {
    messages,
    async send(message): Promise<void> {
      messages.push({ ...message });
    },
  };
}
import { createHmac } from "node:crypto";
