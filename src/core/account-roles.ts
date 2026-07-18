import type { Database } from "bun:sqlite";
import { insertAuditLog } from "./actor";

export const ACCOUNT_ROLES = ["bank", "debtors", "creditors", "output_vat", "input_vat", "reverse_charge_vat", "vat_settlement", "operational_default"] as const;
export type AccountRole = typeof ACCOUNT_ROLES[number];
export type AccountRoleStatus = "complete" | "incomplete" | "ambiguous";

const expectations: Record<AccountRole, { type: string; normalBalance: string }> = {
  bank: { type: "asset", normalBalance: "debit" },
  debtors: { type: "asset", normalBalance: "debit" },
  creditors: { type: "liability", normalBalance: "credit" },
  output_vat: { type: "vat", normalBalance: "credit" },
  input_vat: { type: "vat", normalBalance: "debit" },
  reverse_charge_vat: { type: "vat", normalBalance: "credit" },
  vat_settlement: { type: "liability", normalBalance: "credit" },
  operational_default: { type: "expense", normalBalance: "debit" },
};

export type AccountRoleConfirmationSource = "native_seed" | "explicit";
export type AccountRoleResolution =
  | { ok: true; role: AccountRole; accountNo: string; version: number; confirmedBy: string; confirmationSource: AccountRoleConfirmationSource }
  | { ok: false; role: AccountRole; error: string };

export type AccountRoleProposal = { role: AccountRole; accountNo: string; source: string; proposedAt: string; compatible: boolean; reason?: string };
export type AccountRoleStatusDetail = {
  status: AccountRoleStatus;
  missing: AccountRole[];
  ambiguous: AccountRole[];
  proposals: AccountRoleProposal[];
  candidates: AccountRoleProposal[];
  reasons: Array<{ role: AccountRole; reason: string }>;
};

/** Read-only posting preflight. Completeness is deliberately the aggregate of
 * the same resolver used by posting code; a stale seed is not a confirmation. */
export function accountRoleStatus(db: Database): AccountRoleStatusDetail {
  const proposals = db.query("SELECT role, account_no, source, proposed_at FROM account_role_proposals WHERE status = 'proposed' ORDER BY role, account_no, source").all() as Array<{ role: AccountRole; account_no: string; source: string; proposed_at: string }>;
  const candidates = proposals.map((row) => {
    const compatibility = accountRoleCompatibility(db, row.role, row.account_no);
    return {
      role: row.role,
      accountNo: row.account_no,
      source: row.source,
      proposedAt: row.proposed_at,
      compatible: compatibility.ok,
      ...(compatibility.ok ? {} : { reason: compatibility.error }),
    };
  });
  const missing: AccountRole[] = [];
  const ambiguous: AccountRole[] = [];
  const reasons: Array<{ role: AccountRole; reason: string }> = [];
  for (const role of ACCOUNT_ROLES) {
    const resolution = resolveAccountRole(db, role);
    if (resolution.ok) continue;
    const distinct = new Set(candidates.filter((proposal) => proposal.role === role && proposal.compatible).map((proposal) => proposal.accountNo));
    if (distinct.size > 1) ambiguous.push(role);
    else missing.push(role);
    reasons.push({ role, reason: resolution.error + (distinct.size ? `; ${distinct.size} unconfirmed proposal${distinct.size === 1 ? "" : "s"}` : "") });
  }
  return { status: ambiguous.length ? "ambiguous" : missing.length ? "incomplete" : "complete", missing, ambiguous, proposals: candidates, candidates, reasons };
}

export function resolveAccountRole(db: Database, role: AccountRole): AccountRoleResolution {
  const row = db.query(`SELECT m.account_no, m.version, m.confirmed_by, m.confirmation_source, a.type, a.normal_balance, a.active
    FROM account_role_mappings m JOIN accounts a ON a.account_no = m.account_no
    WHERE m.role = ? AND m.status = 'confirmed'`).get(role) as { account_no: string; version: number; confirmed_by: string; confirmation_source: AccountRoleConfirmationSource; type: string; normal_balance: string; active: number } | null;
  if (!row) return { ok: false, role, error: `account role '${role}' has no active confirmed mapping` };
  if (row.active !== 1) return { ok: false, role, error: `account role '${role}' maps to inactive account ${row.account_no}` };
  const expected = expectations[role];
  if (row.type !== expected.type || row.normal_balance !== expected.normalBalance) {
    return { ok: false, role, error: `account role '${role}' maps to semantically incompatible account ${row.account_no}` };
  }
  return { ok: true, role, accountNo: row.account_no, version: row.version, confirmedBy: row.confirmed_by, confirmationSource: row.confirmation_source };
}

export function accountRoleCompatibility(db: Database, role: AccountRole, accountNo: string): { ok: true } | { ok: false; error: string } {
  const account = db.query("SELECT type, normal_balance, active FROM accounts WHERE account_no = ?").get(accountNo) as { type: string; normal_balance: string; active: number } | null;
  const expected = expectations[role];
  if (!account) return { ok: false, error: `account ${accountNo} does not exist` };
  if (account.active !== 1) return { ok: false, error: `account ${accountNo} is inactive` };
  if (account.type !== expected.type || account.normal_balance !== expected.normalBalance) {
    return { ok: false, error: `account ${accountNo} is not compatible with role '${role}'` };
  }
  return { ok: true };
}

