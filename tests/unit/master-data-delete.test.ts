// Tests: SMB-ejeren kan slette en fejl-importeret kunde eller leverandør
// fra cockpittet (#430). Sletning er en almindelig master-data mutation
// (kontakter er IKKE append-only — det er kun det bogførte ledger og
// fakturasnapshots). Forretningsregler:
//
//   - Bogførte fakturaer beholder navne-snapshot (de er ikke FK til kunden).
//   - Hvis kunden har en ÅBEN udstedt faktura (status != paid/credited/refunded/written_off):
//     sletningen blokeres med en klar besked + reference til fakturanummeret.
//   - For leverandører er der en `vendor_id` FK i `payables` — hvis der findes
//     en åben gæld med dette vendor_id, blokeres sletningen.
//   - Sletninger audit-logges (event_type `customer_delete` / `vendor_delete`).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { applyInvoicePayment } from "../../src/core/invoice-payments";
import { seedAccounts } from "../../src/core/ledger";
import { issueInvoice } from "../../src/core/issued-invoices";
import { postIssuedInvoiceToLedger } from "../../src/core/invoice-booking";
import {
  createCustomer,
  createVendor,
  deleteCustomer,
  deleteVendor,
  listCustomers,
  listVendors,
} from "../../src/core/master-data";

function freshDb() {
  const root = mkdtempSync(join(tmpdir(), "rentemester-md-del-"));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  return { root, db };
}

