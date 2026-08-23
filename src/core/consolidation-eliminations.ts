/**
 * Append-only, workspace-only balance eliminations. Every amount is derived
 * from a matched intercompany reconciliation snapshot; no caller can enter an
 * arbitrary journal or mutate a legal-entity ledger.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { ResolveActorInput } from "./actor";
import { resolveActor } from "./actor";
import { buildIntercompanyReconciliation, readIntercompanyMappingState } from "./intercompany-reconciliation";
import { parseGroupAsOf } from "./group-manifest";
import { toOre } from "./money";
import { listWorkspaceCompanies } from "./workspace";
import { insertWorkspaceAudit } from "./workspace-control";

const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export type BalanceEliminationPayload = {
  version: 1;
  id: string;
  kind: "intercompany-balance";
  groupId: string;
  mappingId: string;
  mappingHash: string;
  asOf: string;
  currency: string;
  amountOre: string;
  left: { companySlug: string; accountNos: string[]; selectionHash: string; ledgerHeadHash: string | null; entryCount: number; creditOre: string };
  right: { companySlug: string; accountNos: string[]; selectionHash: string; ledgerHeadHash: string | null; entryCount: number; debitOre: string };
  evidenceRefs: string[];
};

type EliminationEvent = {
  id: number;
  elimination_id: string;
  event_type: "proposed" | "approved" | "rejected" | "applied" | "reversed";
  payload_hash: string;
  canonical_payload: string;
  previous_hash: string | null;
  event_hash: string;
  actor: string;
  created_at: string;
};

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim().normalize("NFC");
}
function identifier(value: unknown, label: string): string {
  const result = string(value, label);
  if (!IDENTIFIER.test(result)) throw new Error(`${label} must be a lowercase stable identifier`);
  return result;
}
function evidenceRefs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new Error("elimination evidenceRefs must contain 1 through 32 values");
  const refs = value.map((entry, index) => {
    const result = string(entry, `evidenceRefs[${index}]`);
    if (result.length > 256) throw new Error(`evidenceRefs[${index}] is too long`);
    return result;
  }).sort();
  if (new Set(refs).size !== refs.length) throw new Error("elimination evidenceRefs must be unique");
  return refs;
}
function canonical(payload: BalanceEliminationPayload): string { return JSON.stringify(payload); }
function eventHash(previous: string | null, event: Omit<EliminationEvent, "event_hash">): string {
  return sha(JSON.stringify({ previousHash: previous, id: event.id, eliminationId: event.elimination_id, eventType: event.event_type, payloadHash: event.payload_hash, canonicalPayload: event.canonical_payload, actor: event.actor, createdAt: event.created_at }));
}
function readEvents(db: Database): EliminationEvent[] {
  const events = db.query("SELECT id,elimination_id,event_type,payload_hash,canonical_payload,previous_hash,event_hash,actor,created_at FROM rm_consolidation_elimination_events ORDER BY id").all() as EliminationEvent[];
  let previous: string | null = null;
  for (const event of events) {
    if (event.previous_hash !== previous || event.event_hash !== eventHash(previous, event)) throw new Error("consolidation elimination event hash-chain is invalid");
    previous = event.event_hash;
  }
  return events;
}
function current(events: readonly EliminationEvent[]): Map<string, EliminationEvent> {
  const result = new Map<string, EliminationEvent>();
  for (const event of events) result.set(event.elimination_id, event);
  return result;
}
function parsePayload(event: EliminationEvent): BalanceEliminationPayload {
  const payload = JSON.parse(event.canonical_payload) as BalanceEliminationPayload;
  if (payload.version !== 1 || payload.kind !== "intercompany-balance" || payload.id !== event.elimination_id || !IDENTIFIER.test(payload.id) || !SHA256.test(payload.mappingHash) || sha(event.canonical_payload) !== event.payload_hash) throw new Error("consolidation elimination evidence is invalid");
  parseGroupAsOf(payload.asOf);
  if (!/^\d+$/.test(payload.amountOre) || payload.amountOre === "0") throw new Error("consolidation elimination amount evidence is invalid");
  for (const side of [payload.left, payload.right]) {
    if (!SHA256.test(side.selectionHash) || (side.ledgerHeadHash !== null && !SHA256.test(side.ledgerHeadHash)) || !Number.isInteger(side.entryCount) || side.entryCount < 0 || side.accountNos.length === 0) throw new Error("consolidation elimination source evidence is invalid");
  }
  return payload;
}

export function readBalanceEliminationState(db: Database, eliminationId: string): { payload: BalanceEliminationPayload; payloadHash: string; status: EliminationEvent["event_type"]; actor: string } | null {
  const event = current(readEvents(db)).get(eliminationId) ?? null;
  return event ? { payload: parsePayload(event), payloadHash: event.payload_hash, status: event.event_type, actor: event.actor } : null;
}
function append(db: Database, type: EliminationEvent["event_type"], payload: BalanceEliminationPayload, audit: ResolveActorInput): EliminationEvent {
  const events = readEvents(db);
  const previous = events.at(-1)?.event_hash ?? null;
  const body = canonical(payload);
  if (Buffer.byteLength(body, "utf8") > 262144) throw new Error("consolidation elimination evidence exceeds 262144 bytes");
  const actor = resolveActor(audit).auditActor;
  const event = { id: (events.at(-1)?.id ?? 0) + 1, elimination_id: payload.id, event_type: type, payload_hash: sha(body), canonical_payload: body, previous_hash: previous, actor, created_at: new Date().toISOString() };
  const complete: EliminationEvent = { ...event, event_hash: eventHash(previous, event) };
  db.query("INSERT INTO rm_consolidation_elimination_events (id,elimination_id,event_type,payload_hash,canonical_payload,previous_hash,event_hash,actor,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(complete.id, complete.elimination_id, complete.event_type, complete.payload_hash, complete.canonical_payload, complete.previous_hash, complete.event_hash, complete.actor, complete.created_at);
  insertWorkspaceAudit(db, { ...audit, eventType: `consolidation_elimination_${type}`, entityType: "consolidation_elimination", entityId: payload.id });
  return complete;
}

function allActiveCompanies(workspaceRoot: string): Set<string> {
  return new Set(listWorkspaceCompanies(workspaceRoot).filter((company) => !company.archived).map((company) => company.slug));
}

function derivePayload(db: Database, workspaceRoot: string, input: { id: string; mappingId: string; asOf: string; evidenceRefs: unknown }): BalanceEliminationPayload {
  const id = identifier(input.id, "elimination.id");
  const mappingId = identifier(input.mappingId, "elimination.mappingId");
  const asOf = parseGroupAsOf(input.asOf);
  const mapping = readIntercompanyMappingState(db, workspaceRoot, mappingId);
  if (!mapping || mapping.status !== "approved") throw new Error("approved intercompany mapping was not found");
  const row = buildIntercompanyReconciliation(db, workspaceRoot, allActiveCompanies(workspaceRoot), asOf).rows.find((candidate) => candidate.mappingId === mappingId);
  if (!row || row.status !== "matched") throw new Error("balance elimination requires an exact matched reconciliation snapshot");
  if (!row.left || !row.right || !row.mappingHash || row.left.currency !== row.right.currency || row.left.balance <= 0 || toOre(row.left.balance) !== toOre(row.right.balance)) throw new Error("matched reconciliation evidence is not eligible for balance elimination");
  const amountOre = toOre(row.left.balance).toString();
  return {
    version: 1, id, kind: "intercompany-balance", groupId: mapping.mapping.groupId,
    mappingId, mappingHash: row.mappingHash, asOf, currency: row.left.currency, amountOre,
    left: { companySlug: row.left.companySlug, accountNos: row.left.accountNos, selectionHash: row.left.sourceSnapshot.selectionHash, ledgerHeadHash: row.left.sourceSnapshot.ledgerHeadHash, entryCount: row.left.sourceSnapshot.entryCount, creditOre: amountOre },
    right: { companySlug: row.right.companySlug, accountNos: row.right.accountNos, selectionHash: row.right.sourceSnapshot.selectionHash, ledgerHeadHash: row.right.sourceSnapshot.ledgerHeadHash, entryCount: row.right.sourceSnapshot.entryCount, debitOre: amountOre },
    evidenceRefs: evidenceRefs(input.evidenceRefs),
  };
}

function assertStillCurrent(db: Database, workspaceRoot: string, payload: BalanceEliminationPayload): void {
  const fresh = derivePayload(db, workspaceRoot, { id: payload.id, mappingId: payload.mappingId, asOf: payload.asOf, evidenceRefs: payload.evidenceRefs });
  if (canonical(fresh) !== canonical(payload)) throw new Error("consolidation elimination source snapshot changed; create a new proposal");
}

export function proposeBalanceElimination(db: Database, workspaceRoot: string, input: { id: string; mappingId: string; asOf: string; evidenceRefs: unknown }, audit: ResolveActorInput): { eliminationId: string; payloadHash: string; status: "proposed" } {
  return db.transaction(() => {
    const payload = derivePayload(db, workspaceRoot, input);
    const state = current(readEvents(db)).get(payload.id);
    if (state && state.event_type !== "rejected" && state.event_type !== "reversed") throw new Error("elimination id already has an active lifecycle");
    const event = append(db, "proposed", payload, audit);
    return { eliminationId: payload.id, payloadHash: event.payload_hash, status: "proposed" as const };
  }).immediate();
}

export function approveBalanceElimination(db: Database, workspaceRoot: string, eliminationId: string, payloadHash: string, audit: ResolveActorInput): { eliminationId: string; payloadHash: string; status: "approved" } {
  return db.transaction(() => {
    const proposal = current(readEvents(db)).get(eliminationId);
    if (!proposal || proposal.event_type !== "proposed" || proposal.payload_hash !== payloadHash) throw new Error("exact pending elimination proposal was not found");
    if (resolveActor(audit).auditActor === proposal.actor) throw new Error("elimination approval requires a distinct reviewer");
    const payload = parsePayload(proposal);
    assertStillCurrent(db, workspaceRoot, payload);
    append(db, "approved", payload, audit);
    return { eliminationId, payloadHash, status: "approved" as const };
  }).immediate();
}

export function rejectBalanceElimination(db: Database, eliminationId: string, payloadHash: string, audit: ResolveActorInput): { eliminationId: string; status: "rejected" } {
  return db.transaction(() => {
    const proposal = current(readEvents(db)).get(eliminationId);
    if (!proposal || proposal.event_type !== "proposed" || proposal.payload_hash !== payloadHash) throw new Error("exact pending elimination proposal was not found");
    append(db, "rejected", parsePayload(proposal), audit);
    return { eliminationId, status: "rejected" as const };
  }).immediate();
}

export function applyBalanceElimination(db: Database, workspaceRoot: string, eliminationId: string, payloadHash: string, audit: ResolveActorInput): { eliminationId: string; payloadHash: string; status: "applied" } {
  return db.transaction(() => {
    const events = readEvents(db);
    const approved = current(events).get(eliminationId);
    if (!approved || approved.event_type !== "approved" || approved.payload_hash !== payloadHash) throw new Error("exact approved elimination was not found");
    const proposal = events.find((event) => event.elimination_id === eliminationId && event.event_type === "proposed" && event.payload_hash === payloadHash);
    if (!proposal || resolveActor(audit).auditActor === proposal.actor) throw new Error("elimination apply requires an actor distinct from the proposer");
    const payload = parsePayload(approved);
    assertStillCurrent(db, workspaceRoot, payload);
    append(db, "applied", payload, audit);
    return { eliminationId, payloadHash, status: "applied" as const };
  }).immediate();
}

export function reverseBalanceElimination(db: Database, eliminationId: string, payloadHash: string, audit: ResolveActorInput): { eliminationId: string; status: "reversed" } {
  return db.transaction(() => {
    const applied = current(readEvents(db)).get(eliminationId);
    if (!applied || applied.event_type !== "applied" || applied.payload_hash !== payloadHash) throw new Error("exact applied elimination was not found");
    append(db, "reversed", parsePayload(applied), audit);
    return { eliminationId, status: "reversed" as const };
  }).immediate();
}

export function readAppliedBalanceEliminations(db: Database, asOfInput: string): Array<{ eliminationId: string; payloadHash: string; eventHash: string; payload: BalanceEliminationPayload }> {
  const asOf = parseGroupAsOf(asOfInput);
  return [...current(readEvents(db)).values()].filter((event) => event.event_type === "applied").map((event) => ({ eliminationId: event.elimination_id, payloadHash: event.payload_hash, eventHash: event.event_hash, payload: parsePayload(event) })).filter((row) => row.payload.asOf === asOf);
}

export function buildEliminationOverview(db: Database, visibleCompanySlugs: ReadonlySet<string>, asOfInput: string): { scope: "consolidation-eliminations"; asOf: string; rows: Array<{ status: "applied" | "blocked"; eliminationId?: string; payloadHash?: string; eventHash?: string; payload?: BalanceEliminationPayload; blockers: string[] }> } {
  const asOf = parseGroupAsOf(asOfInput);
  const rows = readAppliedBalanceEliminations(db, asOf).map((row) => {
    if (!visibleCompanySlugs.has(row.payload.left.companySlug) || !visibleCompanySlugs.has(row.payload.right.companySlug)) return { status: "blocked" as const, blockers: ["both elimination companies must be visible"] };
    return { status: "applied" as const, ...row, blockers: [] };
  });
  return { scope: "consolidation-eliminations", asOf, rows };
}
