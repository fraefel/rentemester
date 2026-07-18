import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../src/core/db";
import { seedAccounts } from "../../src/core/ledger";
import { accountRoleStatus, confirmAccountRole, persistAccountRoleProposals, proposeAccountRole, resolveAccountRole } from "../../src/core/account-roles";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function db() {
  const database = new Database(":memory:");
  migrate(database);
  seedAccounts(database);
  return database;
}

test("native chart seeds complete, audited, semantically compatible role mappings", () => {
  const database = db();
  expect(accountRoleStatus(database)).toMatchObject({ status: "complete", missing: [], ambiguous: [], proposals: [], reasons: [] });
  expect(resolveAccountRole(database, "output_vat")).toMatchObject({ ok: true, accountNo: "1200", version: 1 });
  expect(database.query("SELECT actor FROM audit_log WHERE event_type = 'account_role_confirmed' LIMIT 1").get()).toEqual({ actor: "system via native-account-role-seed" });
  database.close();
});

test("valid explicit confirmations win over later proposals, while an invalid mapping blocks completeness", () => {
  const database = db();
  database.run("INSERT INTO accounts (account_no, name, type, normal_balance) VALUES ('2010', 'Second bank', 'asset', 'debit')");
  expect(confirmAccountRole(database, "bank", "2010", "user:tester")).toMatchObject({ ok: true, resolution: { accountNo: "2010", version: 2, confirmationSource: "explicit" } });
  proposeAccountRole(database, "bank", "2000", "import-a");
  proposeAccountRole(database, "bank", "2010", "import-b");
  database.run("INSERT INTO accounts (account_no, name, type, normal_balance) VALUES ('2020', 'Third bank', 'asset', 'debit')");
  persistAccountRoleProposals(database, [{ role: "bank", accountNo: "2020", source: "import-c" }]);
  // A deliberate confirmation is authoritative; later import evidence cannot demote it.
  expect(accountRoleStatus(database).status).toBe("complete");
  expect(confirmAccountRole(database, "output_vat", "2000", "user:tester")).toEqual({ ok: false, error: "account 2000 is not compatible with role 'output_vat'" });
  database.run("UPDATE accounts SET active = 0 WHERE account_no = '1200'");
  expect(resolveAccountRole(database, "output_vat")).toEqual({ ok: false, role: "output_vat", error: "account role 'output_vat' maps to inactive account 1200" });
  expect(accountRoleStatus(database)).toMatchObject({ status: "incomplete" });
  database.close();
});

test("import proposals deactivate only native seeds, remain ambiguous, and cannot be silently reseeded", () => {
  const database = db();
  database.run("INSERT INTO accounts (account_no, name, type, normal_balance) VALUES ('2010', 'Imported bank A', 'asset', 'debit'), ('2020', 'Imported bank B', 'asset', 'debit')");
  const persisted = persistAccountRoleProposals(database, [
    { role: "bank", accountNo: "2010", source: "dinero:chart:name-bank" },
    { role: "bank", accountNo: "2020", source: "dinero:chart:name-bank" },
  ]);
  expect(persisted).toMatchObject({ stored: 2, reviewRequired: ["bank"] });
  expect(resolveAccountRole(database, "bank")).toMatchObject({ ok: false });
  expect(accountRoleStatus(database)).toMatchObject({ status: "ambiguous", ambiguous: ["bank"] });

  migrate(database);
  expect(resolveAccountRole(database, "bank")).toMatchObject({ ok: false });

  const confirmed = confirmAccountRole(database, "bank", "2010", "user:reviewer", "rentemester-cli", "explicit");
  expect(confirmed).toMatchObject({ ok: true, resolution: { accountNo: "2010", version: 2, confirmedBy: "user:reviewer", confirmationSource: "explicit" } });
  expect(database.query("SELECT account_no, status FROM account_role_proposals WHERE role = 'bank' ORDER BY account_no").all()).toEqual([
    { account_no: "2010", status: "accepted" },
    { account_no: "2020", status: "rejected" },
  ]);
  expect(database.query("SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'account_role' AND entity_id = 'bank' AND event_type IN ('account_role_review_required','account_role_confirmed')").get()).toMatchObject({ n: 3 });
  database.close();
});

test("runtime posting helpers contain no native 1200/2000/4000 semantic fallback literals", () => {
  const core = join(import.meta.dir, "../../src/core");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !["ledger.ts", "account-roles.ts"].includes(entry.name)) files.push(path);
    }
  };
  walk(core);
  const offenders = files.filter((path) => /["'](?:1200|2000|4000)["']/.test(readFileSync(path, "utf8")));
  expect(offenders).toEqual([]);
});

test("the privileged historical posting adapter is only called by the Dinero importer", () => {
  const sourceRoot = join(import.meta.dir, "../../src");
  const callers: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (
        entry.name.endsWith(".ts") &&
        path !== join(sourceRoot, "core", "ledger.ts") &&
        readFileSync(path, "utf8").includes("postVerifiedHistoricalImportEntry")
      ) {
        callers.push(path.slice(sourceRoot.length + 1));
      }
    }
  };
  walk(sourceRoot);
  expect(callers).toEqual(["core/import/dinero-postings.ts"]);
});
