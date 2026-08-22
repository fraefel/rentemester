#!/usr/bin/env bun
/**
 * Deliberately unsafe offline VIES fixture seeder for the disposable demos.
 *
 * This is not a VIES substitute and must never be pointed at a real company.
 */
import { Database } from "bun:sqlite";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { companyPaths } from "../src/core/paths";
import { storeViesValidation } from "../src/core/vies";

const [, , companyRoot, vatOrCvr, acknowledgement] = Bun.argv;
const UNSAFE_ACKNOWLEDGEMENT = "--unsafe-demo";
const DEMO_LEDGER_NAME = "Rentemester company";
const DEMO_ROOT_NAME = /^rentemester-(?:agent-demo|smoke)(?:-[A-Za-z0-9_-]+)?$/;

function fail(message: string): never {
  throw new Error(`Refusing offline VIES seed: ${message}`);
}

type FileIdentity = {
  path: string;
  canonicalPath: string;
  dev: number;
  ino: number;
};

type VerifiedDemoLedger = {
  root: string;
  dbPath: string;
  rootIdentity: FileIdentity;
  dataIdentity: FileIdentity;
  ledgerIdentity: FileIdentity;
};

function isContainedBy(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent !== "" && !pathFromParent.startsWith("..") && !pathFromParent.startsWith("../");
}

function snapshotPath(path: string, label: string, expectedKind: "directory" | "file"): FileIdentity {
  let stat: Stats;
  let canonicalPath: string;
  try {
    stat = lstatSync(path);
    canonicalPath = realpathSync(path);
  } catch {
    fail(`${label} must already exist`);
  }
  if (stat!.isSymbolicLink()) fail(`${label} must not be a symlink`);
  if (expectedKind === "directory" ? !stat!.isDirectory() : !stat!.isFile()) {
    fail(`${label} must be a ${expectedKind}`);
  }
  return { path, canonicalPath: canonicalPath!, dev: stat!.dev, ino: stat!.ino };
}

function assertUnchanged(snapshot: FileIdentity, label: string, expectedKind: "directory" | "file") {
  const current = snapshotPath(snapshot.path, label, expectedKind);
  if (current.canonicalPath !== snapshot.canonicalPath) {
    fail(`${label} canonical path changed while opening the ledger`);
  }
  // Node exposes device/inode on the platforms Bun supports. Keep the check
  // conditional so unusual filesystems without stable values stay fail-closed
  // on path checks instead of being misidentified by a sentinel value.
  if (snapshot.dev !== 0 && snapshot.ino !== 0 && current.dev !== 0 && current.ino !== 0 &&
    (current.dev !== snapshot.dev || current.ino !== snapshot.ino)) {
    fail(`${label} identity changed while opening the ledger`);
  }
  return current;
}

function verifySyntheticLedgerIdentity(db: Database) {
  const company = db.query("SELECT name, cvr FROM companies WHERE id = 1").get() as
    | { name: string; cvr: string | null }
    | null;
  const initialized = db.query(
    "SELECT 1 FROM audit_log WHERE event_type = 'init' AND entity_type = 'company' AND message = 'Company volume initialized' LIMIT 1",
  ).get();
  if (!company || company.name !== DEMO_LEDGER_NAME || company.cvr !== null || !initialized) {
    fail("ledger identity is not the unregistered synthetic Rentemester demo/smoke ledger");
  }
}

function verifyDisposableDemoLedger(inputRoot: string): VerifiedDemoLedger {
  if (acknowledgement !== UNSAFE_ACKNOWLEDGEMENT) {
    fail(`pass ${UNSAFE_ACKNOWLEDGEMENT} to acknowledge synthetic demo data`);
  }

  const suppliedRoot = resolve(inputRoot);
  const rootIdentity = snapshotPath(suppliedRoot, "company root", "directory");
  let canonicalRoot: string;
  let canonicalTmp: string;
  try {
    canonicalRoot = rootIdentity.canonicalPath;
    canonicalTmp = realpathSync(tmpdir());
  } catch {
    fail("company root and temporary directory must already exist");
  }

  // `/tmp` itself is a symlink on some platforms, so compare canonical parents
  // and explicitly reject an indirection at the supplied company root.
  if (realpathSync(dirname(suppliedRoot)) !== canonicalTmp) {
    fail("company root must be a canonical path; symlink indirection is not allowed");
  }
  if (dirname(canonicalRoot) !== canonicalTmp || !DEMO_ROOT_NAME.test(basename(canonicalRoot))) {
    fail("company root must be a disposable /tmp/rentemester-agent-demo-* or /tmp/rentemester-smoke-* ledger");
  }

  const dbPath = companyPaths(canonicalRoot).db;
  const dataIdentity = snapshotPath(companyPaths(canonicalRoot).data, "data directory", "directory");
  const ledgerIdentity = snapshotPath(dbPath, "ledger file", "file");
  if (lstatSync(dbPath).nlink !== 1) {
    fail("ledger file must not have hard links");
  }
  if (!isContainedBy(canonicalRoot, dataIdentity.canonicalPath) ||
    !isContainedBy(dataIdentity.canonicalPath, ledgerIdentity.canonicalPath) ||
    ledgerIdentity.canonicalPath !== dbPath) {
    fail("data directory and ledger file must remain canonically contained by the company root");
  }
  return { root: canonicalRoot, dbPath, rootIdentity, dataIdentity, ledgerIdentity };
}

function verifyOpenedLedger(db: Database, ledger: VerifiedDemoLedger) {
  const main = (db.query("PRAGMA database_list").all() as Array<{ name: string; file: string }>)
    .find((entry) => entry.name === "main");
  if (!main?.file || resolve(main.file) !== ledger.dbPath) {
    fail("opened database path does not match the verified ledger path");
  }
  assertUnchanged(ledger.rootIdentity, "company root", "directory");
  assertUnchanged(ledger.dataIdentity, "data directory", "directory");
  const currentLedger = assertUnchanged(ledger.ledgerIdentity, "ledger file", "file");
  if (lstatSync(ledger.dbPath).nlink !== 1) {
    fail("ledger file must not have hard links");
  }
  verifySyntheticLedgerIdentity(db);
}

if (!companyRoot || !vatOrCvr) {
  fail("Usage: bun run scripts/seed-vies-validation.ts <company-root> <EU-VAT> --unsafe-demo");
}

try {
  const ledger = verifyDisposableDemoLedger(companyRoot);
  const db = new Database(ledger.dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 30000;");
    const validation = db.transaction(() => {
      verifyOpenedLedger(db, ledger);
      return storeViesValidation(db, {
        vatOrCvr,
        valid: true,
        rawResponse: JSON.stringify({ valid: true, source: "unsafe-offline-demo-seed" }),
      });
    }, { immediate: true })();
    console.log(JSON.stringify({ ok: true, validation }, null, 2));
  } finally {
    db.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Refusing offline VIES seed: unknown error");
  process.exitCode = 2;
}