export function proposeAccountRole(db: Database, role: AccountRole, accountNo: string, source: string): boolean {
  const compatibility = accountRoleCompatibility(db, role, accountNo);
  if (!compatibility.ok) return false;
  const result = db.run("INSERT OR IGNORE INTO account_role_proposals (role, account_no, source) VALUES (?, ?, ?)", role, accountNo, source);
  return result.changes > 0;
}

export function persistAccountRoleProposals(db: Database, proposals: ReadonlyArray<{ role: AccountRole; accountNo: string; source: string }>): { stored: number; ignored: number; reviewRequired: AccountRole[] } {
  let stored = 0;
  let ignored = 0;
  const reviewRequired = new Set<AccountRole>();
  const grouped = new Map<AccountRole, Array<{ role: AccountRole; accountNo: string; source: string }>>();
  for (const proposal of proposals) grouped.set(proposal.role, [...(grouped.get(proposal.role) ?? []), proposal]);

  for (const [role, roleProposals] of grouped) {
    const currentRow = db.query("SELECT account_no, confirmation_source FROM account_role_mappings WHERE role = ? AND status = 'confirmed'").get(role) as { account_no: string; confirmation_source: AccountRoleConfirmationSource } | null;
    const current = resolveAccountRole(db, role);
    if (current.ok && current.confirmationSource === "explicit") {
      ignored += roleProposals.length;
      continue;
    }
    const valid = roleProposals.filter((proposal) => accountRoleCompatibility(db, role, proposal.accountNo).ok);
    ignored += roleProposals.length - valid.length;
    const differsFromNative = currentRow?.confirmation_source === "native_seed" && valid.some((proposal) => proposal.accountNo !== currentRow.account_no);
    if (differsFromNative) {
      db.run("UPDATE account_role_mappings SET status = 'inactive' WHERE role = ? AND status = 'confirmed' AND confirmation_source = 'native_seed'", role);
      insertAuditLog(db, { eventType: "account_role_review_required", entityType: "account_role", entityId: role, message: `Imported chart requires explicit review of ${role}; native seed ${currentRow!.account_no} was deactivated`, createdBy: "system", createdByProgram: "rentemester-import" });
      reviewRequired.add(role);
    }
    for (const proposal of valid) {
      if (currentRow?.confirmation_source === "native_seed" && !differsFromNative && proposal.accountNo === currentRow.account_no) {
        ignored += 1;
        continue;
      }
      if (proposeAccountRole(db, role, proposal.accountNo, proposal.source)) stored += 1;
    }
  }
  return { stored, ignored, reviewRequired: [...reviewRequired] };
}

export function confirmAccountRole(db: Database, role: AccountRole, accountNo: string, actor: string, createdByProgram = "rentemester", confirmationSource: AccountRoleConfirmationSource = createdByProgram === "native-account-role-seed" ? "native_seed" : "explicit") {
  if (confirmationSource === "explicit" && !/^(user|agent|system):\S.+$/.test(actor)) {
    return { ok: false as const, error: "explicit account-role confirmation requires a canonical actor (user:..., agent:..., or system:...)" };
  }
  const compatibility = accountRoleCompatibility(db, role, accountNo);
  if (!compatibility.ok) return { ok: false as const, error: compatibility.error };
  db.transaction(() => {
    const current = db.query("SELECT COALESCE(MAX(version), 0) AS n FROM account_role_mappings WHERE role = ?").get(role) as { n: number };
    db.run("UPDATE account_role_mappings SET status = 'superseded' WHERE role = ? AND status = 'confirmed'", role);
    db.run("INSERT INTO account_role_mappings (role, account_no, version, confirmed_by, confirmation_source) VALUES (?, ?, ?, ?, ?)", role, accountNo, current.n + 1, actor, confirmationSource);
    db.run("UPDATE account_role_proposals SET status = 'accepted' WHERE role = ? AND account_no = ?", role, accountNo);
    db.run("UPDATE account_role_proposals SET status = 'rejected' WHERE role = ? AND account_no <> ? AND status = 'proposed'", role, accountNo);
    insertAuditLog(db, { eventType: "account_role_confirmed", entityType: "account_role", entityId: role, message: `Confirmed ${role} -> ${accountNo} (version ${current.n + 1})`, createdBy: actor, createdByProgram });
  })();
  return { ok: true as const, resolution: resolveAccountRole(db, role) };
}

/** Seed only the native chart, and only if the account metadata still fits. */
export function seedNativeAccountRoles(db: Database) {
  const nativeRoles: Array<[AccountRole, string]> = [["bank", "2000"], ["debtors", "1100"], ["creditors", "7000"], ["output_vat", "1200"], ["input_vat", "4000"], ["reverse_charge_vat", "1200"], ["vat_settlement", "4500"], ["operational_default", "3000"]];
  for (const [role, accountNo] of nativeRoles) {
    const history = db.query("SELECT 1 FROM account_role_mappings WHERE role = ? LIMIT 1").get(role);
    const proposal = db.query("SELECT 1 FROM account_role_proposals WHERE role = ? LIMIT 1").get(role);
    if (!history && !proposal) confirmAccountRole(db, role, accountNo, "system", "native-account-role-seed", "native_seed");
  }
}
