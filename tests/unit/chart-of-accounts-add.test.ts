import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { seedAccounts } from "../../src/core/ledger";
import { createAccount, getAccountByNo } from "../../src/core/chart-of-accounts";
import { loadVatAccountSemantics } from "../../src/core/vat-account-semantics";

function freshCompany() {
  const root = mkdtempSync(join(tmpdir(), "rentemester-accounts-add-"));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  seedAccounts(db);
  return { root, db };
}

function cleanup(root: string, db: ReturnType<typeof openDb>) {
  db.close();
  rmSync(root, { recursive: true, force: true });
}

describe("createAccount() — sanctioned post-init chart of accounts write", () => {
  test("adds a new account with explicit fields and audit-logs it", () => {
    const { root, db } = freshCompany();
    const result = createAccount(db, {
      accountNo: "1030",
      name: "Udbytte fra portefølje",
      type: "income",
      defaultVatCode: "DK_PURCHASE_25",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.accountNo).toBe("1030");

    const stored = getAccountByNo(db, "1030");
    expect(stored).toEqual({
      id: expect.any(Number),
      accountNo: "1030",
      name: "Udbytte fra portefølje",
      type: "income",
      normalBalance: "credit",
      defaultVatCode: "DK_PURCHASE_25",
      allowDirectPosting: true,
      active: true,
    });

    const audit = db
      .query("SELECT event_type, entity_type, entity_id FROM audit_log WHERE event_type = 'accounts_add'")
      .get() as { event_type: string; entity_type: string; entity_id: string } | null;
    expect(audit).toEqual({ event_type: "accounts_add", entity_type: "account", entity_id: "1030" });

    cleanup(root, db);
  });

  test("derives normalBalance from type (asset→debit, income→credit)", () => {
    const { root, db } = freshCompany();

    const asset = createAccount(db, { accountNo: "1305", name: "Tilgodehavende udbytteskat", type: "asset" });
    const income = createAccount(db, { accountNo: "1025", name: "Renteindtægter", type: "income" });
    const expense = createAccount(db, { accountNo: "3325", name: "Kursregulering værdipapirer", type: "expense" });
    const liability = createAccount(db, { accountNo: "7250", name: "Skyldige gebyrer", type: "liability" });

    expect(asset.ok && getAccountByNo(db, "1305")?.normalBalance).toBe("debit");
    expect(income.ok && getAccountByNo(db, "1025")?.normalBalance).toBe("credit");
    expect(expense.ok && getAccountByNo(db, "3325")?.normalBalance).toBe("debit");
    expect(liability.ok && getAccountByNo(db, "7250")?.normalBalance).toBe("credit");

    cleanup(root, db);
  });

  test("accepts explicit normalBalance for a contra account (asset + credit)", () => {
    const { root, db } = freshCompany();
    const result = createAccount(db, {
      accountNo: "5811",
      name: "Akkumulerede afskrivninger, bygninger",
      type: "asset",
      normalBalance: "credit",
    });
    expect(result.ok).toBe(true);
    expect(getAccountByNo(db, "5811")?.normalBalance).toBe("credit");
    cleanup(root, db);
  });

  test("rejects a duplicate account_no with a clear error", () => {
    const { root, db } = freshCompany();
    // 2000 "Bank" is seeded — try to add it again.
    const dup = createAccount(db, { accountNo: "2000", name: "Bank 2", type: "asset" });
    expect(dup).toEqual({
      ok: false,
      errors: ["account 2000 already exists in the chart of accounts"],
    });
    cleanup(root, db);
  });

  test("validates required fields and the type enum", () => {
    const { root, db } = freshCompany();
    expect(createAccount(db, { accountNo: "", name: "x", type: "asset" })).toEqual({
      ok: false,
      errors: ["accountNo is required"],
    });
    expect(createAccount(db, { accountNo: "9000", name: "", type: "asset" })).toEqual({
      ok: false,
      errors: ["name is required"],
    });
    expect(createAccount(db, { accountNo: "9000", name: "x", type: "" })).toEqual({
      ok: false,
      errors: ["type is required"],
    });
    expect(createAccount(db, { accountNo: "9000", name: "x", type: "bogus" })).toEqual({
      ok: false,
      errors: ["type must be one of asset|liability|equity|income|expense|vat (got 'bogus')"],
    });
    expect(
      createAccount(db, { accountNo: "9000", name: "x", type: "asset", normalBalance: "sideways" }),
    ).toEqual({
      ok: false,
      errors: ["normalBalance must be one of debit|credit (got 'sideways')"],
    });
    expect(
      createAccount(db, {
        accountNo: "9000",
        name: "x",
        type: "expense",
        defaultVatCode: "NOT_A_CANONICAL_CODE",
      }),
    ).toEqual({
      ok: false,
      errors: [
        "defaultVatCode must be a canonical VAT code (got 'NOT_A_CANONICAL_CODE')",
      ],
    });
    expect(getAccountByNo(db, "9000")).toBeNull();
    cleanup(root, db);
  });

  test("never confirms account roles implicitly, while type=vat retains narrow VAT semantics", () => {
    const { root, db } = freshCompany();
    const beforeMappings = db
      .query("SELECT COUNT(*) AS count FROM account_role_mappings")
      .get() as { count: number };

    const result = createAccount(db, {
      accountNo: "1290",
      name: "Særskilt salgsmoms",
      type: "vat",
      normalBalance: "credit",
    });
    expect(result.ok).toBe(true);

    const afterMappings = db
      .query("SELECT COUNT(*) AS count FROM account_role_mappings")
      .get() as { count: number };
    const mappingForNewAccount = db
      .query("SELECT role FROM account_role_mappings WHERE account_no = ?")
      .get("1290");
    const proposalForNewAccount = db
      .query("SELECT role FROM account_role_proposals WHERE account_no = ?")
      .get("1290");
    expect(afterMappings.count).toBe(beforeMappings.count);
    expect(mappingForNewAccount).toBeNull();
    expect(proposalForNewAccount).toBeNull();

    // `type=vat` is deliberately enough for amount-side classification; it
    // is not an implicit role confirmation and cannot satisfy role lookups.
    expect(loadVatAccountSemantics(db).amountSideByAccountNo.get("1290")).toBe(
      "output",
    );
    cleanup(root, db);
  });

  test("honors allowDirectPosting=false (for summary/control accounts)", () => {
    const { root, db } = freshCompany();
    const result = createAccount(db, {
      accountNo: "9999",
      name: "Kontrolkonto",
      type: "asset",
      allowDirectPosting: false,
    });
    expect(result.ok).toBe(true);
    expect(getAccountByNo(db, "9999")?.allowDirectPosting).toBe(false);

    // Omitting the flag keeps the schema default (true).
    const defaulted = createAccount(db, { accountNo: "9998", name: "Standard", type: "asset" });
    expect(defaulted.ok).toBe(true);
    expect(getAccountByNo(db, "9998")?.allowDirectPosting).toBe(true);

    cleanup(root, db);
  });

  test("carries the actor through to the audit log", () => {
    const { root, db } = freshCompany();
    createAccount(
      db,
      { accountNo: "1031", name: "Udbytte test", type: "income" },
      { createdBy: "user:owner@example.com", createdByProgram: "rentemester-cli" },
    );
    const actor = db
      .query("SELECT actor FROM audit_log WHERE event_type = 'accounts_add' ORDER BY id DESC LIMIT 1")
      .get() as { actor: string } | null;
    expect(actor?.actor).toBe("user:owner@example.com via rentemester-cli");
    cleanup(root, db);
  });
});
