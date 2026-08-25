import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCompany } from "../../src/core/company";
import { ingestDocument } from "../../src/core/documents";
import { openDb, migrate } from "../../src/core/db";
import { companyPaths } from "../../src/core/paths";
import { companyRootForSlug, initWorkspace } from "../../src/core/workspace";
import { handleRequest } from "../../src/server/router";
import type { ServerConfig } from "../../src/server/config";

describe("purchase VAT preflight surface parity", () => {
  test("CLI and HTTP dry-runs expose the same non-mutating DK decision", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-preflight-parity-"));
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-preflight-parity-inbox-"));
    try {
      initWorkspace(root);
      const { slug } = createCompany(root, { name: "Parity ApS" });
      const company = companyRootForSlug(root, slug);
      const db = openDb(companyPaths(company).db); migrate(db);
      const source = join(inbox, "purchase.txt"); writeFileSync(source, "Danish supplier purchase");
      const ingest = ingestDocument(db, company, source, {
        source: "test", issueDate: "2026-08-01", invoiceNo: "PARITY-1", deliveryDescription: "Test purchase", amountIncVat: 125,
        vatAmount: 25, currency: "DKK", sender: { name: "Supplier ApS", address: "Testvej 1", vatOrCvr: "DK11223344" },
        recipient: { name: "Parity ApS", address: "Testvej 2", vatOrCvr: "DK12345678" },
      });
      db.close();
      expect(ingest.ok).toBe(true);

      const cli = Bun.spawn(["bun", "run", "src/cli.ts", "expense", "vat-preflight", "--company", company, "--document-id", String(ingest.documentId)], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
      const cliBody = JSON.parse(await new Response(cli.stdout).text());
      expect(await cli.exited).toBe(0);
      expect(cliBody).toMatchObject({ ok: true, derivedRegion: "DK", requiredValidation: null, applyWouldCallProvider: false, cache: { reused: false, freshUntil: null } });

      const config: ServerConfig = { host: "127.0.0.1", port: 0, workspaceRoot: root, authRequired: false, authToken: null };
      const response = await handleRequest(new Request(`http://localhost/api/companies/${slug}/documents/${ingest.documentId}/vat-preflight`, { headers: { host: "127.0.0.1" } }), config);
      const httpBody = await response.json() as { preflight: typeof cliBody };
      expect(response.status).toBe(200);
      expect(httpBody.preflight).toMatchObject(cliBody);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(inbox, { recursive: true, force: true });
    }
  });
});
