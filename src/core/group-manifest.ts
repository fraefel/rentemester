/**
 * Read-only group structure. A group never owns a ledger: every legal entity
 * remains a separately immutable company ledger.  This slice records only
 * effective-dated structure. Reconciliation, eliminations and consolidation
 * live in separate audited modules and never change legal-entity ledgers.
 */
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { companyRootForSlug, listWorkspaceCompanies, isValidSlug } from "./workspace";
import { companyPaths } from "./paths";
import { insertWorkspaceAudit } from "./workspace-control";
import { resolveActor, type ResolveActorInput } from "./actor";

export const GROUP_MANIFEST_VERSION = 1 as const;
export const GROUP_CONSOLIDATION_BLOCKERS = [
  "structure overview deliberately contains no financial consolidation",
  "use an approved reporting profile and the consolidated-report contract for figures",
] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/;

export type EffectiveInterval = { validFrom: string; validToExclusive?: string };
export type GroupMembership = EffectiveInterval & { id: string; companySlug: string };
export type GroupOwnership = EffectiveInterval & {
  id: string;
  parentCompanySlug: string;
  childCompanySlug: string;
  basisPoints: number;
  /** Immutable external evidence identifiers; no accounting semantics here. */
  evidenceRefs: string[];
};
export type GroupDefinition = {
  id: string;
  name: string;
  memberships: GroupMembership[];
  ownership: GroupOwnership[];
};
export type GroupManifest = { version: typeof GROUP_MANIFEST_VERSION; groups: GroupDefinition[] };

type GroupManifestEvent = { id: number; manifest_hash: string; previous_hash: string | null; canonical_manifest: string; actor: string; created_at: string };
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_GROUPS = 128;
const MAX_ROWS_PER_GROUP = 1024;
const FORBIDDEN_TEXT = /[\p{Cc}\p{Cf}]/u;

/** Locale-independent ordering is part of the portable hash contract. */
function compareCanonical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim().normalize("NFC");
}
function safeName(value: unknown, label: string): string {
  const result = string(value, label);
  if (result.length > 160 || FORBIDDEN_TEXT.test(result)) throw new Error(`${label} must be a safe name of at most 160 characters`);
  return result;
}
function identifier(value: unknown, label: string): string {
  const result = string(value, label);
  if (!IDENTIFIER.test(result)) throw new Error(`${label} must be a lowercase stable identifier`);
  return result;
}
function date(value: unknown, label: string): string {
  const result = string(value, label);
  if (!DATE.test(result)) throw new Error(`${label} must be an ISO date`);
  const [year, month, day] = result.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month! - 1 || parsed.getUTCDate() !== day) {
    throw new Error(`${label} must be a real ISO date`);
  }
  return result;
}
/** Shared route/CLI boundary parser. It has no wall-clock fallback. */
export function parseGroupAsOf(value: unknown): string {
  return date(value, "asOf");
}
function interval(value: Record<string, unknown>, label: string): EffectiveInterval {
  const validFrom = date(value.validFrom, `${label}.validFrom`);
  const validToExclusive = value.validToExclusive == null ? undefined : date(value.validToExclusive, `${label}.validToExclusive`);
  if (validToExclusive && validToExclusive <= validFrom) throw new Error(`${label} must be a non-empty half-open interval`);
  return { validFrom, ...(validToExclusive ? { validToExclusive } : {}) };
}
function overlaps(a: EffectiveInterval, b: EffectiveInterval): boolean {
  return (a.validToExclusive == null || b.validFrom < a.validToExclusive) &&
    (b.validToExclusive == null || a.validFrom < b.validToExclusive);
}
function covers(container: EffectiveInterval, target: EffectiveInterval): boolean {
  return container.validFrom <= target.validFrom &&
    (container.validToExclusive == null ||
      (target.validToExclusive != null && container.validToExclusive >= target.validToExclusive));
}
function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}
function evidenceRefs(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new Error(`${label} must contain 1 through 32 evidence references`);
  const refs = value.map((raw, index) => {
    const ref = string(raw, `${label}[${index}]`);
    if (ref.length > 256 || FORBIDDEN_TEXT.test(ref)) throw new Error(`${label}[${index}] is invalid`);
    return ref;
  });
  unique(refs, `${label}`);
  return [...refs].sort(compareCanonical);
}

