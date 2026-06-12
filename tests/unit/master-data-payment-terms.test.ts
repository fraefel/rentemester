// Tests: src/core/master-data.ts — kunde-betalingsfrist vs. virksomhedens profilfrist (EJER-3)
//
// Audit-fund EJER-3: virksomhedsprofilen siger "Betalingsfrist (dage): 14",
// men en faktura til en kartotekskunde oprettet UDEN egen betalingsfrist fik
// +30 dage uden besked, fordi `createCustomer` hardcodede 30. En kunde uden
// eksplicit angivet frist skal i stedet ARVE virksomhedens profilfrist på
// fakturatidspunktet (gemmes som NULL), og en kunde med en eksplicit frist
// der afviger fra profilens skal give en synlig note i invoice create-output.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { issueInvoice } from "../../src/core/issued-invoices";
import {
  createCustomer,
  getCustomerById,
  resolveInvoiceMasterData,
  updateCustomer,
} from "../../src/core/master-data";
import type { InvoicePayload } from "../../src/core/invoice";

const COMPANY_TERMS_DAYS = 14;

function setupCompany() {
  const root = mkdtempSync(join(tmpdir(), "rentemester-payment-terms-"));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  db.run(
    `INSERT INTO companies (id, name, country, currency, cvr, payment_terms_days)
     VALUES (1, 'Rentemester ApS', 'DK', 'DKK', 'DK12345678', ?)`,
    [COMPANY_TERMS_DAYS],
  );
  return { root, db };
}

function invoicePayload(): InvoicePayload {
  return {
    invoiceType: "full",
    vatTreatment: "standard",
    issueDate: "2026-05-16",
    seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
    buyer: {},
    lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
    totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
    currency: "DKK",
  };
}

describe("EJER-3 — customer payment terms inherit the company profile", () => {
  test("a customer created without explicit terms stores NULL and inherits the profile terms at invoice time", () => {
    const { root, db } = setupCompany();

    const created = createCustomer(db, { name: "Kunde A/S", address: "Købervej 9" });
    expect(created.ok).toBe(true);
    // Ingen eksplicit frist → NULL i kundekortet (ikke hardcodet 30).
    expect(getCustomerById(db, created.customerId!)!.payment_terms_days).toBeNull();

    const resolved = resolveInvoiceMasterData(db, invoicePayload(), { customerId: created.customerId! });
    expect(resolved.ok).toBe(true);
    // Kundekortet sætter IKKE dueDate — virksomhedens profilfrist tager over
    // i issueInvoice (enrichInvoiceFromCompany).
    expect(resolved.payload!.dueDate).toBeUndefined();
    expect((resolved as { notes?: string[] }).notes ?? []).toEqual([]);

    const issued = issueInvoice(db, root, resolved.payload!);
    expect(issued.ok, issued.errors.join("; ")).toBe(true);
    const stored = JSON.parse(
      (db.query("SELECT payload_json FROM documents WHERE id = ?").get(issued.documentId!) as { payload_json: string }).payload_json,
    );
    // 2026-05-16 + 14 dage (virksomhedens profil) = 2026-05-30 — IKKE +30.
    expect(stored.dueDate).toBe("2026-05-30");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a customer with explicit deviating terms drives the due date AND surfaces a visible note", () => {
    const { root, db } = setupCompany();

    const created = createCustomer(db, { name: "Kunde A/S", address: "Købervej 9", paymentTermsDays: 30 });
    expect(created.ok).toBe(true);
    expect(getCustomerById(db, created.customerId!)!.payment_terms_days).toBe(30);

    const resolved = resolveInvoiceMasterData(db, invoicePayload(), { customerId: created.customerId! });
    expect(resolved.ok).toBe(true);
    expect(resolved.payload!.dueDate).toBe("2026-06-15"); // +30 fra kundekortet
    const notes = (resolved as { notes?: string[] }).notes ?? [];
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("30 dage");
    expect(notes[0]).toContain("kundekortet");
    expect(notes[0]).toContain(`${COMPANY_TERMS_DAYS}`);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("explicit customer terms equal to the profile terms produce no note", () => {
    const { root, db } = setupCompany();

    const created = createCustomer(db, { name: "Kunde A/S", paymentTermsDays: COMPANY_TERMS_DAYS });
    const resolved = resolveInvoiceMasterData(db, invoicePayload(), { customerId: created.customerId! });
    expect(resolved.ok).toBe(true);
    expect(resolved.payload!.dueDate).toBe("2026-05-30");
    expect((resolved as { notes?: string[] }).notes ?? []).toEqual([]);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("an explicit payload dueDate always wins and produces no note", () => {
    const { root, db } = setupCompany();

    const created = createCustomer(db, { name: "Kunde A/S", paymentTermsDays: 30 });
    const payload = { ...invoicePayload(), dueDate: "2026-06-01" };
    const resolved = resolveInvoiceMasterData(db, payload, { customerId: created.customerId! });
    expect(resolved.ok).toBe(true);
    expect(resolved.payload!.dueDate).toBe("2026-06-01");
    expect((resolved as { notes?: string[] }).notes ?? []).toEqual([]);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("updateCustomer can clear an explicit frist back to inherit (null)", () => {
    const { root, db } = setupCompany();

    const created = createCustomer(db, { name: "Kunde A/S", paymentTermsDays: 30 });
    const updated = updateCustomer(db, created.customerId!, { paymentTermsDays: null });
    expect(updated.ok).toBe(true);
    expect(getCustomerById(db, created.customerId!)!.payment_terms_days).toBeNull();

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("an existing ledger with NOT NULL payment_terms_days is migrated in place (bagudkompatibilitet)", () => {
    const { root, db } = setupCompany();

    // Eksisterende kunder med gemt 30 kan ikke skelnes fra et bevidst 30 —
    // de beholder deres værdi efter migreringen.
    const legacy = createCustomer(db, { name: "Gammel Kunde", paymentTermsDays: 30 });
    migrate(db); // idempotent — anden kørsel må ikke vælte noget
    expect(getCustomerById(db, legacy.customerId!)!.payment_terms_days).toBe(30);

    const fresh = createCustomer(db, { name: "Ny Kunde" });
    expect(getCustomerById(db, fresh.customerId!)!.payment_terms_days).toBeNull();

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
