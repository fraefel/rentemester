// Tests: src/core/db.ts — EJER-3 customers payment_terms_days rebuild-migrering.
//
// EJER-3 gjorde customers.payment_terms_days nullable. SQLite kan ikke fjerne
// NOT NULL in-place, så migrate() rebuilder tabellen (CREATE rebuild → kopiér →
// DROP customers → RENAME). Disse tests dækker selve rebuild-grenen
// (notnull===1) — som den eksisterende EJER-3-test aldrig rammer, fordi den
// starter fra en allerede-migreret nullable DB — plus crash-sikkerhed:
//   (a) legacy NOT NULL → nullable, alle værdier (inkl. bevidst 30) bevaret;
//   (b) idempotens (migrate to gange);
//   (c) crash-recovery: en efterladt rebuild-tabel må ikke blokere migrate();
//   (d) data/struktur-integritet bevaret.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";

// Det præcise legacy-skema for `customers` fra før EJER-3: payment_terms_days
// er NOT NULL DEFAULT 30. Det er denne form rebuild-grenen skal relaxe.
function createLegacyCustomersTable(db: Database) {
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT,
      vat_or_cvr TEXT,
      email TEXT,
      ean_number TEXT,
      payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK(payment_terms_days > 0),
      default_currency TEXT NOT NULL DEFAULT 'DKK',
      notes TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(vat_or_cvr, name)
    );
  `);
}

function paymentTermsNotNull(db: Database): number {
  const col = (db.query(`PRAGMA table_info(customers)`).all() as Array<{ name: string; notnull: number }>)
    .find((c) => c.name === "payment_terms_days");
  return col!.notnull;
}

function freshLegacyDb() {
  const root = mkdtempSync(join(tmpdir(), "rentemester-customers-migration-"));
  const db = openDb(ensureCompanyDirs(root).db);
  createLegacyCustomersTable(db);
  return { root, db };
}

describe("EJER-3 customers payment_terms_days rebuild (db.migrate)", () => {
  test("(a) legacy NOT NULL becomes nullable and every stored value (incl. a deliberate 30) is preserved", () => {
    const { root, db } = freshLegacyDb();

    db.run(`INSERT INTO customers (name, payment_terms_days) VALUES ('Kunde 30', 30)`);
    db.run(`INSERT INTO customers (name, payment_terms_days) VALUES ('Kunde 14', 14)`);
    db.run(`INSERT INTO customers (name, payment_terms_days) VALUES ('Kunde 8', 8)`);

    // Sanity: før migrering ER kolonnen NOT NULL (rebuild-grenen rammes).
    expect(paymentTermsNotNull(db)).toBe(1);

    migrate(db);

    // Efter migrering er kolonnen nullable.
    expect(paymentTermsNotNull(db)).toBe(0);

    const rows = db.query(
      `SELECT name, payment_terms_days FROM customers ORDER BY name`,
    ).all() as Array<{ name: string; payment_terms_days: number | null }>;
    expect(rows).toEqual([
      { name: "Kunde 14", payment_terms_days: 14 },
      { name: "Kunde 30", payment_terms_days: 30 }, // bevidst 30 bevares, ikke nulstillet
      { name: "Kunde 8", payment_terms_days: 8 },
    ]);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("(b) migrate is idempotent — a second run leaves the table and its data untouched", () => {
    const { root, db } = freshLegacyDb();
    db.run(`INSERT INTO customers (name, payment_terms_days) VALUES ('Kunde A', 21)`);

    migrate(db);
    migrate(db); // anden kørsel må ikke vælte (rebuild-grenen rammes ikke længere)

    expect(paymentTermsNotNull(db)).toBe(0);
    const row = db.query(
      `SELECT payment_terms_days FROM customers WHERE name = 'Kunde A'`,
    ).get() as { payment_terms_days: number | null };
    expect(row.payment_terms_days).toBe(21);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("(c) crash-recovery: a leftover customers_payment_terms_rebuild table does not block migrate", () => {
    const { root, db } = freshLegacyDb();
    db.run(`INSERT INTO customers (name, payment_terms_days) VALUES ('Overlevende', 14)`);

    // Simulér et tidligere afbrudt rebuild: rebuild-tabellen blev skabt, men
    // processen døde før DROP/RENAME. Uden DROP TABLE IF EXISTS ville den næste
    // migrate() kaste "table customers_payment_terms_rebuild already exists".
    db.exec(`
      CREATE TABLE customers_payment_terms_rebuild (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        address TEXT,
        vat_or_cvr TEXT,
        email TEXT,
        phone TEXT,
        website TEXT,
        ean_number TEXT,
        payment_terms_days INTEGER CHECK(payment_terms_days IS NULL OR payment_terms_days > 0),
        default_currency TEXT NOT NULL DEFAULT 'DKK',
        notes TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(vat_or_cvr, name)
      );
    `);

    expect(() => migrate(db)).not.toThrow();

    expect(paymentTermsNotNull(db)).toBe(0);
    const row = db.query(
      `SELECT payment_terms_days FROM customers WHERE name = 'Overlevende'`,
    ).get() as { payment_terms_days: number | null };
    expect(row.payment_terms_days).toBe(14);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("(d) data/structure integrity — all customer columns survive the rebuild", () => {
    const { root, db } = freshLegacyDb();
    db.run(
      `INSERT INTO customers (name, address, vat_or_cvr, email, ean_number, payment_terms_days, default_currency, notes, archived)
       VALUES ('Fuld Kunde', 'Vej 1', 'DK12345678', 'k@x.dk', '5790000000000', 30, 'EUR', 'note', 1)`,
    );

    migrate(db);

    const row = db.query(
      `SELECT name, address, vat_or_cvr, email, ean_number, payment_terms_days, default_currency, notes, archived
       FROM customers WHERE name = 'Fuld Kunde'`,
    ).get() as Record<string, unknown>;
    expect(row).toEqual({
      name: "Fuld Kunde",
      address: "Vej 1",
      vat_or_cvr: "DK12345678",
      email: "k@x.dk",
      ean_number: "5790000000000",
      payment_terms_days: 30,
      default_currency: "EUR",
      notes: "note",
      archived: 1,
    });

    // Den nye nullable CHECK håndhæves: 0/negativ afvises, NULL tillades.
    expect(() =>
      db.run(`INSERT INTO customers (name, payment_terms_days) VALUES ('Ugyldig', 0)`),
    ).toThrow();
    db.run(`INSERT INTO customers (name, payment_terms_days) VALUES ('Arver', NULL)`);
    const inherited = db.query(
      `SELECT payment_terms_days FROM customers WHERE name = 'Arver'`,
    ).get() as { payment_terms_days: number | null };
    expect(inherited.payment_terms_days).toBeNull();

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
