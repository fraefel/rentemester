import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, migrate } from "../../src/core/db";
import { ensureCompanyDirs } from "../../src/core/paths";
import { createRecurringInvoiceTemplate } from "../../src/core/recurring-invoices";
import { resolveRecurringDeliveryAdapter } from "../../src/core/recurring-delivery-adapter";
import { runRecurringInvoices } from "../../src/core/recurring-runner";

describe("concrete recurring delivery adapter", () => {
  test("rejects unavailable live SMTP before reservation and permits only explicit dry-run", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-recurring-email-adapter-"));
    const paths = ensureCompanyDirs(root);
    const db = openDb(paths.db);
    migrate(db);
    db.run("INSERT INTO customers (name, email) VALUES (?, ?)", "Kunde A/S", "kunde@example.test");
    createRecurringInvoiceTemplate(db, {
      name: "Email invoice",
      interval: "monthly",
      deliveryChannel: "email",
      firstIssueDate: "2026-01-15",
      invoice: {
        invoiceType: "full",
        vatTreatment: "standard",
        seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
        buyer: { name: "Kunde A/S", address: "Købervej 9" },
        lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
        totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
        currency: "DKK",
      },
    });
    const config = { host: "smtp.example.test", port: 587, fromAddress: "billing@example.test" };
    writeFileSync(join(paths.config, "smtp.json"), JSON.stringify({ ...config, dryRun: false }));
    const rejected = await runRecurringInvoices(db, {
      companyRoot: root,
      asOfDate: "2026-01-15",
      adapter: resolveRecurringDeliveryAdapter(db, root),
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.attempted).toBe(0);
    expect(rejected.errors.join(" ")).toContain("live email transport is unavailable");
    expect(db.query("SELECT COUNT(*) AS n FROM recurring_invoice_delivery_events WHERE event_type = 'attempted'").get()).toEqual({ n: 0 });

    writeFileSync(join(paths.config, "smtp.json"), JSON.stringify({ ...config, dryRun: true }));
    const dryRun = await runRecurringInvoices(db, {
      companyRoot: root,
      asOfDate: "2026-01-15",
      adapter: resolveRecurringDeliveryAdapter(db, root),
    });
    expect(dryRun.ok).toBe(true);
    expect(dryRun.attempted).toBe(1);
    expect(db.query("SELECT event_type FROM recurring_invoice_delivery_events ORDER BY id DESC LIMIT 1").get()).toEqual({ event_type: "acknowledged" });
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("status resolver and 401-like observation failures remain pending and never deliver", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-recurring-digisense-observe-"));
    const paths = ensureCompanyDirs(root);
    const db = openDb(paths.db); migrate(db);
    let deliverCalls = 0;
    const unavailable = resolveRecurringDeliveryAdapter(db, root, {
      resolveTransmitter: () => {
        deliverCalls += 1;
        return { ok: false, errors: ["must not resolve delivery"] };
      },
      resolveStatusChecker: () => ({ ok: false, errors: ["Digisense status config unavailable"] }),
    } as any);
    const configFailure = await unavailable.observePending!({
      documentId: 1, channel: "digisense", providerId: "provider-status-1",
    });
    expect(configFailure).toEqual(expect.objectContaining({
      status: "accepted_pending", providerId: "provider-status-1", observationFailed: true,
    }));

    const unauthorized = resolveRecurringDeliveryAdapter(db, root, {
      resolveTransmitter: () => {
        deliverCalls += 1;
        return { ok: false, errors: ["must not resolve delivery"] };
      },
      resolveStatusChecker: () => ({ ok: true, companyKey: "company-1", client: {} }),
      resume: async () => ({
        ok: false,
        status: "prepared",
        transmissionId: "provider-status-1",
        appliedRules: [],
        errors: ["401 unauthorized while observing status"],
      }),
    } as any);
    const authFailure = await unauthorized.observePending!({
      documentId: 1, channel: "digisense", providerId: "provider-status-1",
    });
    expect(authFailure).toEqual(expect.objectContaining({
      status: "accepted_pending",
      providerId: "provider-status-1",
      observationFailed: true,
      message: expect.stringContaining("401"),
    }));

    const throwingChecker = resolveRecurringDeliveryAdapter(db, root, {
      resolveTransmitter: () => {
        deliverCalls += 1;
        return { ok: false, errors: ["must not resolve delivery"] };
      },
      resolveStatusChecker: () => ({
        ok: true,
        companyKey: "company-1",
        client: { documentStatus: async () => { throw new Error("status checker timeout"); } },
      }),
      resume: async (_db: unknown, _input: unknown, checkStatus: (id: string) => Promise<unknown>) => {
        try {
          await checkStatus("provider-status-1");
          throw new Error("expected checker to throw");
        } catch (error) {
          return {
            ok: false,
            status: "prepared",
            transmissionId: "provider-status-1",
            appliedRules: [],
            errors: [error instanceof Error ? error.message : String(error)],
          };
        }
      },
    } as any);
    const checkerFailure = await throwingChecker.observePending!({
      documentId: 1, channel: "digisense", providerId: "provider-status-1",
    });
    expect(checkerFailure).toEqual(expect.objectContaining({
      status: "accepted_pending",
      providerId: "provider-status-1",
      observationFailed: true,
      message: expect.stringContaining("timeout"),
    }));
    expect(deliverCalls).toBe(0);
    db.close(); rmSync(root, { recursive: true, force: true });
  });
});
