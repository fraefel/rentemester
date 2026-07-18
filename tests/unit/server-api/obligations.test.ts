import { describe, expect, test } from "bun:test";
import {
  config,
  companyPaths,
  companyRootForSlug,
  get,
  makeWorkspace,
  migrate,
  openDb,
  postLiability,
  postPnlEntry,
  rmSync,
} from "./_shared";
import { postDineroPostings } from "../../../src/core/import/dinero-postings";

describe("cockpit API — obligations (GET .../obligations)", () => {
  test("surfaces VAT with its statutory deadline and liability payables", async () => {
    const ws = makeWorkspace("obl-live", ["Acme ApS"]);
    try {
      // postPnlEntry → 250 output VAT − 100 input VAT = 150 payable for Q1.
      postPnlEntry(ws, "acme-aps", "2026-03-15", 1000, 400);
      postLiability(ws, "acme-aps", "2026-06-30", "63060", "Skyldig selskabsskat", 2000);
      postLiability(ws, "acme-aps", "2026-06-30", "63000", "Kreditorer", 500);
      const res = await get(
        config({ workspaceRoot: ws }),
        "/api/companies/acme-aps/obligations?year=2026",
      );
      expect(res.status).toBe(200);
      const o = res.body.obligations;
      expect(o.slug).toBe("acme-aps");
      expect(o.archived).toBe(false);
      const vat = o.obligations.find((r: any) => r.kind === "vat");
      expect(vat.amount).toBe(150);
      // Q1 2026 (Jan–Mar) is filed/paid by 1 June 2026.
      expect(vat.dueDate).toBe("2026-06-01");
      const tax = o.obligations.find((r: any) => r.kind === "corporation-tax");
      expect(tax.amount).toBe(2000);
      expect(tax.dueDate).toBe("2027-11-01");
      const creditors = o.obligations.find((r: any) => r.kind === "creditors");
      expect(creditors.amount).toBe(500);
      expect(creditors.dueDate).toBeNull();
      expect(o.totalOwed).toBe(2650);
      // Sorted soonest-first: dated rows before the dateless creditor row.
      expect(o.obligations[o.obligations.length - 1].kind).toBe("creditors");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("VAT is not double-counted: gross 64xxx VAT accounts never become liability rows", async () => {
    // A Dinero-imported chart books VAT into the standard Danish 64xxx block,
    // where the VAT accounts are typed `liability` (not `vat`). The net VAT
    // obligation is already surfaced by `vatPositionForPeriod`; the gross
    // output/input/reverse-charge accounts are merely its *components* and
    // must NOT also appear as their own per-account obligations — counting
    // both double-counts VAT (the Helheim 2026 "Skyldige beløb i alt" bug).
    const ws = makeWorkspace("obl-vat-dedupe", ["Acme ApS"]);
    try {
      // Gross output-side 64xxx VAT accounts, liability-typed, with credit
      // balances — the exact shape of the Helheim 2026 bug. They feed the
      // *net* VAT computation (here output-only: 4457.25 + 62.50 = 4519.75
      // payable for H1) and must NOT also surface as their own per-account
      // obligations.
      const db = openDb(companyPaths(companyRootForSlug(ws, "acme-aps")).db);
      try {
        migrate(db);
        db.run(
          `INSERT INTO accounts (account_no, name, type, normal_balance)
           VALUES ('64000', 'Salgsmoms (udgående moms)', 'liability', 'credit'),
                  ('64040', 'Moms af ydelser fra udlandet', 'liability', 'credit')`,
        );
        const imported = postDineroPostings(
          db,
          [
            {
              transactionDate: "2026-06-30",
              text: "Historisk salgsmomsregulering",
              voucherRef: "VAT-OUTPUT",
              lines: [
                { accountNo: "2000", debitAmount: 4457.25 },
                { accountNo: "64000", creditAmount: 4457.25 },
              ],
            },
            {
              transactionDate: "2026-06-30",
              text: "Historisk reverse-charge-regulering",
              voucherRef: "VAT-RC",
              lines: [
                { accountNo: "2000", debitAmount: 62.5 },
                { accountNo: "64040", creditAmount: 62.5 },
              ],
            },
          ],
          new Set(["2000", "64000", "64040"]),
        );
        expect(imported.ok).toBe(true);
      } finally {
        db.close();
      }
      // A genuine, non-VAT liability that MUST still surface unchanged.
      postLiability(ws, "acme-aps", "2026-06-30", "63060", "Skyldig selskabsskat", 264);
      const res = await get(
        config({ workspaceRoot: ws }),
        "/api/companies/acme-aps/obligations?year=2026",
      );
      expect(res.status).toBe(200);
      const o = res.body.obligations;
      // Exactly one VAT row — the dedicated net obligation.
      const vatRows = o.obligations.filter((r: any) => r.kind === "vat");
      expect(vatRows.length).toBe(1);
      expect(vatRows[0].amount).toBe(4519.75);
      // No gross 64xxx account leaks through as its own liability row.
      expect(
        o.obligations.some(
          (r: any) =>
            r.accountNo !== null &&
            r.accountNo >= "64000" &&
            r.accountNo < "64100",
        ),
      ).toBe(false);
      // The genuine non-VAT liability still surfaces.
      const tax = o.obligations.find((r: any) => r.kind === "corporation-tax");
      expect(tax.amount).toBe(264);
      // Total = net VAT (4519.75) + corporation tax (264), VAT counted ONCE.
      // Pre-fix this was 4519.75 + 4457.25 + 62.50 (gross leaking) + 264.
      expect(o.totalOwed).toBe(4783.75);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("a company that owes nothing still surfaces the annual-report deadline", async () => {
    const ws = makeWorkspace("obl-empty", ["Acme ApS"]);
    try {
      const res = await get(
        config({ workspaceRoot: ws }),
        "/api/companies/acme-aps/obligations?year=2026",
      );
      expect(res.status).toBe(200);
      // Nothing is owed (no VAT, no liabilities) — totalOwed is 0 — but the
      // årsrapport filing deadline (#290) is a recurring legal duty with no
      // ledger amount, so it is always shown.
      expect(res.body.obligations.totalOwed).toBe(0);
      const rows = res.body.obligations.obligations;
      expect(rows.length).toBe(1);
      expect(rows[0].kind).toBe("annual-report");
      expect(rows[0].amount).toBe(0);
      // ÅRL § 138: a class-B årsrapport is filed no later than 6 months after
      // the fiscal year ends — calendar year 2026 ⇒ 30 June 2027 (NOT 1 May).
      expect(rows[0].dueDate).toBe("2027-06-30");
      expect(rows[0].label).toContain("ÅRL § 138");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("obligations for an unknown slug is a safe 404", async () => {
    const ws = makeWorkspace("obl-404", ["Acme ApS"]);
    try {
      const res = await get(
        config({ workspaceRoot: ws }),
        "/api/companies/ghost/obligations",
      );
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("not_found");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