describe("deleteCustomer / deleteVendor — #430", () => {
  test("a customer with no open invoices can be deleted", () => {
    const { root, db } = freshDb();
    const created = createCustomer(db, { name: "Fejl-import ApS" });
    const id = (created as { customerId: number }).customerId;

    const deleted = deleteCustomer(db, id);
    expect(deleted.ok).toBe(true);
    expect(listCustomers(db).rows.find((r) => r.id === id)).toBeUndefined();

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a customer-delete writes an audit_log row", () => {
    const { root, db } = freshDb();
    const created = createCustomer(db, { name: "Slet-mig A/S" });
    const id = (created as { customerId: number }).customerId;

    deleteCustomer(db, id);
    const audit = db
      .query(
        `SELECT event_type, entity_type, entity_id, message FROM audit_log
         WHERE event_type = 'customer_delete' ORDER BY id DESC LIMIT 1`,
      )
      .get() as
      | { event_type: string; entity_type: string; entity_id: number; message: string }
      | null;
    expect(audit).not.toBeNull();
    expect(audit!.entity_type).toBe("customer");
    expect(String(audit!.entity_id)).toBe(String(id));
    expect(audit!.message).toContain("Slet-mig A/S");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("deleting a non-existent customer fails with a clear error", () => {
    const { root, db } = freshDb();
    const result = deleteCustomer(db, 9999);
    expect(result.ok).toBe(false);
    expect((result as { errors: string[] }).errors[0]).toMatch(/9999/);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a customer with an open issued invoice cannot be deleted", () => {
    const { root, db } = freshDb();
    const created = createCustomer(db, {
      name: "Aktiv kunde ApS",
      vatOrCvr: "DK12345678",
    });
    const id = (created as { customerId: number }).customerId;

    // Insert a minimal issued-invoice document whose payload buyer matches.
    db.run(
      `INSERT INTO documents (
         document_no, source, sha256_hash, document_type, invoice_no,
         invoice_date, amount_inc_vat, currency, payload_json
       ) VALUES (
         'F-0001', 'cockpit', 'hash-aktiv-kunde-0001', 'issued_invoice',
         'F-0001', '2026-05-01', 1250.00, 'DKK', ?
       )`,
      JSON.stringify({
        buyer: { name: "Aktiv kunde ApS", vatOrCvr: "DK12345678" },
        totals: { grossAmount: 1250.0 },
      }),
    );

    const result = deleteCustomer(db, id);
    expect(result.ok).toBe(false);
    const message = (result as { errors: string[] }).errors.join(" ");
    expect(message).toMatch(/åben/i);
    expect(message).toContain("F-0001");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a customer remains deletable once the invoice has been paid", () => {
    const { root, db } = freshDb();
    seedAccounts(db);
    const created = createCustomer(db, {
      name: "Betalt-kunde ApS",
      vatOrCvr: "DK87654321",
    });
    const id = (created as { customerId: number }).customerId;

    // Use the normal issue + post lifecycle so the settlement has immutable
    // receivable evidence as well as the payment application row.
    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-04-01",
      dueDate: "2026-04-15",
      invoiceNumber: "2026-0001",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Betalt-kunde ApS", address: "Kundevej 2", vatOrCvr: "DK87654321" },
      lines: [{ description: "Ydelse", quantity: 1, unitPriceExVat: 400, lineTotalExVat: 400 }],
      totals: { netAmount: 400, vatRate: 0.25, vatAmount: 100, grossAmount: 500 },
      currency: "DKK",
    });
    expect(issued.ok).toBe(true);
    const docId = issued.documentId!;
    expect(postIssuedInvoiceToLedger(db, { invoiceDocumentId: docId }).ok).toBe(true);

    expect(applyInvoicePayment(db, {
      invoiceDocumentId: docId,
      paymentDate: "2026-04-15",
      amount: 500,
    }).ok).toBe(true);

    const result = deleteCustomer(db, id);
    expect(result.ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a vendor with no open payable can be deleted", () => {
    const { root, db } = freshDb();
    const created = createVendor(db, { name: "Gammel-leverandør ApS" });
    const id = (created as { vendorId: number }).vendorId;

    const deleted = deleteVendor(db, id);
    expect(deleted.ok).toBe(true);
    expect(listVendors(db).rows.find((r) => r.id === id)).toBeUndefined();

    const audit = db
      .query(
        `SELECT entity_type, entity_id FROM audit_log
         WHERE event_type = 'vendor_delete' ORDER BY id DESC LIMIT 1`,
      )
      .get() as { entity_type: string; entity_id: number } | null;
    expect(audit).not.toBeNull();
    expect(String(audit!.entity_id)).toBe(String(id));

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a vendor referenced by an open payable cannot be deleted", () => {
    const { root, db } = freshDb();
    const created = createVendor(db, { name: "Aktiv-leverandør ApS" });
    const id = (created as { vendorId: number }).vendorId;

    // Insert minimum: a document, a balanced journal entry, a payable row
    // with an open balance (no payable_payments yet).
    db.run(
      `INSERT INTO documents (
         document_no, source, sha256_hash, document_type
       ) VALUES (
         'P-0001', 'cockpit', 'hash-aktiv-lev-0001', 'purchase_sale'
       )`,
    );
    const docId = (
      db.query("SELECT id FROM documents WHERE document_no = 'P-0001'").get() as {
        id: number;
      }
    ).id;
    db.run(
      `INSERT INTO journal_entries (entry_no, transaction_date, text, document_id, rule_version, entry_hash)
       VALUES ('JE-9001', '2026-05-01', 'Indkøb fra leverandør', ?, 'test', 'hash-je-9001')`,
      docId,
    );
    const jeId = (
      db.query("SELECT id FROM journal_entries WHERE entry_no = 'JE-9001'").get() as {
        id: number;
      }
    ).id;
    db.run(
      `INSERT INTO payables (document_id, vendor_id, bill_date, due_date,
         gross_amount, net_amount, vat_amount, journal_entry_id)
       VALUES (?, ?, '2026-05-01', '2026-05-31', 1000, 800, 200, ?)`,
      [docId, id, jeId],
    );

    const result = deleteVendor(db, id);
    expect(result.ok).toBe(false);
    expect((result as { errors: string[] }).errors.join(" ")).toMatch(/åben|gæld/i);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
