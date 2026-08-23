/**
 * GDPR tooling (#184) — data-subject export and retention-respecting erasure.
 *
 * Rentemester stores personal data about customers and vendors (names,
 * addresses, emails, CVR, and free-text on bank transactions). The Danish
 * business running it is a data controller and must answer data-subject
 * access and erasure requests — but the bookkeeping-law retention requirement
 * (records kept ~5 years) overrides erasure for data still under retention.
 *
 * This module provides two narrow, deterministic operations:
 *
 *  - `buildGdprSubjectExport` — gathers every piece of personal data
 *    Rentemester holds about one customer/vendor/person into one report,
 *    each record annotated with its bookkeeping-retention verdict.
 *
 *  - `eraseGdprSubject` — redacts personal data that is no longer under
 *    retention and clearly REFUSES to erase data still legally required to
 *    be kept.
 *
 * The append-only ledger (`journal_entries` / `journal_lines` / `audit_log`)
 * and its hash chain are NEVER modified. Master-data rows are themselves
 * append-only, so an erasure does not UPDATE/DELETE them either — it records
 * an append-only tombstone in `gdpr_erasures`, and the export layer overlays
 * those tombstones so redacted data never resurfaces. `verifyAuditChain`
 * therefore still passes after any erasure.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { effectiveRetainUntil } from "./retention";
import { insertAuditLog, type ResolveActorInput } from "./actor";
import { currentUtcIsoDate } from "./sequences";
import { addDays, isValidIsoDate, trustedTodayIsoDate } from "./dates";
import {
  backupEd25519PrivateKeyPath,
  backupEd25519PublicKeyPath,
} from "./system-backups";

// The bookkeeping-retention rule that overrides the GDPR right to erasure is
// the canonical, YAML-declared rule. The two GDPR-process labels below are
// operation identifiers (not bookkeeping rule IDs), so they intentionally do
// not use the `DK-…-NNN` rule-bundle namespace.
const EXPORT_RULE_ID = "GDPR-SUBJECT-EXPORT";
const ERASURE_RULE_ID = "GDPR-RETENTION-BOUNDED-ERASURE";
const RETENTION_RULE_ID = "DK-BOOKKEEPING-RETENTION-001";

export type GdprSubjectKey = {
  /** CVR / VAT identifier of the data subject. */
  cvr?: string | null;
  /** Exact display name of the data subject. */
  name?: string | null;
  /** Evaluation date (defaults to the DB clock). */
  asOf?: string | null;
};

export type GdprErasureKey = Omit<GdprSubjectKey, "asOf">;

export type GdprPersonalData = {
  name: string | null;
  address: string | null;
  email: string | null;
  vatOrCvr: string | null;
};

export type GdprExportRecord = {
  source:
    | "customers"
    | "vendors"
    | "documents"
    | "bank_transactions"
    | "journal_entries"
    | "journal_lines"
    | "audit_log";
  sourceRowId: number;
  /** Human label, e.g. document_no or bank reference. */
  label: string | null;
  personalData: GdprPersonalData;
  /** Bookkeeping retention deadline, or null when none applies. */
  retainUntil: string | null;
  /** True when the record must still be kept for bookkeeping law. */
  underRetention: boolean;
  /** True when a prior erasure tombstone covers this record. */
  erased: boolean;
  /** True only when the current record can actually receive a tombstone. */
  erasable: boolean;
};

export type GdprSubjectExport = {
  ok: boolean;
  asOf: string;
  appliedRules: string[];
  subject: { cvr: string | null; name: string | null };
  records: GdprExportRecord[];
  errors: string[];
};

export type GdprErasureRefusal = {
  source: GdprExportRecord["source"];
  sourceRowId: number;
  label: string | null;
  retainUntil: string | null;
  reason: string;
};

export type GdprErasureRecord = {
  source: GdprExportRecord["source"];
  sourceRowId: number;
  label: string | null;
  redactedFields: string[];
};

export type GdprErasureResult = {
  ok: boolean;
  asOf: string;
  appliedRules: string[];
  subject: { cvr: string | null; name: string | null };
  erasedCount: number;
  refusedCount: number;
  alreadyErasedCount: number;
  erased: GdprErasureRecord[];
  refused: GdprErasureRefusal[];
  errors: string[];
};

type RawSourceRow = {
  source: GdprExportRecord["source"];
  sourceRowId: number;
  label: string | null;
  personalData: GdprPersonalData;
  retainUntil: string | null;
  /** Whether this subject-specific view contains raw PII eligible for overlay. */
  redactable: boolean;
};

