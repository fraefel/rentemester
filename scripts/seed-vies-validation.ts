#!/usr/bin/env bun
/**
 * Deliberately unsafe offline VIES fixture seeder for the disposable demos.
 *
 * This is not a VIES substitute and must never be pointed at a real company.
 */
import { Database } from "bun:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { openDb, migrate } from "../src/core/db";
import { companyPaths } from "../src/core/paths";
import { storeViesValidation } from "../src/core/vies";

const [, , companyRoot, vatOrCvr, acknowledgement] = Bun.argv;
const UNSAFE_ACKNOWLEDGEMENT = "--unsafe-demo";
const DEMO_LEDGER_NAME = "Rentemester company";
const DEMO_ROOT_NAME = /^rentemester-(?:agent-demo|smoke)(?:-[A-Za-z0-9_-]+)?$/;

function fail(message: string): never {
  console.error(`Refusing offline VIES seed: ${message}`);
  process.exit(2);
}

function verifyDisposableDemoLedger(inputRoot: string): string {
  if (acknowledgement !== UNSAFE_ACKNOWLEDGEMENT) {
    fail(`pass ${UNSAFE_ACKNOWLEDGEMENT} to acknowledge synthetic demo data`);
  }

  let canonicalRoot: string;
  let canonicalTmp: string;
  try {
    canonicalRoot = realpathSync(inputRoot);
    canonicalTmp = realpathSync(tmpdir());
  } catch {
    fail("company root and temporary directory must already exist");
  }

  // `/tmp` itself is a symlink on some platforms, so compare canonical parents
  // and explicitly reject an indirection at the supplied company root.
  if (lstatSync(inputRoot).isSymbolicLink() || realpathSync(dirname(resolve(inputRoot))) !== canonicalTmp) {
    fail("company root must be a canonical path; symlink indirection is not allowed");
  }
  if (dirname(canonicalRoot) !== canonicalTmp || !DEMO_ROOT_NAME.test(basename(canonicalRoot))) {
    fail("company root must be a disposable /tmp/rentemester-agent-demo-* or /tmp/rentemester-smoke-* ledger");
  }

  const dbPath = companyPaths(canonicalRoot).db;
  let readOnly: Database;
  try {
    readOnly = new Database(dbPath, { readonly: true });
  } catch {
    fail("company root is not an initialized ledger");
  }
  try {
    const company = readOnly.query("SELECT name, cvr FROM companies WHERE id = 1").get() as
      | { name: string; cvr: string | null }
      | null;
    const initialized = readOnly.query(
      "SELECT 1 FROM audit_log WHERE event_type = 'init' AND entity_type = 'company' AND message = 'Company volume initialized' LIMIT 1",
    ).get();
    if (!company || company.name !== DEMO_LEDGER_NAME || company.cvr !== null || !initialized) {
      fail("ledger identity is not the unregistered synthetic Rentemester demo/smoke ledger");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing offline VIES seed:")) throw error;
    fail(`ledger identity could not be verified${error instanceof Error ? `: ${error.message}` : ""}`);
  } finally {
    readOnly.close();
  }
  return canonicalRoot;
}

if (!companyRoot || !vatOrCvr) {
  console.error("Usage: bun run scripts/seed-vies-validation.ts <company-root> <EU-VAT> --unsafe-demo");
  process.exit(2);
}

const verifiedRoot = verifyDisposableDemoLedger(companyRoot);
const db = openDb(companyPaths(verifiedRoot).db);
migrate(db);
const validation = storeViesValidation(db, {
  vatOrCvr,
  valid: true,
  rawResponse: JSON.stringify({ valid: true, source: "unsafe-offline-demo-seed" }),
});
db.close();
console.log(JSON.stringify({ ok: true, validation }, null, 2));
