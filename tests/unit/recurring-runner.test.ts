import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, migrate } from "../../src/core/db";
import { ensureCompanyDirs } from "../../src/core/paths";
import { createRecurringInvoiceTemplate, generateRecurringInvoice, periodIndexAsOf, periodIssueDate } from "../../src/core/recurring-invoices";
import { runRecurringInvoices } from "../../src/core/recurring-runner";

function setup(channel: "manual" | "email" | "digisense" = "manual") {
  const root = mkdtempSync(join(tmpdir(), "rentemester-recurring-runner-"));
  const db = openDb(ensureCompanyDirs(root).db); migrate(db);
  const created = createRecurringInvoiceTemplate(db, { name: "T", interval: "weekly", intervalCount: 2, deliveryChannel: channel, firstIssueDate: "2026-01-01", invoice: { invoiceType: "full", vatTreatment: "standard", seller: { name: "S", address: "A", vatOrCvr: "DK12345678" }, buyer: { name: "B", address: "C" }, lines: [{ description: "x", quantity: 1, unitPriceExVat: 100, lineTotalExVat: 100 }], totals: { netAmount: 100, vatRate: .25, vatAmount: 25, grossAmount: 125 }, currency: "DKK" } });
  return { root, db, id: created.templateId! };
}
describe("recurring scheduler runner", () => {
  test("weekly every two weeks and catch-up are deterministic and idempotent", async () => {
    expect(periodIssueDate("2026-01-31", "monthly", 1, 1)).toBe("2026-02-28");
    expect(periodIssueDate("2024-02-29", "yearly", 1, 1)).toBe("2025-02-28");
    expect(periodIssueDate("2026-01-31", "monthly", 2, 1)).toBe("2026-03-31");
    expect(periodIssueDate("2026-01-31", "quarterly", 2, 1)).toBe("2026-07-31");
    let dateEvaluations = 0;
    const ancientIndex = periodIndexAsOf(
      "2024-02-29", 12, "2424-02-29", 1, "yearly",
      (...args) => { dateEvaluations += 1; return periodIssueDate(...args); },
    );
    expect(ancientIndex).toBe(400);
    expect(dateEvaluations).toBeLessThan(20);
    const { root, db } = setup();
    const first = await runRecurringInvoices(db, { companyRoot: root, asOfDate: "2026-02-01" });
    expect(first.generated).toBe(3);
    expect(db.query("SELECT COUNT(*) AS n FROM documents WHERE document_type='issued_invoice'").get()).toEqual({ n: 3 });
    const second = await runRecurringInvoices(db, { companyRoot: root, asOfDate: "2026-02-01" });
    expect(second.generated).toBe(0);
    db.close(); rmSync(root, { recursive: true, force: true });
  });
  test("rejects invalid interval counts and gives weekly interval windows an end", async () => {
    const { root, db } = setup();
    expect(createRecurringInvoiceTemplate(db, { name: "bad", interval: "monthly", intervalCount: 0, firstIssueDate: "2026-01-01", invoice: { invoiceType: "full", vatTreatment: "standard", seller: { name: "S", address: "A", vatOrCvr: "DK12345678" }, buyer: { name: "B", address: "C" }, lines: [{ description: "x", quantity: 1, unitPriceExVat: 100, lineTotalExVat: 100 }], totals: { netAmount: 100, vatRate: .25, vatAmount: 25, grossAmount: 125 }, currency: "DKK" } }).ok).toBe(false);
    const created = createRecurringInvoiceTemplate(db, { name: "weekly window", interval: "weekly", intervalCount: 2, firstIssueDate: "2026-01-01", deliveryPeriodMode: "interval_window", invoice: { invoiceType: "full", vatTreatment: "standard", seller: { name: "S", address: "A", vatOrCvr: "DK12345678" }, buyer: { name: "B", address: "C" }, lines: [{ description: "x", quantity: 1, unitPriceExVat: 100, lineTotalExVat: 100 }], totals: { netAmount: 100, vatRate: .25, vatAmount: 25, grossAmount: 125 }, currency: "DKK" } });
    const generated = await runRecurringInvoices(db, { companyRoot: root, asOfDate: "2026-01-01" });
    expect(generated.generated).toBe(2); // setup template + weekly window
    const generation = db.query("SELECT delivery_period_end FROM recurring_invoice_generations WHERE template_id = ?").get(created.templateId!) as { delivery_period_end: string };
    expect(generation.delivery_period_end).toBe("2026-01-15");
    db.close(); rmSync(root, { recursive: true, force: true });
  });
  test("two database connections create exactly one document for the same due period", async () => {
    const { root, db, id } = setup();
    const second = openDb(ensureCompanyDirs(root).db);
    // Bun's SQLite calls are synchronous, but separate connections exercise
    // the durable UNIQUE claim gate used by concurrently started processes.
    const [firstResult, secondResult] = await Promise.all([
      runRecurringInvoices(db, { companyRoot: root, asOfDate: "2026-01-01" }),
      runRecurringInvoices(second, { companyRoot: root, asOfDate: "2026-01-01" }),
    ]);
    expect(firstResult.generated + secondResult.generated).toBe(1);
    expect(second.query("SELECT COUNT(*) AS n FROM documents WHERE document_type = 'issued_invoice'").get()).toEqual({ n: 1 });
    expect(second.query("SELECT COUNT(*) AS n FROM recurring_invoice_generations WHERE template_id = ?").get(id)).toEqual({ n: 1 });
    second.close(); db.close(); rmSync(root, { recursive: true, force: true });
  });
  test("throws after attempted delivery become uncertain and never resend", async () => {
    const { root, db } = setup("email"); let calls = 0;
    const adapter = { preflight: async () => ({ ok: true }), deliver: async () => { calls += 1; throw new Error("timeout"); } };
    const failed = await runRecurringInvoices(db, { companyRoot: root, asOfDate: "2026-01-01", adapter });
    expect(failed.attempted).toBe(1);
    expect(failed.ok).toBe(false);
    expect((await runRecurringInvoices(db, { companyRoot: root, asOfDate: "2026-01-01", adapter })).attempted).toBe(0);
    expect(calls).toBe(1);
    expect(db.query("SELECT event_type FROM recurring_invoice_delivery_events ORDER BY id DESC LIMIT 1").get()).toEqual({ event_type: "uncertain" });
    db.close(); rmSync(root, { recursive: true, force: true });
  });

  test("a crash-stranded attempted reservation fails closed without calling transport", async () => {
    const { root, db, id } = setup("email");
    const generated = generateRecurringInvoice(db, root, { templateId: id, asOfDate: "2026-01-01" });
    const generation = db.query("SELECT id FROM recurring_invoice_generations WHERE document_id = ?").get(generated.documentId!) as { id: number };
    db.run("INSERT INTO recurring_invoice_delivery_events (generation_id, channel, event_type) VALUES (?, 'email', 'attempted')", generation.id);
    let calls = 0;
    const result = await runRecurringInvoices(db, {
      companyRoot: root,
      asOfDate: "2026-01-01",
      adapter: {
        preflight: async () => ({ ok: true }),
        deliver: async () => { calls += 1; return { status: "acknowledged" }; },
      },
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(0);
    expect(result.errors[0]).toContain("manual provider reconciliation");
    expect(result.errors[0]!.length).toBeLessThanOrEqual(240);
    db.close(); rmSync(root, { recursive: true, force: true });
  });
  test("preflight failures are retryable without transport", async () => {
    const { root, db } = setup("email"); let attempts = 0;
    const bad = { preflight: async () => ({ ok: false, error: "missing recipient" }), deliver: async () => { attempts += 1; return { status: "acknowledged" as const }; } };
    await runRecurringInvoices(db, { companyRoot: root, asOfDate: "2026-01-01", adapter: bad });
    const good = { preflight: async () => ({ ok: true }), deliver: async () => { attempts += 1; return { status: "acknowledged" as const }; } };
    expect((await runRecurringInvoices(db, { companyRoot: root, asOfDate: "2026-01-01", adapter: good })).attempted).toBe(1);
    expect(attempts).toBe(1);
    db.close(); rmSync(root, { recursive: true, force: true });
  });

  test("two connections reserve one delivery and only the winner calls transport", async () => {
    const { root, db } = setup("email");
    const second = openDb(ensureCompanyDirs(root).db);
    let calls = 0;
    const adapter = {
      preflight: async () => ({ ok: true }),
      deliver: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { status: "acknowledged" as const };
      },
    };
    const [left, right] = await Promise.all([
      runRecurringInvoices(db, { companyRoot: root, asOfDate: "2026-01-01", adapter }),
      runRecurringInvoices(second, { companyRoot: root, asOfDate: "2026-01-01", adapter }),
    ]);
    expect(left.attempted + right.attempted).toBe(1);
    expect(calls).toBe(1);
    expect(second.query("SELECT COUNT(*) AS n FROM recurring_invoice_delivery_events WHERE event_type = 'attempted'").get()).toEqual({ n: 1 });
    second.close(); db.close(); rmSync(root, { recursive: true, force: true });
  });

  test("an accepted queued delivery is status-observed on rerun and never delivered twice", async () => {
    const { root, db } = setup("digisense");
    let deliveries = 0;
    let observations = 0;
    const adapter = {
      preflight: async () => ({ ok: true }),
      deliver: async () => {
        deliveries += 1;
        return { status: "accepted_pending" as const, providerId: "provider-doc-1" };
      },
      observePending: async ({ providerId }: { providerId: string }) => {
        observations += 1;
        return { status: "acknowledged" as const, providerId };
      },
    };
    expect((await runRecurringInvoices(db, { companyRoot: root, asOfDate: "2026-01-01", adapter })).ok).toBe(true);
    expect((await runRecurringInvoices(db, { companyRoot: root, asOfDate: "2026-01-01", adapter })).ok).toBe(true);
    expect(deliveries).toBe(1);
    expect(observations).toBe(1);
    expect(db.query("SELECT provider_id, event_type FROM recurring_invoice_delivery_events ORDER BY id DESC LIMIT 1").get()).toEqual({ provider_id: "provider-doc-1", event_type: "acknowledged" });
    db.close(); rmSync(root, { recursive: true, force: true });
  });

  test("a pending observation throw remains status-only and reports failure", async () => {
    const { root, db } = setup("digisense");
    let deliveries = 0;
    let observations = 0;
    const adapter = {
      preflight: async () => ({ ok: true }),
      deliver: async () => {
        deliveries += 1;
        return { status: "accepted_pending" as const, providerId: "provider-observe-1" };
      },
      observePending: async () => {
        observations += 1;
        throw new Error("401 token=SECRETSECRETSECRETSECRETSECRETSECRET https://provider.example/status");
      },
    };
    await runRecurringInvoices(db, { companyRoot: root, asOfDate: "2026-01-01", adapter });
    const failed = await runRecurringInvoices(db, { companyRoot: root, asOfDate: "2026-01-01", adapter });
    expect(failed.ok).toBe(false);
    expect(failed.errors[0]).not.toContain("provider.example");
    expect(deliveries).toBe(1);
    expect(observations).toBe(1);
    expect(db.query("SELECT provider_id, event_type FROM recurring_invoice_delivery_events ORDER BY id DESC LIMIT 1").get()).toEqual({ provider_id: "provider-observe-1", event_type: "accepted_pending" });
    db.close(); rmSync(root, { recursive: true, force: true });
  });

  test("a terminal provider failure remains truthful and permanently blocks redelivery", async () => {
    const { root, db } = setup("digisense");
    let deliveries = 0;
    const adapter = {
      preflight: async () => ({ ok: true }),
      deliver: async () => {
        deliveries += 1;
        return { status: "terminal_failed" as const, providerId: "provider-doc-failed", message: "receiver rejected" };
      },
    };
    expect((await runRecurringInvoices(db, { companyRoot: root, asOfDate: "2026-01-01", adapter })).ok).toBe(false);
    expect((await runRecurringInvoices(db, { companyRoot: root, asOfDate: "2026-01-01", adapter })).ok).toBe(false);
    expect(deliveries).toBe(1);
    expect(db.query("SELECT provider_id, event_type FROM recurring_invoice_delivery_events ORDER BY id DESC LIMIT 1").get()).toEqual({ provider_id: "provider-doc-failed", event_type: "terminal_failed" });
    db.close(); rmSync(root, { recursive: true, force: true });
  });

  test("caps catch-up work and exposes a continuation without rescanning generated periods", async () => {
    const { root, db } = setup();
    const first = await runRecurringInvoices(db, {
      companyRoot: root, asOfDate: "2026-03-01", maxGenerations: 2,
    });
    expect(first.generated).toBe(2);
    expect(first.hasMore).toBe(true);
    expect(first.continuation?.remainingGenerations).toBeGreaterThan(0);
    const second = await runRecurringInvoices(db, {
      companyRoot: root, asOfDate: "2026-03-01", maxGenerations: 500,
    });
    expect(second.generated).toBeGreaterThan(0);
    expect(second.hasMore).toBe(false);
    const third = await runRecurringInvoices(db, {
      companyRoot: root, asOfDate: "2026-03-01", maxGenerations: 500,
    });
    expect(third.generated).toBe(0);
    db.close(); rmSync(root, { recursive: true, force: true });
  });

  test("plans only the cap for a centuries-old weekly template", async () => {
    const { root, db } = setup();
    const originalQuery = db.query.bind(db);
    let gapQueries = 0;
    (db as any).query = (sql: string) => {
      if (sql.includes("SELECT MIN(period_index)")) gapQueries += 1;
      return originalQuery(sql);
    };
    const result = await runRecurringInvoices(db, {
      companyRoot: root,
      asOfDate: "2226-01-01",
      maxGenerations: 3,
    });
    expect(result.generated).toBe(3);
    expect(result.remainingGenerations).toBeGreaterThan(5000);
    expect(gapQueries).toBeLessThanOrEqual(3);
    expect(db.query("SELECT COUNT(*) AS n FROM recurring_invoice_generations").get()).toEqual({ n: 3 });
    db.close(); rmSync(root, { recursive: true, force: true });
  });

  test("sanitizes and truncates adapter errors before persistence and output", async () => {
    const { root, db } = setup("email");
    const secret = "A".repeat(80);
    const result = await runRecurringInvoices(db, {
      companyRoot: root,
      asOfDate: "2026-01-01",
      adapter: {
        preflight: async () => ({ ok: false, error: `token=${secret} https://provider.example/private ${"x".repeat(400)}` }),
        deliver: async () => ({ status: "acknowledged" as const }),
      },
    });
    expect(result.errors[0]!.length).toBeLessThanOrEqual(240);
    expect(result.errors[0]).not.toContain(secret);
    expect(result.errors[0]).not.toContain("provider.example");
    const persisted = db.query("SELECT message FROM recurring_invoice_delivery_events ORDER BY id DESC LIMIT 1").get() as { message: string };
    expect(persisted.message).toBe(result.errors[0]);
    db.close(); rmSync(root, { recursive: true, force: true });
  });
});