function trim(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveSubject(key: GdprSubjectKey) {
  return { cvr: trim(key.cvr), name: trim(key.name) };
}

function subjectAuditReference(stableIdentity: string): string {
  return `sha256:${createHash("sha256").update(stableIdentity, "utf8").digest("hex")}`;
}

type ResolvedSubjectScope = {
  subject: { cvr: string | null; name: string | null };
  freeTextTerms: string[];
  auditReference: string;
  /** Pseudonymous aliases that remain stable as identity data gets stronger. */
  auditReferences: string[];
  /** Minimal stable aliases written per source row (avoids quadratic growth). */
  tombstoneReferences: string[];
  /** New pseudonymous keys plus read-only raw keys from legacy releases. */
  erasureSubjectKeys: string[];
};

type SubjectScopeResolution =
  | { ok: true; scope: ResolvedSubjectScope }
  | { ok: false; error: string };

/**
 * Binds CVR and name to the same structured party before any free-text lookup
 * or erasure. The old `cvr OR name` scope could combine two people into one
 * request and tombstone both under the same subject key.
 */
function resolveSubjectScope(
  db: Database,
  subject: { cvr: string | null; name: string | null },
): SubjectScopeResolution {
  const parties = db
    .query(
      `SELECT source, row_id, name, cvr
         FROM (
           SELECT 'customers' AS source, id AS row_id, name, vat_or_cvr AS cvr FROM customers
           UNION ALL
           SELECT 'vendors' AS source, id AS row_id, name, vat_or_cvr AS cvr FROM vendors
           UNION ALL
           SELECT 'documents:sender' AS source, id AS row_id,
                  sender_name AS name, sender_vat_cvr AS cvr FROM documents
           UNION ALL
           SELECT 'documents:recipient' AS source, id AS row_id,
                  recipient_name AS name, recipient_vat_cvr AS cvr FROM documents
         ) AS structured_parties
        WHERE (? IS NULL OR cvr = ?)
          AND (? IS NULL OR name = ?)`,
    )
    .all(subject.cvr, subject.cvr, subject.name, subject.name) as Array<{
    source: string;
    row_id: number;
    name: string | null;
    cvr: string | null;
  }>;

  if (subject.cvr && subject.name && parties.length === 0) {
    return {
      ok: false,
      error: "cvr and name must identify the same GDPR subject",
    };
  }

  const structuredIdentities = new Set<string>();
  for (const party of parties) {
    const cvr = trim(party.cvr);
    const name = trim(party.name);
    if (cvr) structuredIdentities.add(`cvr:${cvr}`);
    else if (name) {
      // Two same-name rows without a stable identifier cannot safely be
      // assumed to describe the same person. Keep their row identities
      // distinct so name-only destructive/read scopes fail closed.
      structuredIdentities.add(`row:${party.source}:${party.row_id}`);
    }
  }
  if (!subject.cvr && subject.name && structuredIdentities.size > 1) {
    return {
      ok: false,
      error: "name matches multiple GDPR subjects; supply cvr to disambiguate",
    };
  }

  const candidateNames = new Set<string>();
  if (subject.name) candidateNames.add(subject.name);
  for (const party of parties) {
    const name = trim(party.name);
    if (name) candidateNames.add(name);
  }

  /**
   * A raw name is only a safe durable alias while it identifies this one
   * structured party. This deliberately considers rows outside the current
   * CVR-filtered scope: two people can share a display name, including the
   * sender and recipient of the same document. In that case a global name
   * tombstone would let one person's erasure redact the other's DSAR view.
   *
   * One no-CVR row may bridge an append-only identity enrichment (an old
   * name-only customer followed by a new CVR-bearing row). More than one
   * no-CVR identity is not safe to infer and therefore fails closed.
   */
  const safeNameAliases = new Set<string>();
  for (const name of candidateNames) {
    const matchingNameParties = db
      .query(
        `SELECT source, row_id, cvr
           FROM (
             SELECT 'customers' AS source, id AS row_id, vat_or_cvr AS cvr, name FROM customers
             UNION ALL
             SELECT 'vendors' AS source, id AS row_id, vat_or_cvr AS cvr, name FROM vendors
             UNION ALL
             SELECT 'documents:sender' AS source, id AS row_id,
                    sender_vat_cvr AS cvr, sender_name AS name FROM documents
             UNION ALL
             SELECT 'documents:recipient' AS source, id AS row_id,
                    recipient_vat_cvr AS cvr, recipient_name AS name FROM documents
           ) AS structured_parties
          WHERE name = ?`,
      )
      .all(name) as Array<{
      source: string;
      row_id: number;
      cvr: string | null;
    }>;
    const matchingCvrs = new Set<string>();
    const noCvrIdentities = new Set<string>();
    for (const party of matchingNameParties) {
      const cvr = trim(party.cvr);
      if (cvr) matchingCvrs.add(cvr);
      else noCvrIdentities.add(`row:${party.source}:${party.row_id}`);
    }
    const hasConflictingCvr = subject.cvr
      ? [...matchingCvrs].some((cvr) => cvr !== subject.cvr)
      : matchingCvrs.size > 1;
    if (!hasConflictingCvr && noCvrIdentities.size <= 1) {
      safeNameAliases.add(name);
    }
  }

  const freeTextTerms = new Set<string>();
  if (subject.cvr) freeTextTerms.add(subject.cvr);
  for (const name of safeNameAliases) freeTextTerms.add(name);

  const canonicalIdentity = subject.cvr
    ? `cvr:${subject.cvr}`
    : structuredIdentities.size === 1
      ? [...structuredIdentities][0]!
      : `name:${subject.name ?? "unknown"}`;

  const auditIdentity =
    canonicalIdentity.startsWith("row:") && subject.name
      ? `name:${subject.name}`
      : canonicalIdentity;
  const auditReference = subjectAuditReference(auditIdentity);
  const identityAliases = new Set<string>([canonicalIdentity]);
  const tombstoneAliases = new Set<string>([canonicalIdentity]);
  if (subject.cvr) identityAliases.add(`cvr:${subject.cvr}`);
  for (const name of safeNameAliases) {
    const nameAlias = `name:${name}`;
    identityAliases.add(nameAlias);
    tombstoneAliases.add(nameAlias);
  }
  for (const party of parties) {
    const cvr = trim(party.cvr);
    if (cvr) identityAliases.add(`cvr:${cvr}`);
    // Master rows are mutable and therefore need a stable row alias if CVR or
    // name later changes. Document parties with CVR are append-only and use
    // that CVR; a no-CVR document identity gets a row alias. Avoiding one alias
    // per ordinary document prevents N records × N aliases tombstone growth.
    if (
      party.source === "customers" ||
      party.source === "vendors" ||
      !cvr
    ) {
      const rowAlias = `row:${party.source}:${party.row_id}`;
      identityAliases.add(rowAlias);
      tombstoneAliases.add(rowAlias);
    }
  }
  const auditReferences = [...identityAliases].map(subjectAuditReference);
  return {
    ok: true,
    scope: {
      subject,
      freeTextTerms: [...freeTextTerms],
      auditReference,
      auditReferences,
      tombstoneReferences: [...tombstoneAliases].map(subjectAuditReference),
      // Legacy releases wrote raw CVRs/names. Keep every candidate raw name
      // readable even when it is now ambiguous, otherwise an upgrade could
      // resurface data covered by an old source-row tombstone. Ambiguous names
      // are deliberately absent from tombstoneReferences, so no new global
      // name tombstones can be created.
      erasureSubjectKeys: [
        ...auditReferences,
        ...freeTextTerms,
        ...candidateNames,
      ],
    },
  };
}

/** Zero-initialised per-table counter covering every export source. */
function emptyByTable(): Record<GdprExportRecord["source"], number> {
  return {
    customers: 0,
    vendors: 0,
    documents: 0,
    bank_transactions: 0,
    journal_entries: 0,
    journal_lines: 0,
    audit_log: 0,
  };
}

/**
 * The hash-chained journal sources whose free-text can hold personal data.
 * Their bytes are exported for Art. 15 but never altered or overlaid here.
 * Audit-log rows are different: their immutable bytes stay intact, while an
 * append-only GDPR tombstone may hide raw PII in later subject exports.
 */
const LEDGER_TEXT_SOURCES: ReadonlySet<GdprExportRecord["source"]> = new Set([
  "journal_entries",
  "journal_lines",
]);

/**
 * Loads prior erasure tombstones keyed by `source:rowId`. Each value is the
 * set of field names that were redacted.
 */
function loadErasures(
  db: Database,
  subjectKeys: string[],
): Map<string, Set<string>> {
  const uniqueSubjectKeys = [...new Set(subjectKeys)];
  if (uniqueSubjectKeys.length === 0) return new Map();
  const placeholders = uniqueSubjectKeys.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT source, source_row_id, redacted_fields
         FROM gdpr_erasures
        WHERE subject_key IN (${placeholders})`,
    )
    .all(...uniqueSubjectKeys) as Array<{
    source: string;
    source_row_id: number;
    redacted_fields: string;
  }>;
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    let fields: string[];
    try {
      fields = JSON.parse(row.redacted_fields) as string[];
    } catch {
      fields = [];
    }
    const key = `${row.source}:${row.source_row_id}`;
    const merged = map.get(key) ?? new Set<string>();
    for (const field of fields) merged.add(field);
    map.set(key, merged);
  }
  return map;
}

/**
 * Copies an already-effective tombstone to every currently safe stable alias.
 * This is the append-only identity-binding step: if a unique name-only
 * erasure is later resolved through a CVR, the CVR key receives the same
 * source-row evidence before a future same-name party can make the raw name
 * ambiguous. No raw data or prior tombstone is modified.
 */
function strengthenErasureAliases(
  db: Database,
  scope: ResolvedSubjectScope,
  rows: RawSourceRow[],
  erasures: Map<string, Set<string>>,
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO gdpr_erasures
       (subject_key, source, source_row_id, redacted_fields, rule_id, reason,
        retained_until_at_erasure)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    const fields = erasures.get(`${row.source}:${row.sourceRowId}`);
    if (!fields || fields.size === 0 || LEDGER_TEXT_SOURCES.has(row.source)) {
      continue;
    }
    // A display-name match is not evidence that a newly introduced CVR owns
    // the historical row: two different parties may share that name, and the
    // one created first must not capture the other's tombstone. A CVR scope
    // is strengthened only when the source row itself carries that exact CVR
    // as structured data or literal free-text evidence.
    const cvr = scope.subject.cvr;
    if (
      cvr &&
      row.personalData.vatOrCvr !== cvr &&
      !row.personalData.name?.includes(cvr) &&
      !row.label?.includes(cvr)
    ) {
      continue;
    }
    const serializedFields = JSON.stringify([...fields].sort());
    for (const aliasRef of scope.tombstoneReferences) {
      insert.run(
        aliasRef,
        row.source,
        row.sourceRowId,
        serializedFields,
        ERASURE_RULE_ID,
        "pseudonymous identity alias linked to a prior GDPR erasure",
        row.retainUntil,
      );
    }
  }
}

/**
 * Atomically bind an earlier name-only erasure to a newly introduced stable
 * identifier. Master-data/document writers call this inside the same write
 * transaction that introduces the CVR, before another same-name identity can
 * make the alias ambiguous. The fast-path is a no-op unless a legacy raw-name
 * or current hashed-name tombstone actually exists.
 */
export function strengthenGdprErasureAliasesForIdentity(
  db: Database,
  identity: { name?: string | null; cvr?: string | null },
): void {
  const subject = resolveSubject(identity);
  if (!subject.name || !subject.cvr) return;
  const nameReference = subjectAuditReference(`name:${subject.name}`);
  const priorNameErasure = db
    .query(
      `SELECT 1
         FROM gdpr_erasures
        WHERE subject_key IN (?, ?)
        LIMIT 1`,
    )
    .get(nameReference, subject.name);
  if (!priorNameErasure) return;

  const scopeResolution = resolveSubjectScope(db, subject);
  if (!scopeResolution.ok) return;
  const erasures = loadErasures(
    db,
    // The name may already have become ambiguous. It is safe to inspect its
    // old hash here because strengthenErasureAliases still requires exact CVR
    // evidence on each source row before creating a stable binding.
    [...scopeResolution.scope.erasureSubjectKeys, nameReference],
  );
  const rows = collectSourceRows(db, scopeResolution.scope);
  strengthenErasureAliases(db, scopeResolution.scope, rows, erasures);
}

export type GdprDiscoveryRow = {
  source: GdprExportRecord["source"];
  sourceRowId: number;
  label: string | null;
  personalData: GdprPersonalData;
  retainUntil: string | null;
  erased: boolean;
};

export type GdprDiscoveryResult = {
  ok: boolean;
  subject: { cvr: string | null; name: string | null };
  rows: GdprDiscoveryRow[];
  byTable: Record<GdprExportRecord["source"], number>;
  errors: string[];
};

/**
 * Subject-discovery på tværs af tabeller (#353). Wrapper omkring den interne
 * `collectSourceRows` så CLI'ens \`gdpr discover\` og cockpit-views kan kalde
 * den uden at gå gennem export-pipelinen. Subject-data læses, men opslaget
 * skriver et actor-attribueret, append-only audit-event.
 */
export function findGdprSubject(
  db: Database,
  key: GdprSubjectKey,
  actor: ResolveActorInput = {},
): GdprDiscoveryResult {
  const subject = resolveSubject(key);
  if (!subject.cvr && !subject.name) {
    return {
      ok: false,
      subject,
      rows: [],
      byTable: emptyByTable(),
      errors: ["a GDPR subject must be identified by cvr or name"],
    };
  }
  const scopeResolution = resolveSubjectScope(db, subject);
  if (!scopeResolution.ok) {
    return {
      ok: false,
      subject,
      rows: [],
      byTable: emptyByTable(),
      errors: [scopeResolution.error],
    };
  }
  const erasures = loadErasures(
    db,
    scopeResolution.scope.erasureSubjectKeys,
  );
  const sourceRows = collectSourceRows(
    db,
    scopeResolution.scope,
  );
  strengthenErasureAliases(db, scopeResolution.scope, sourceRows, erasures);
  const rows: GdprDiscoveryRow[] = sourceRows.map((row) => {
    const redacted =
      erasures.get(`${row.source}:${row.sourceRowId}`) ?? new Set<string>();
    return {
      source: row.source,
      sourceRowId: row.sourceRowId,
      label: applyLabelRedaction(row.label, redacted),
      personalData: applyRedaction(row.personalData, redacted),
      retainUntil: row.retainUntil,
      erased: redacted.size > 0,
    };
  });
  const byTable = emptyByTable();
  for (const r of rows) byTable[r.source] += 1;
  // #355 — audit-log også discovery, så Datatilsynet kan se den fulde
  // GDPR-aktivitetshistorik (export + discover + erasure).
  const subjectRef = scopeResolution.scope.auditReference;
  insertAuditLog(db, {
    eventType: "gdpr_discover",
    entityType: "gdpr_subject",
    entityId: subjectRef,
    message: `GDPR discover ${subjectRef}: ${rows.length} row(s) across ${Object.values(byTable).filter((n) => n > 0).length} table(s)`,
    ...actor,
  });
  return { ok: true, subject, rows, byTable, errors: [] };
}

/**
 * Collects raw rows that mention the data subject across master data,
 * documents, bank text, hash-chained journal text and audit metadata.
 */
function collectSourceRows(db: Database, scope: ResolvedSubjectScope): RawSourceRow[] {
  const { subject } = scope;
  const rows: RawSourceRow[] = [];
  const linkedRetentions: string[] = [];
  const bookkeepingRows: RawSourceRow[] = [];
  const seenBookkeepingRows = new Set<string>();

  const addBookkeepingRow = (row: RawSourceRow): void => {
    const key = `${row.source}:${row.sourceRowId}`;
    if (seenBookkeepingRows.has(key)) return;
    seenBookkeepingRows.add(key);
    if (row.retainUntil) linkedRetentions.push(row.retainUntil);
    bookkeepingRows.push(row);
  };

  const documents = db
    .query(
      `SELECT id, document_no, sender_name, sender_address, sender_vat_cvr,
              recipient_name, recipient_address, recipient_vat_cvr,
              retain_until, COALESCE(invoice_date, substr(upload_datetime, 1, 10)) AS basis_date
         FROM documents
        WHERE ((? IS NULL OR sender_vat_cvr = ?) AND (? IS NULL OR sender_name = ?))
           OR ((? IS NULL OR recipient_vat_cvr = ?) AND (? IS NULL OR recipient_name = ?))
        ORDER BY id ASC`,
    )
    .all(
      subject.cvr,
      subject.cvr,
      subject.name,
      subject.name,
      subject.cvr,
      subject.cvr,
      subject.name,
      subject.name,
    ) as Array<{
    id: number;
    document_no: string | null;
    sender_name: string | null;
    sender_address: string | null;
    sender_vat_cvr: string | null;
    recipient_name: string | null;
    recipient_address: string | null;
    recipient_vat_cvr: string | null;
    retain_until: string | null;
    basis_date: string | null;
  }>;

  for (const document of documents) {
    const senderMatches =
      (!subject.cvr || document.sender_vat_cvr === subject.cvr) &&
      (!subject.name || document.sender_name === subject.name);
    const personalData: GdprPersonalData = senderMatches
      ? {
          name: document.sender_name,
          address: document.sender_address,
          email: null,
          vatOrCvr: document.sender_vat_cvr,
        }
      : {
          name: document.recipient_name,
          address: document.recipient_address,
          email: null,
          vatOrCvr: document.recipient_vat_cvr,
        };
    addBookkeepingRow({
      source: "documents",
      sourceRowId: document.id,
      label: document.document_no,
      personalData,
      retainUntil: effectiveRetainUntil(
        db,
        document.retain_until,
        document.basis_date,
      ),
      redactable: true,
    });
  }

  for (const term of scope.freeTextTerms) {
    const like = `%${term.replace(/[\\%_]/g, "\\$&")}%`;

    const bankRows = db
      .query(
        `SELECT id, text, reference, retain_until,
                COALESCE(booking_date, transaction_date) AS basis_date
           FROM bank_transactions
          WHERE text LIKE ? ESCAPE '\\'
          ORDER BY id ASC`,
      )
      .all(like) as Array<{
      id: number;
      text: string;
      reference: string | null;
      retain_until: string | null;
      basis_date: string | null;
    }>;
    for (const bank of bankRows) {
      addBookkeepingRow({
        source: "bank_transactions",
        sourceRowId: bank.id,
        label: bank.reference,
        personalData: { name: bank.text, address: null, email: null, vatOrCvr: null },
        retainUntil: effectiveRetainUntil(db, bank.retain_until, bank.basis_date),
        redactable: true,
      });
    }

    const journalEntries = db
      .query(
        `SELECT id, entry_no, text, transaction_date, retain_until
           FROM journal_entries
          WHERE text LIKE ? ESCAPE '\\'
          ORDER BY id ASC`,
      )
      .all(like) as Array<{
      id: number;
      entry_no: string;
      text: string;
      transaction_date: string | null;
      retain_until: string | null;
    }>;
    for (const entry of journalEntries) {
      addBookkeepingRow({
        source: "journal_entries",
        sourceRowId: entry.id,
        label: entry.entry_no,
        personalData: { name: entry.text, address: null, email: null, vatOrCvr: null },
        retainUntil: effectiveRetainUntil(db, entry.retain_until, entry.transaction_date),
        redactable: false,
      });
    }

    const journalLines = db
      .query(
        `SELECT jl.id AS id, jl.text AS text, je.entry_no AS entry_no,
                je.transaction_date AS transaction_date, je.retain_until AS retain_until
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.journal_entry_id
          WHERE jl.text LIKE ? ESCAPE '\\'
          ORDER BY jl.id ASC`,
      )
      .all(like) as Array<{
      id: number;
      text: string | null;
      entry_no: string;
      transaction_date: string | null;
      retain_until: string | null;
    }>;
    for (const line of journalLines) {
      addBookkeepingRow({
        source: "journal_lines",
        sourceRowId: line.id,
        label: line.entry_no,
        personalData: { name: line.text, address: null, email: null, vatOrCvr: null },
        retainUntil: effectiveRetainUntil(db, line.retain_until, line.transaction_date),
        redactable: false,
      });
    }

    const auditEvents = db
      .query(
        `SELECT id, event_type, entity_id, message
           FROM audit_log
          WHERE message LIKE ? ESCAPE '\\' OR entity_id = ?
          ORDER BY id ASC`,
      )
      .all(like, term) as Array<{
      id: number;
      event_type: string;
      entity_id: string | null;
      message: string;
    }>;
    for (const event of auditEvents) {
      addBookkeepingRow({
        source: "audit_log",
        sourceRowId: event.id,
        label: event.event_type,
        personalData: {
          name: event.message,
          address: null,
          email: null,
          vatOrCvr:
            subject.cvr && event.entity_id === subject.cvr ? subject.cvr : null,
        },
        retainUntil: null,
        redactable: true,
      });
    }
  }

  // New GDPR events intentionally use a pseudonymous subject reference rather
  // than raw name/CVR. Include those exact-identity rows in later DSARs and in
  // retention inheritance; the raw-term loop above also keeps legacy events.
  const auditReferencePlaceholders = scope.auditReferences
    .map(() => "?")
    .join(", ");
  const pseudonymousAuditEvents = db
    .query(
      `SELECT id, event_type, entity_id, message
         FROM audit_log
        WHERE entity_id IN (${auditReferencePlaceholders})
        ORDER BY id ASC`,
    )
    .all(...scope.auditReferences) as Array<{
    id: number;
    event_type: string;
    entity_id: string | null;
    message: string;
  }>;
  for (const event of pseudonymousAuditEvents) {
    const containsRawSubjectTerm = scope.freeTextTerms.some((term) =>
      event.message.includes(term),
    );
    addBookkeepingRow({
      source: "audit_log",
      sourceRowId: event.id,
      label: event.event_type,
      personalData: {
        name: event.message,
        address: null,
        email: null,
        vatOrCvr: null,
      },
      retainUntil: null,
      // These rows contain only the pseudonymous reference and operational
      // metadata. They belong in the DSAR/audit trail, but repeatedly
      // tombstoning erasure-decision events would create an endless cascade.
      redactable:
        !event.event_type.startsWith("gdpr_") || containsRawSubjectTerm,
    });
  }

  const masterDataRetainUntil =
    linkedRetentions.length > 0 ? linkedRetentions.slice().sort().at(-1)! : null;

  // Audit events that identify a subject are supporting evidence for the
  // same bookkeeping material. Keep their export overlay visible for as long
  // as any linked record is retained; once that deadline expires (or no
  // bookkeeping record exists), the immutable audit bytes may be hidden by a
  // GDPR tombstone just like the master-data view.
  for (const row of bookkeepingRows) {
    if (row.source === "audit_log") row.retainUntil = masterDataRetainUntil;
  }

  const customers = db
    .query(
      `SELECT id, name, address, email, vat_or_cvr
         FROM customers
        WHERE (? IS NULL OR vat_or_cvr = ?)
          AND (? IS NULL OR name = ?)
        ORDER BY id ASC`,
    )
    .all(subject.cvr, subject.cvr, subject.name, subject.name) as Array<{
    id: number;
    name: string;
    address: string | null;
    email: string | null;
    vat_or_cvr: string | null;
  }>;
  for (const customer of customers) {
    rows.push({
      source: "customers",
      sourceRowId: customer.id,
      label: customer.name,
      personalData: {
        name: customer.name,
        address: customer.address,
        email: customer.email,
        vatOrCvr: customer.vat_or_cvr,
      },
      retainUntil: masterDataRetainUntil,
      redactable: true,
    });
  }

  const vendors = db
    .query(
      `SELECT id, name, address, vat_or_cvr
         FROM vendors
        WHERE (? IS NULL OR vat_or_cvr = ?)
          AND (? IS NULL OR name = ?)
        ORDER BY id ASC`,
    )
    .all(subject.cvr, subject.cvr, subject.name, subject.name) as Array<{
    id: number;
    name: string;
    address: string | null;
    vat_or_cvr: string | null;
  }>;
  for (const vendor of vendors) {
    rows.push({
      source: "vendors",
      sourceRowId: vendor.id,
      label: vendor.name,
      personalData: {
        name: vendor.name,
        address: vendor.address,
        email: null,
        vatOrCvr: vendor.vat_or_cvr,
      },
      retainUntil: masterDataRetainUntil,
      redactable: true,
    });
  }

  rows.push(...bookkeepingRows);
  return rows;
}

const REDACTED_PLACEHOLDER = "[redigeret — GDPR]";

/**
 * Returns a copy of `personalData` with every field listed in `redacted`
 * replaced: text fields become a placeholder, structured fields become null.
 */
function applyRedaction(personalData: GdprPersonalData, redacted: Set<string>): GdprPersonalData {
  if (redacted.size === 0) return personalData;
  return {
    name: redacted.has("name") ? REDACTED_PLACEHOLDER : personalData.name,
    address: redacted.has("address") ? null : personalData.address,
    email: redacted.has("email") ? null : personalData.email,
    vatOrCvr: redacted.has("vatOrCvr") ? null : personalData.vatOrCvr,
  };
}

function applyLabelRedaction(
  label: string | null,
  redacted: Set<string>,
): string | null {
  return label !== null && redacted.has("name") ? REDACTED_PLACEHOLDER : label;
}

/**
 * Builds a complete data-subject access report: every customer, vendor,
 * document and bank transaction holding personal data about the subject,
 * each annotated with its bookkeeping retention verdict and whether a prior
 * erasure already redacted it.
 */
export function buildGdprSubjectExport(
  db: Database,
  key: GdprSubjectKey,
  actor: ResolveActorInput = {},
): GdprSubjectExport {
  const asOf = trim(key.asOf) ?? currentUtcIsoDate(db);
  const subject = resolveSubject(key);
  if (!subject.cvr && !subject.name) {
    return {
      ok: false,
      asOf,
      appliedRules: [EXPORT_RULE_ID],
      subject,
      records: [],
      errors: ["a GDPR subject must be identified by cvr or name"],
    };
  }
  if (!isValidIsoDate(asOf)) {
    return {
      ok: false,
      asOf,
      appliedRules: [EXPORT_RULE_ID],
      subject,
      records: [],
      errors: ["asOf must be a valid YYYY-MM-DD date"],
    };
  }
  const scopeResolution = resolveSubjectScope(db, subject);
  if (!scopeResolution.ok) {
    return {
      ok: false,
      asOf,
      appliedRules: [EXPORT_RULE_ID],
      subject,
      records: [],
      errors: [scopeResolution.error],
    };
  }

  const subjectRef = scopeResolution.scope.auditReference;
  const erasures = loadErasures(
    db,
    scopeResolution.scope.erasureSubjectKeys,
  );
  const sourceRows = collectSourceRows(db, scopeResolution.scope);
  strengthenErasureAliases(db, scopeResolution.scope, sourceRows, erasures);
  const records: GdprExportRecord[] = sourceRows.map((row) => {
    const redacted = erasures.get(`${row.source}:${row.sourceRowId}`) ?? new Set<string>();
    const underRetention = row.retainUntil !== null && row.retainUntil >= asOf;
    return {
      source: row.source,
      sourceRowId: row.sourceRowId,
      label: applyLabelRedaction(row.label, redacted),
      personalData: applyRedaction(row.personalData, redacted),
      retainUntil: row.retainUntil,
      underRetention,
      erased: redacted.size > 0,
      erasable:
        !underRetention &&
        redacted.size === 0 &&
        row.redactable,
    };
  });

  // #355 — audit-log hver indsigtssøgning så ejeren kan bevise overfor
  // Datatilsynet hvilke subject-data der er udleveret hvornår.
  insertAuditLog(db, {
    eventType: "gdpr_export",
    entityType: "gdpr_subject",
    entityId: subjectRef,
    message: `GDPR export ${subjectRef}: ${records.length} record(s) returned (as-of ${asOf})`,
    ...actor,
  });

  return {
    ok: true,
    asOf,
    appliedRules: [EXPORT_RULE_ID, RETENTION_RULE_ID],
    subject,
    records,
    errors: [],
  };
}

/**
 * The personal-data field names redactable per source. Hash-chained journal
 * text is not overlaid yet. Audit-log text can be hidden in later exports by
 * an append-only tombstone without mutating the original audit row.
 *
 * DESIGN NOTE (outstanding) — overlay redaction of ledger free-text after
 * retention expiry: once a journal_entries.text / journal_lines.text row
 * falls out of bookkeeping retention, GDPR data-
 * minimisation would call for redacting the personal data it still holds.
 * Doing so WITHOUT breaking the entry-hash chain requires a hash-chain-
 * preserving tombstone design: the original bytes must remain hash-verifiable
 * while the export layer overlays a redaction so the personal data no longer
 * resurfaces (analogous to the master-data overlay already implemented here,
 * but for hash-chained rows). That design is not implemented in this slice and
 * is deliberately left as a separate, explicit piece of work — the current
 * behaviour exports the ledger text and never mutates it.
 */
const REDACTABLE_FIELDS: Record<GdprExportRecord["source"], string[]> = {
  customers: ["name", "address", "email", "vatOrCvr"],
  vendors: ["name", "address", "vatOrCvr"],
  documents: ["name", "address", "vatOrCvr"],
  bank_transactions: ["name"],
  journal_entries: [],
  journal_lines: [],
  audit_log: ["name", "vatOrCvr"],
};

/**
 * Erases (redacts) personal data about the subject that is no longer under
 * bookkeeping retention, and refuses any record still legally required to be
 * kept. Each redaction is recorded as an append-only tombstone in
 * `gdpr_erasures`; no append-only master-data row and no ledger row is ever
 * modified, so the audit chain stays verifiable.
 */
export function eraseGdprSubject(
  db: Database,
  key: GdprErasureKey,
  actor: ResolveActorInput = {},
): GdprErasureResult {
  // Security boundary: the mutation always evaluates retention against the
  // trusted application clock. A caller-provided future `asOf` must never be
  // able to make still-retained records look erasable.
  const asOf = trustedTodayIsoDate();
  const subject = resolveSubject(key);
  if (!subject.cvr && !subject.name) {
    return {
      ok: false,
      asOf,
      appliedRules: [ERASURE_RULE_ID],
      subject,
      erasedCount: 0,
      refusedCount: 0,
      alreadyErasedCount: 0,
      erased: [],
      refused: [],
      errors: ["a GDPR subject must be identified by cvr or name"],
    };
  }
  const scopeResolution = resolveSubjectScope(db, subject);
  if (!scopeResolution.ok) {
    return {
      ok: false,
      asOf,
      appliedRules: [ERASURE_RULE_ID],
      subject,
      erasedCount: 0,
      refusedCount: 0,
      alreadyErasedCount: 0,
      erased: [],
      refused: [],
      errors: [scopeResolution.error],
    };
  }

  const subjectRef = scopeResolution.scope.auditReference;
  const erased: GdprErasureRecord[] = [];
  const refused: GdprErasureRefusal[] = [];
  let alreadyErasedCount = 0;

  db.transaction(() => {
    const existing = loadErasures(
      db,
      scopeResolution.scope.erasureSubjectKeys,
    );
    const insert = db.prepare(
      `INSERT OR IGNORE INTO gdpr_erasures
         (subject_key, source, source_row_id, redacted_fields, rule_id, reason, retained_until_at_erasure)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const sourceRows = collectSourceRows(db, scopeResolution.scope);
    let decisionCount = 0;
    const logDecision = (
      row: RawSourceRow | null,
      outcome:
        | "erased"
        | "refused_retention"
        | "refused_ledger_integrity"
        | "already_erased"
        | "no_matching_records",
    ): void => {
      decisionCount += 1;
      insertAuditLog(db, {
        eventType: "gdpr_erasure_decision",
        entityType: "gdpr_subject",
        entityId: subjectRef,
        message: row
          ? `GDPR erasure decision ${subjectRef}: source=${row.source} row=${row.sourceRowId} outcome=${outcome}`
          : `GDPR erasure decision ${subjectRef}: outcome=${outcome}`,
        ...actor,
      });
    };

    for (const row of sourceRows) {
      if (row.source === "audit_log" && !row.redactable) continue;

      const tombstoneKey = `${row.source}:${row.sourceRowId}`;
      const existingFields = existing.get(tombstoneKey);
      if (existingFields) {
        // Strengthen legacy/name-only erasures with every currently known
        // pseudonymous alias. This is append-only and keeps future identity
        // enrichment (for example a later CVR) from resurfacing the row.
        for (const aliasRef of scopeResolution.scope.tombstoneReferences) {
          insert.run(
            aliasRef,
            row.source,
            row.sourceRowId,
            JSON.stringify([...existingFields]),
            ERASURE_RULE_ID,
            "pseudonymous identity alias linked to a prior GDPR erasure",
            row.retainUntil,
          );
        }
        alreadyErasedCount += 1;
        logDecision(row, "already_erased");
        continue;
      }

      // A future retention deadline overrides the erasure request: the law
      // requires the record to be kept, so we clearly refuse it.
      if (row.retainUntil !== null && row.retainUntil >= asOf) {
        refused.push({
          source: row.source,
          sourceRowId: row.sourceRowId,
          label: row.label,
          retainUntil: row.retainUntil,
          reason:
            `bookkeeping retention requires this record until ${row.retainUntil}; ` +
            `erasure refused (rule ${RETENTION_RULE_ID})`,
        });
        logDecision(row, "refused_retention");
        continue;
      }

      // Journal bytes are part of the entry hash chain and currently have no
      // product-wide overlay. Report that limitation as an explicit refusal;
      // silently skipping the row would falsely claim there were no matches
      // and would make Cockpit advertise an action the core cannot perform.
      if (LEDGER_TEXT_SOURCES.has(row.source)) {
        refused.push({
          source: row.source,
          sourceRowId: row.sourceRowId,
          label: row.label,
          retainUntil: row.retainUntil,
          reason:
            "append-only journal integrity prevents erasure of this row; " +
            "a hash-chain-preserving product-wide redaction overlay is required",
        });
        logDecision(row, "refused_ledger_integrity");
        continue;
      }

      const fields = REDACTABLE_FIELDS[row.source];
      for (const aliasRef of scopeResolution.scope.tombstoneReferences) {
        insert.run(
          aliasRef,
          row.source,
          row.sourceRowId,
          JSON.stringify(fields),
          ERASURE_RULE_ID,
          `personal data redacted: no longer under bookkeeping retention as of ${asOf}`,
          row.retainUntil,
        );
      }
      erased.push({
        source: row.source,
        sourceRowId: row.sourceRowId,
        label: row.label,
        redactedFields: fields,
      });
      logDecision(row, "erased");
    }

    if (decisionCount === 0) logDecision(null, "no_matching_records");
  }).immediate();

  return {
    ok: true,
    asOf,
    appliedRules: [ERASURE_RULE_ID, RETENTION_RULE_ID],
    subject,
    erasedCount: erased.length,
    refusedCount: refused.length,
    alreadyErasedCount,
    erased,
    refused,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// #355 — Signed GDPR audit-log export.
//
// Genbruger den eksisterende audit_log-tabel (kerne-bogføringens append-only
// log) og filtrerer til alle `gdpr_*`-events. Pakken kan signeres med samme
// Ed25519-nøgle som backup-systemet bruger, så Datatilsynet eller subject'et
// selv kan verificere pakken uden at Rentemester er installeret.

export type GdprAuditEvent = {
  id: number;
  occurredAt: string;
  eventType: string;
  subjectKey: string | null;
  actor: string;
  message: string;
};

export type GdprAuditExport = {
  ok: boolean;
  format: "rentemester.gdpr-audit.v1";
  ruleId: "GDPR-AUDIT-LOG";
  asOf: string;
  since: string | null;
  until: string | null;
  events: GdprAuditEvent[];
  /** Exact UTF-8 bytes covered by fingerprint and signature. */
  canonicalPayload: string;
  fingerprint: string;
  signature?: {
    algorithm: "ed25519";
    encoding: "utf8";
    signedField: "canonicalPayload";
    publicKeyHint: string;
    base64: string;
  };
  errors: string[];
};

// Bevidst uden DK-prefix og -NNN-suffix — matcher det format de andre GDPR-
// rules bruger (EXPORT_RULE_ID, ERASURE_RULE_ID), så det IKKE optfanges af
// rules-metadata-consistency-testen som forventer DK-rules at være i YAML.
const GDPR_AUDIT_RULE_ID = "GDPR-AUDIT-LOG";
const GDPR_AUDIT_FORMAT = "rentemester.gdpr-audit.v1";

function makeGdprAuditExport(
  asOf: string,
  since: string | null,
  until: string | null,
  events: GdprAuditEvent[],
  errors: string[] = [],
): GdprAuditExport {
  const canonicalPayload = JSON.stringify({
    format: GDPR_AUDIT_FORMAT,
    ruleId: GDPR_AUDIT_RULE_ID,
    asOf,
    since,
    until,
    events,
  });
  return {
    ok: errors.length === 0,
    format: GDPR_AUDIT_FORMAT,
    ruleId: GDPR_AUDIT_RULE_ID,
    asOf,
    since,
    until,
    events,
    canonicalPayload,
    fingerprint: `sha256:${createHash("sha256").update(canonicalPayload, "utf8").digest("hex")}`,
    errors,
  };
}

/**
 * Bygger en signeret GDPR-audit-log-eksport. Kun rækker hvor
 * `event_type LIKE 'gdpr_%'` returneres. `canonicalPayload` er de eksakte
 * UTF-8-bytes som både fingerprint og en valgfri signatur dækker.
 *
 * `signWithEd25519=true` aktiverer asymmetrisk signering med den
 * eksisterende backup-nøgle (samme nøgle, samme tillidskæde).
 */
export function buildGdprAuditExport(
  db: Database,
  options: {
    since?: string | null;
    until?: string | null;
    asOf?: string | null;
    signWithEd25519?: boolean;
    companyRoot?: string;
  } = {},
): GdprAuditExport {
  const asOf = trim(options.asOf ?? null) ?? currentUtcIsoDate(db);
  const since = trim(options.since ?? null);
  const until = trim(options.until ?? null);

  const dateErrors: string[] = [];
  if (!isValidIsoDate(asOf)) dateErrors.push("asOf must be a valid YYYY-MM-DD date");
  if (since && !isValidIsoDate(since)) {
    dateErrors.push("since must be a valid YYYY-MM-DD date");
  }
  if (until && !isValidIsoDate(until)) {
    dateErrors.push("until must be a valid YYYY-MM-DD date");
  }
  if (
    since &&
    until &&
    isValidIsoDate(since) &&
    isValidIsoDate(until) &&
    since > until
  ) {
    dateErrors.push("since must be on or before until");
  }
  if (dateErrors.length > 0) {
    return makeGdprAuditExport(asOf, since, until, [], dateErrors);
  }

  const filters: string[] = ["event_type LIKE 'gdpr_%'"];
  const params: SQLQueryBindings[] = [];
  if (since) {
    filters.push("created_at >= ?");
    params.push(since);
  }
  if (until) {
    filters.push("created_at < ?");
    params.push(addDays(until, 1));
  }

  const rows = db
    .query(
      `SELECT id, created_at, event_type, entity_id, actor, message
         FROM audit_log
        WHERE ${filters.join(" AND ")}
        ORDER BY id ASC`,
    )
    .all(...params) as Array<{
    id: number;
    created_at: string;
    event_type: string;
    entity_id: string | null;
    actor: string;
    message: string;
  }>;

  const events: GdprAuditEvent[] = rows.map((r) => ({
    id: r.id,
    occurredAt: r.created_at,
    eventType: r.event_type,
    subjectKey: r.entity_id,
    actor: r.actor,
    message: r.message,
  }));

  const result = makeGdprAuditExport(asOf, since, until, events);

  if (options.signWithEd25519) {
    if (!options.companyRoot) {
      return {
        ...result,
        ok: false,
        errors: ["company root is required for GDPR audit signing"],
      };
    }
    const privPath = backupEd25519PrivateKeyPath(options.companyRoot);
    const pubPath = backupEd25519PublicKeyPath(options.companyRoot);
    const hasPrivate = existsSync(privPath);
    const hasPublic = existsSync(pubPath);
    if (!hasPrivate && !hasPublic) {
      return {
        ...result,
        ok: false,
        errors: [
          "no ed25519 backup signing key is configured; run system backup with --sign-with-ed25519 once",
        ],
      };
    }
    if (!hasPrivate || !hasPublic) {
      return {
        ...result,
        ok: false,
        errors: ["ed25519 backup signing key state is incomplete"],
      };
    }
    try {
      const privateKey = createPrivateKey(readFileSync(privPath, "utf8"));
      const publicKey = createPublicKey(readFileSync(pubPath, "utf8"));
      const payloadBytes = Buffer.from(result.canonicalPayload, "utf8");
      const signatureBytes = cryptoSign(null, payloadBytes, privateKey);
      if (!cryptoVerify(null, payloadBytes, publicKey, signatureBytes)) {
        return {
          ...result,
          ok: false,
          errors: ["ed25519 backup signing keypair does not match"],
        };
      }
      const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
      result.signature = {
        algorithm: "ed25519",
        encoding: "utf8",
        signedField: "canonicalPayload",
        publicKeyHint: `sha256:${createHash("sha256").update(publicKeyDer).digest("hex")}`,
        base64: signatureBytes.toString("base64"),
      };
    } catch {
      return {
        ...result,
        ok: false,
        errors: ["ed25519 backup signing key could not be read or validated"],
      };
    }
  }

  return result;
}
