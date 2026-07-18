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

export type AccountRoleResolution = { ok: true; role: AccountRole; accountNo: string; version: number } | { ok: false; role: AccountRole; error: string };

export function accountRoleStatus(db: Database): { status: AccountRoleStatus; missing: AccountRole[]; ambiguous: AccountRole[] } {
  const confirmed = db.query("SELECT role FROM account_role_mappings WHERE status = 'confirmed'").all() as Array<{ role: AccountRole }>;
  const have = new Set(confirmed.map((row) => row.role));
  const missing = ACCOUNT_ROLES.filter((role) => !have.has(role));
  const ambiguous = ACCOUNT_ROLES.filter((role) => {
    const proposals = db.query("SELECT COUNT(DISTINCT account_no) AS n FROM account_role_proposals WHERE role = ? AND status = 'proposed'").get(role) as { n: number };
    return proposals.n > 1;
  });
  return { status: ambiguous.length ? "ambiguous" : missing.length ? "incomplete" : "complete", missing, ambiguous };
}

export function resolveAccountRole(db: Database, role: AccountRole): AccountRoleResolution {
  const row = db.query(`SELECT m.account_no, m.version, a.type, a.normal_balance, a.active
    FROM account_role_mappings m JOIN accounts a ON a.account_no = m.account_no
    WHERE m.role = ? AND m.status = 'confirmed'`).get(role) as { account_no: string; version: number; type: string; normal_balance: string; active: number } | null;
  if (!row) return { ok: false, role, error: `account role '${role}' has no active confirmed mapping` };
  if (row.active !== 1) return { ok: false, role, error: `account role '${role}' maps to inactive account ${row.account_no}` };
  const expected = expectations[role];
  if (row.type !== expected.type || row.normal_balance !== expected.normalBalance) {
    return { ok: false, role, error: `account role '${role}' maps to semantically incompatible account ${row.account_no}` };
  }
  return { ok: true, role, accountNo: row.account_no, version: row.version };
}

export function proposeAccountRole(db: Database, role: AccountRole, accountNo: string, source: string) {
  db.run("INSERT OR IGNORE INTO account_role_proposals (role, account_no, source) VALUES (?, ?, ?)", role, accountNo, source);
}

export function confirmAccountRole(db: Database, role: AccountRole, accountNo: string, actor: string, createdByProgram = "rentemester") {
  const account = db.query("SELECT type, normal_balance, active FROM accounts WHERE account_no = ?").get(accountNo) as { type: string; normal_balance: string; active: number } | null;
  const expected = expectations[role];
  if (!account || account.active !== 1 || account.type !== expected.type || account.normal_balance !== expected.normalBalance) {
    return { ok: false as const, error: `account ${accountNo} is not compatible with role '${role}'` };
  }
  db.transaction(() => {
    const current = db.query("SELECT COALESCE(MAX(version), 0) AS n FROM account_role_mappings WHERE role = ?").get(role) as { n: number };
    db.run("UPDATE account_role_mappings SET status = 'superseded' WHERE role = ? AND status = 'confirmed'", role);
    db.run("INSERT INTO account_role_mappings (role, account_no, version, confirmed_by) VALUES (?, ?, ?, ?)", role, accountNo, current.n + 1, actor);
    db.run("UPDATE account_role_proposals SET status = 'accepted' WHERE role = ? AND account_no = ?", role, accountNo);
    insertAuditLog(db, { eventType: "account_role_confirmed", entityType: "account_role", entityId: role, message: `Confirmed ${role} -> ${accountNo} (version ${current.n + 1})`, createdBy: actor, createdByProgram });
  })();
  return { ok: true as const, resolution: resolveAccountRole(db, role) };
}

/** Seed only the native chart, and only if the account metadata still fits. */
export function seedNativeAccountRoles(db: Database) {
  const nativeRoles: Array<[AccountRole, string]> = [["bank", "2000"], ["debtors", "1100"], ["creditors", "7000"], ["output_vat", "1200"], ["input_vat", "4000"], ["reverse_charge_vat", "1200"], ["vat_settlement", "4500"], ["operational_default", "3000"]];
  for (const [role, accountNo] of nativeRoles) {
    const existing = db.query("SELECT 1 FROM account_role_mappings WHERE role = ? AND status = 'confirmed'").get(role);
    if (!existing) confirmAccountRole(db, role, accountNo, "system", "native-account-role-seed");
  }
}
