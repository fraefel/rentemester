import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../src/core/db";
import { seedAccounts } from "../../src/core/ledger";
import { accountRoleStatus, confirmAccountRole, proposeAccountRole, resolveAccountRole } from "../../src/core/account-roles";
import { createTrustedHistoricalImportProvenance, isTrustedHistoricalImportProvenance } from "../../src/core/import-provenance";

function db() {
  const database = new Database(":memory:");
  migrate(database);
  seedAccounts(database);
  return database;
}

test("native chart seeds complete, audited, semantically compatible role mappings", () => {
  const database = db();
  expect(accountRoleStatus(database)).toEqual({ status: "complete", missing: [], ambiguous: [] });
  expect(resolveAccountRole(database, "output_vat")).toMatchObject({ ok: true, accountNo: "1200", version: 1 });
  expect(database.query("SELECT actor FROM audit_log WHERE event_type = 'account_role_confirmed' LIMIT 1").get()).toEqual({ actor: "system via native-account-role-seed" });
  database.close();
});

test("proposals remain separate, ambiguity is explicit, and incompatible confirmations fail closed", () => {
  const database = db();
  proposeAccountRole(database, "bank", "2000", "import-a");
  database.run("INSERT INTO accounts (account_no, name, type, normal_balance) VALUES ('2010', 'Second bank', 'asset', 'debit')");
  proposeAccountRole(database, "bank", "2010", "import-b");
  expect(accountRoleStatus(database).ambiguous).toEqual(["bank"]);
  expect(confirmAccountRole(database, "output_vat", "2000", "user:tester")).toEqual({ ok: false, error: "account 2000 is not compatible with role 'output_vat'" });
  database.run("UPDATE accounts SET active = 0 WHERE account_no = '1200'");
  expect(resolveAccountRole(database, "output_vat")).toEqual({ ok: false, role: "output_vat", error: "account role 'output_vat' maps to inactive account 1200" });
  database.close();
});

test("historical import provenance is an internal runtime capability, not a forgeable payload", () => {
  const provenance = createTrustedHistoricalImportProvenance();
  expect(isTrustedHistoricalImportProvenance(provenance)).toBe(true);
  expect(isTrustedHistoricalImportProvenance({})).toBe(false);
  expect(isTrustedHistoricalImportProvenance(JSON.parse(JSON.stringify(provenance)))).toBe(false);
});
