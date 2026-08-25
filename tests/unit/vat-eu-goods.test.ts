import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, migrate } from "../../src/core/db";
import { ingestDocument } from "../../src/core/documents";
import { seedAccounts } from "../../src/core/ledger";
import { ensureCompanyDirs } from "../../src/core/paths";
import { buildVatReport, postEuGoodsAcquisitionPurchase } from "../../src/core/vat";
import { storeViesValidation } from "../../src/core/vies";

describe("EU goods acquisition VAT", () => {
  test("posts and reports EU goods separately from EU services", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-eu-goods-"));
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-eu-goods-inbox-"));
    try {
      const source = join(inbox, "goods.txt"); writeFileSync(source, "Synthetic EU goods");
      const db = openDb(ensureCompanyDirs(root).db); migrate(db); seedAccounts(db);
      const doc = ingestDocument(db, root, source, {
        source: "test", issueDate: "2026-08-01", invoiceNo: "GOODS-1", deliveryDescription: "Synthetic goods",
        amountIncVat: 1000, vatAmount: 0, currency: "DKK",
        sender: { name: "Synthetic EU supplier", address: "Berlin", vatOrCvr: "DE123456789" },
        recipient: { name: "Synthetic buyer", address: "Copenhagen", vatOrCvr: "DK12345678" },
      });
      expect(doc.ok).toBe(true);
      storeViesValidation(db, { vatOrCvr: "DE123456789", valid: true, validatedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-12-01T00:00:00.000Z" });
      const input = { transactionDate: "2026-08-01", text: "Synthetic EU purchase", documentId: doc.documentId!, netAmount: 1000, expenseAccountNo: "3010" };
      expect(postEuGoodsAcquisitionPurchase(db, input).ok).toBe(true);
      const report = buildVatReport(db, "2026-08-01", "2026-08-31");
      expect(report).toMatchObject({ euGoodsAcquisitionPurchaseBase: 1000, euGoodsAcquisitionOutputVat: 250, reverseChargePurchaseBase: 0 });
      expect(report.rubrikker).toMatchObject({ rubrikA: 1000, momsAfVarekobUdland: 250, momsAfYdelseskobUdland: 0 });
      db.close();
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(inbox, { recursive: true, force: true }); }
  });
});