/** Parse and fully validate the portable group-structure manifest. */
export function parseGroupManifest(input: unknown, registeredSlugs: readonly string[]): GroupManifest {
  const root = record(input, "group manifest");
  if (root.version !== GROUP_MANIFEST_VERSION) throw new Error(`group manifest version must be ${GROUP_MANIFEST_VERSION}`);
  if (!Array.isArray(root.groups) || root.groups.length === 0 || root.groups.length > MAX_GROUPS) throw new Error(`group manifest must contain 1 through ${MAX_GROUPS} groups`);
  const registered = new Set(registeredSlugs);
  const groups = root.groups.map((raw, index): GroupDefinition => {
    const group = record(raw, `groups[${index}]`);
    const id = identifier(group.id, `groups[${index}].id`);
    const name = safeName(group.name, `groups[${index}].name`);
    if (!Array.isArray(group.memberships) || group.memberships.length === 0 || group.memberships.length > MAX_ROWS_PER_GROUP) throw new Error(`groups[${index}].memberships must contain 1 through ${MAX_ROWS_PER_GROUP} rows`);
    const memberships = group.memberships.map((entry, membershipIndex): GroupMembership => {
      const row = record(entry, `groups[${index}].memberships[${membershipIndex}]`);
      const companySlug = string(row.companySlug, `groups[${index}].memberships[${membershipIndex}].companySlug`);
      if (!isValidSlug(companySlug) || !registered.has(companySlug)) throw new Error("group membership references an unregistered company");
      return { id: identifier(row.id, `groups[${index}].memberships[${membershipIndex}].id`), companySlug, ...interval(row, `groups[${index}].memberships[${membershipIndex}]`) };
    });
    unique(memberships.map((membership) => membership.id), `groups[${index}].membership ids`);
    for (let left = 0; left < memberships.length; left += 1) for (let right = left + 1; right < memberships.length; right += 1) {
      if (memberships[left]!.companySlug === memberships[right]!.companySlug && overlaps(memberships[left]!, memberships[right]!)) throw new Error("a company may have only one active membership in a group at a time");
    }
    if (!Array.isArray(group.ownership) || group.ownership.length > MAX_ROWS_PER_GROUP) throw new Error(`groups[${index}].ownership must contain at most ${MAX_ROWS_PER_GROUP} rows`);
    const ownership = group.ownership.map((entry, ownershipIndex): GroupOwnership => {
      const row = record(entry, `groups[${index}].ownership[${ownershipIndex}]`);
      const parentCompanySlug = string(row.parentCompanySlug, `groups[${index}].ownership[${ownershipIndex}].parentCompanySlug`);
      const childCompanySlug = string(row.childCompanySlug, `groups[${index}].ownership[${ownershipIndex}].childCompanySlug`);
      if (!isValidSlug(parentCompanySlug) || !isValidSlug(childCompanySlug) || !registered.has(parentCompanySlug) || !registered.has(childCompanySlug)) throw new Error("group ownership references an unregistered company");
      if (parentCompanySlug === childCompanySlug) throw new Error("group ownership cannot be self-referential");
      if (!Number.isInteger(row.basisPoints) || (row.basisPoints as number) < 1 || (row.basisPoints as number) > 10000) throw new Error("group ownership basisPoints must be an integer from 1 through 10000");
      const effective = interval(row, `groups[${index}].ownership[${ownershipIndex}]`);
      const parentCovered = memberships.some((membership) => membership.companySlug === parentCompanySlug && covers(membership, effective));
      const childCovered = memberships.some((membership) => membership.companySlug === childCompanySlug && covers(membership, effective));
      if (!parentCovered || !childCovered) throw new Error("group ownership must be fully covered by active memberships");
      return { id: identifier(row.id, `groups[${index}].ownership[${ownershipIndex}].id`), parentCompanySlug, childCompanySlug, basisPoints: row.basisPoints as number, evidenceRefs: evidenceRefs(row.evidenceRefs, `groups[${index}].ownership[${ownershipIndex}].evidenceRefs`), ...effective };
    });
    unique(ownership.map((edge) => edge.id), `groups[${index}].ownership ids`);
    assertOwnershipIntervalsAndTotals(ownership);
    assertNoEffectiveCycles(ownership);
    return { id, name, memberships, ownership };
  });
  unique(groups.map((group) => group.id), "group ids");
  const manifest = { version: GROUP_MANIFEST_VERSION, groups };
  if (Buffer.byteLength(canonicalizeGroupManifestUnchecked(manifest), "utf8") > MAX_MANIFEST_BYTES) throw new Error(`group manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  return manifest;
}

/** Ownership evidence cannot overlap for one direct parent/child relation, and direct ownership may never exceed 100%. */
function assertOwnershipIntervalsAndTotals(edges: readonly GroupOwnership[]): void {
  for (let left = 0; left < edges.length; left += 1) for (let right = left + 1; right < edges.length; right += 1) {
    if (edges[left]!.parentCompanySlug === edges[right]!.parentCompanySlug &&
      edges[left]!.childCompanySlug === edges[right]!.childCompanySlug && overlaps(edges[left]!, edges[right]!)) {
      throw new Error("direct ownership rows for the same parent and child must not overlap");
    }
  }
  const boundaries = [...new Set(edges.flatMap((edge) => [edge.validFrom, edge.validToExclusive].filter((value): value is string => value != null)))].sort(compareCanonical);
  for (const boundary of boundaries) {
    const totalByChild = new Map<string, number>();
    for (const edge of edges.filter((candidate) => isActiveAt(candidate, boundary))) {
      totalByChild.set(edge.childCompanySlug, (totalByChild.get(edge.childCompanySlug) ?? 0) + edge.basisPoints);
    }
    if ([...totalByChild.values()].some((total) => total > 10000)) throw new Error("combined active direct ownership for a child must not exceed 10000 basis points");
  }
}

/** A directed ownership graph must remain acyclic in every effective slice. */
function assertNoEffectiveCycles(edges: readonly GroupOwnership[]): void {
  const boundaries = [...new Set(edges.flatMap((edge) => [edge.validFrom, edge.validToExclusive].filter((value): value is string => value != null)))].sort(compareCanonical);
  for (const boundary of boundaries) {
    const active = edges.filter((edge) => isActiveAt(edge, boundary));
    const next = new Map<string, string[]>();
    for (const edge of active) next.set(edge.parentCompanySlug, [...(next.get(edge.parentCompanySlug) ?? []), edge.childCompanySlug]);
    const visiting = new Set<string>(); const visited = new Set<string>();
    const visit = (node: string): void => {
      if (visiting.has(node)) throw new Error("group ownership contains an effective cycle");
      if (visited.has(node)) return;
      visiting.add(node); for (const child of next.get(node) ?? []) visit(child); visiting.delete(node); visited.add(node);
    };
    for (const node of next.keys()) visit(node);
  }
}

function isActiveAt(interval: EffectiveInterval, asOf: string): boolean {
  return interval.validFrom <= asOf && (interval.validToExclusive == null || asOf < interval.validToExclusive);
}

/** Stable serialization makes hash-chain evidence independent of input formatting/order. */
export function canonicalizeGroupManifest(manifest: GroupManifest): string {
  return canonicalizeGroupManifestUnchecked(manifest);
}
function canonicalizeGroupManifestUnchecked(manifest: GroupManifest): string {
  const sorted = {
    version: manifest.version,
    groups: [...manifest.groups].sort((a, b) => compareCanonical(a.id, b.id)).map((group) => ({
      id: group.id, name: group.name,
      memberships: [...group.memberships].sort((a, b) => compareCanonical(a.id, b.id)),
      ownership: [...group.ownership].sort((a, b) => compareCanonical(a.id, b.id)).map((edge) => ({ ...edge, evidenceRefs: [...edge.evidenceRefs].sort(compareCanonical) })),
    })),
  };
  return JSON.stringify(sorted);
}
function chainHash(previousHash: string | null, canonical: string, event?: Pick<GroupManifestEvent, "id" | "actor" | "created_at">): string {
  const payload = event
    ? `${previousHash ?? "GENESIS"}\n${event.id}\n${event.actor}\n${event.created_at}\n${canonical}`
    : `${previousHash ?? "GENESIS"}\n${canonical}`;
  return createHash("sha256").update(payload).digest("hex");
}

export function applyGroupManifest(db: Database, workspaceRoot: string, input: unknown, audit: ResolveActorInput): { status: "applied" | "unchanged"; manifestHash: string } {
  const manifest = parseGroupManifest(input, listWorkspaceCompanies(workspaceRoot).map((company) => company.slug));
  const canonical = canonicalizeGroupManifest(manifest);
  return db.transaction(() => {
    const events = readAndVerifyGroupManifestEvents(db);
    const previous = events.at(-1) ?? null;
    if (previous) {
      if (previous.canonical_manifest === canonical) return { status: "unchanged" as const, manifestHash: previous.manifest_hash };
    }
    const nextId = (previous?.id ?? 0) + 1;
    // Resolve before any write so the hash-chain event and workspace audit
    // always carry exactly the same actor identity.
    const actor = resolveActor(audit).auditActor;
    const createdAt = new Date().toISOString();
    const hash = chainHash(previous?.manifest_hash ?? null, canonical, { id: nextId, actor, created_at: createdAt });
    insertWorkspaceAudit(db, { ...audit, eventType: "group_manifest_applied", entityType: "group_manifest", entityId: hash });
    db.query("INSERT INTO rm_group_manifest_events (id, manifest_hash, previous_hash, canonical_manifest, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(nextId, hash, previous?.manifest_hash ?? null, canonical, actor, createdAt);
    return { status: "applied" as const, manifestHash: hash };
  })();
}

export function readCurrentGroupManifest(db: Database, workspaceRoot: string): { manifest: GroupManifest; manifestHash: string; eventId: number } | null {
  const row = readAndVerifyGroupManifestEvents(db).at(-1) ?? null;
  if (!row) return null;
  const manifest = parseGroupManifest(JSON.parse(row.canonical_manifest), listWorkspaceCompanies(workspaceRoot).map((company) => company.slug));
  return { manifest, manifestHash: row.manifest_hash, eventId: row.id };
}

function readAndVerifyGroupManifestEvents(db: Database): GroupManifestEvent[] {
  const rows = db.query("SELECT id, manifest_hash, previous_hash, canonical_manifest, actor, created_at FROM rm_group_manifest_events ORDER BY id").all() as GroupManifestEvent[];
  let previous: string | null = null;
  for (const row of rows) {
    const expected = chainHash(previous, row.canonical_manifest, row);
    if (row.id < 1 || row.previous_hash !== previous || expected !== row.manifest_hash) {
      throw new Error("group manifest hash-chain is invalid");
    }
    previous = row.manifest_hash;
  }
  return rows;
}

export type GroupStructureOverview = {
  scope: "structure-status-only";
  consolidationStatus: "not-available";
  consolidatedFigures: null;
  rawCompanySums: null;
  blockers: readonly string[];
  manifestStatus: "not-configured" | "ready" | "blocked";
  asOf: string;
  groups: Array<{ partial: boolean; id?: string; name?: string; visibleMemberships: Array<{ id: string; companySlug: string; validFrom: string; validToExclusive?: string; archived: boolean }>; visibleOwnership: Array<{ id: string; parentCompanySlug: string; childCompanySlug: string; basisPoints: number; validFrom: string; validToExclusive?: string; evidenceRefs: string[] }>; readiness: "ready" | "blocked"; blockers: string[] }>;
};

/** Does not open a company DB: callers supply the identities they may reveal. */
export function getGroupStructureOverview(db: Database, workspaceRoot: string, visibleCompanySlugs: ReadonlySet<string>, asOfInput: string): GroupStructureOverview {
  const asOf = parseGroupAsOf(asOfInput);
  const current = readCurrentGroupManifest(db, workspaceRoot);
  if (!current) return { scope: "structure-status-only", consolidationStatus: "not-available", consolidatedFigures: null, rawCompanySums: null, blockers: GROUP_CONSOLIDATION_BLOCKERS, manifestStatus: "not-configured", asOf, groups: [] };
  const companyBySlug = new Map(listWorkspaceCompanies(workspaceRoot).map((company) => [company.slug, company]));
  const groups = current.manifest.groups.flatMap((group) => {
    const activeMemberships = group.memberships.filter((membership) => isActiveAt(membership, asOf));
    const visibleMemberships = activeMemberships.filter((membership) => visibleCompanySlugs.has(membership.companySlug)).map((membership) => ({ ...membership, archived: companyBySlug.get(membership.companySlug)?.archived === true }));
    // Do not disclose a group the caller cannot see through any active entity.
    if (visibleMemberships.length === 0) return [];
    const partial = visibleMemberships.length !== activeMemberships.length;
    const activeOwnership = group.ownership.filter((edge) => isActiveAt(edge, asOf));
    const visibleOwnership = activeOwnership.filter((edge) => visibleCompanySlugs.has(edge.parentCompanySlug) && visibleCompanySlugs.has(edge.childCompanySlug));
    const hiddenOwnership = visibleOwnership.length !== activeOwnership.length;
    const ledgerMissing = activeMemberships.some((membership) => {
      const path = companyPaths(companyRootForSlug(workspaceRoot, membership.companySlug)).db;
      try {
        if (!existsSync(path)) return true;
        const stat = statSync(path);
        return !stat.isFile() || stat.size === 0;
      } catch { return true; }
    });
    const blockers: string[] = [...GROUP_CONSOLIDATION_BLOCKERS];
    if (partial || hiddenOwnership) blockers.unshift("group structure is partial for this user");
    if (activeMemberships.some((membership) => companyBySlug.get(membership.companySlug)?.archived)) blockers.unshift("one or more active group members are archived");
    if (ledgerMissing) blockers.unshift("one or more active group members have no available ledger");
    const blocked = partial || hiddenOwnership || ledgerMissing || activeMemberships.some((membership) => companyBySlug.get(membership.companySlug)?.archived);
    return [{ partial, ...(partial ? {} : { id: group.id, name: group.name }), visibleMemberships, visibleOwnership, readiness: blocked ? "blocked" as const : "ready" as const, blockers }];
  });
  const hasAnyActive = current.manifest.groups.some((group) => group.memberships.some((membership) => isActiveAt(membership, asOf)));
  const blockers = hasAnyActive ? GROUP_CONSOLIDATION_BLOCKERS : [...GROUP_CONSOLIDATION_BLOCKERS, "no active group memberships exist at this date"];
  return { scope: "structure-status-only", consolidationStatus: "not-available", consolidatedFigures: null, rawCompanySums: null, blockers, manifestStatus: !hasAnyActive || groups.some((group) => group.readiness === "blocked") ? "blocked" : "ready", asOf, groups };
}
