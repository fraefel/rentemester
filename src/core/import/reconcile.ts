// Import framework — chart-of-accounts & company-master-data reconciliation.
// Issue #193 (epic #173).
//
// A parser turns an export into a normalised `ImportSource`. Reconciliation
// LANDS that source into the live company ledger:
//
//  - `reconcileChartOfAccounts` walks `source.chartOfAccounts` and, for each
//    account, INSERTs it into the `accounts` table if it is missing. When a
//    system migration brings over a foreign chart of accounts the SOURCE is
//    authoritative: an existing account that carries NO journal lines yet is
//    safely RECLASSIFIED to the source's type / normal_balance / name /
//    default_vat_code. An existing account that already HAS journal lines must
//    not be reclassified — it is reported as a conflict instead. This is the
//    prerequisite that lets #194 post a Dinero opening balance, because
//    `postOpeningBalance` re-validates every line against the live `accounts`.
//
//  - `reconcileCompanyMasterData` populates the `companies` row (id = 1) from
//    `source.companyMasterData`. A non-empty field is never overwritten unless
//    `overwrite` is explicitly requested.
//
// Both are DETERMINISTIC and AUDITED: accounts are processed in source order,
// and an `audit_log` row records what each reconciliation did.

import type { Database } from "bun:sqlite";
import { insertAuditLog, type ResolveActorInput } from "../actor";
import { normalizeCvr } from "../company";
import type {
  ChartReconciliationResult,
  CompanyReconciliationResult,
  ImportSource,
} from "./types";
import { persistAccountRoleProposals } from "../account-roles";

const CHART_RULE = "DK-IMPORT-CHART-RECONCILE-001";
const COMPANY_RULE = "DK-IMPORT-COMPANY-RECONCILE-001";

type ReconcileOptions = ResolveActorInput;

/**
 * Reconciles `source.chartOfAccounts` into the live `accounts` table: creates
 * accounts that do not yet exist, RECLASSIFIES an existing postings-free
 * account to the source definition (the source chart is authoritative for a
 * system migration), reports an existing account that already has journal
 * lines as a conflict, and surfaces every unmapped VAT code. Returns a
 * deterministic summary; the operation is wrapped in a single transaction and
 * audited.
 */
export function reconcileChartOfAccounts(
  db: Database,
  source: ImportSource,
  options: ReconcileOptions = {},
): ChartReconciliationResult {
  const chart = Array.isArray(source?.chartOfAccounts) ? source.chartOfAccounts : [];
  const created: string[] = [];
  const existing: string[] = [];
  const updated: string[] = [];
  const differences: string[] = [];
  const conflicts: string[] = [];

  const findAccount = db.prepare(
    "SELECT id, name, type, normal_balance, default_vat_code FROM accounts WHERE account_no = ?",
  );
  const insertAccount = db.prepare(
    "INSERT INTO accounts (account_no, name, type, normal_balance, default_vat_code) VALUES (?, ?, ?, ?, ?)",
  );
  const countJournalLines = db.prepare(
    "SELECT COUNT(*) AS n FROM journal_lines WHERE account_id = ?",
  );
  const updateAccount = db.prepare(
    "UPDATE accounts SET name = ?, type = ?, normal_balance = ?, default_vat_code = ? WHERE id = ?",
  );

  db.transaction(() => {
    for (const account of chart) {
      const accountNo = typeof account?.accountNo === "string" ? account.accountNo.trim() : "";
      if (!accountNo) continue;
      const live = findAccount.get(accountNo) as
        | {
            id: number;
            name: string;
            type: string;
            normal_balance: string;
            default_vat_code: string | null;
          }
        | null;

      if (live) {
        existing.push(accountNo);
        // Detect what differs from the source.
        const sourceName = account.name?.trim() || live.name;
        const sourceType = account.normalizedType ?? live.type;
        const sourceNormalBalance = account.normalBalance ?? live.normal_balance;
        const sourceVat =
          account.defaultVatCode !== undefined
            ? account.defaultVatCode ?? null
            : live.default_vat_code ?? null;
        const mismatch: string[] = [];
        if (sourceName !== live.name) {
          mismatch.push(`name ('${live.name}' -> '${sourceName}')`);
        }
        if (sourceType !== live.type) {
          mismatch.push(`type ('${live.type}' -> '${sourceType}')`);
        }
        if (sourceNormalBalance !== live.normal_balance) {
          mismatch.push(`normal_balance ('${live.normal_balance}' -> '${sourceNormalBalance}')`);
        }
        if (sourceVat !== (live.default_vat_code ?? null)) {
          mismatch.push(
            `default_vat_code ('${live.default_vat_code ?? ""}' -> '${sourceVat ?? ""}')`,
          );
        }
        if (mismatch.length === 0) continue;

        // The source chart is authoritative for a system migration — but only
        // an account with NO journal lines can be safely reclassified.
        const lineCount = (countJournalLines.get(live.id) as { n: number }).n;
        if (lineCount > 0) {
          conflicts.push(
            `account ${accountNo}: source differs (${mismatch.join(", ")}) but the ` +
              `account already has ${lineCount} journal line(s) — kept live, not reclassified`,
          );
          continue;
        }
        updateAccount.run(sourceName, sourceType, sourceNormalBalance, sourceVat, live.id);
        updated.push(accountNo);
        differences.push(
          `account ${accountNo}: reclassified to source — ${mismatch.join(", ")}`,
        );
        continue;
      }

      // Missing account: create it. A classified source account carries the
      // Rentemester type / normal balance; anything unclassified is rejected.
      if (!account.normalizedType || !account.normalBalance) {
        differences.push(
          `account ${accountNo}: not created — source did not classify it onto a Rentemester account type`,
        );
        continue;
      }
      insertAccount.run(
        accountNo,
        account.name?.trim() || `Konto ${accountNo}`,
        account.normalizedType,
        account.normalBalance,
        account.defaultVatCode ?? null,
      );
      created.push(accountNo);
    }

    const roleProposalResult = persistAccountRoleProposals(db, source.accountRoleProposals ?? []);

    insertAuditLog(db, {
      eventType: "import_chart_reconcile",
      entityType: "accounts",
      message:
        `Reconciled chart of accounts from '${source.sourceSystem}': ` +
        `${created.length} created, ${existing.length} already present, ` +
        `${updated.length} reclassified, ${conflicts.length} conflict(s); ` +
        `${roleProposalResult.stored} account-role proposal(s) recorded, ` +
        `${roleProposalResult.reviewRequired.length} native role(s) deactivated for review`,
      createdBy: options.createdBy,
      createdByProgram: options.createdByProgram,
    });
  })();

  const unmappedVatCodes = Array.isArray(source?.unmappedVatCodes)
    ? [...source.unmappedVatCodes]
    : [];

  return { created, existing, updated, differences, conflicts, unmappedVatCodes };
}

/**
 * Reconciles `source.companyMasterData` into the `companies` row (id = 1).
 * Creates the row if it does not exist; otherwise populates only the fields
 * that are currently empty. A non-empty field is left intact unless
 * `options.overwrite` is set. Returns a deterministic summary and is audited.
 *
 * Note: the `companies` schema stores `name` and `cvr` only. Address / city /
 * email and the other Dinero `Firmaoplysninger.csv` fields have no column —
 * they are carried in the audit message so the migration stays traceable.
 */
export function reconcileCompanyMasterData(
  db: Database,
  source: ImportSource,
  options: ReconcileOptions & { overwrite?: boolean } = {},
): CompanyReconciliationResult {
  const md = source?.companyMasterData;
  const updatedFields: string[] = [];
  const notes: string[] = [];
  if (!md) {
    return { updatedFields, notes: ["source carried no company master data"] };
  }

  // Normalise the CVR up front so an invalid value fails loudly here rather
  // than silently writing junk into the ledger.
  let cvr: string | null = null;
  if (md.cvr) {
    try {
      cvr = normalizeCvr(md.cvr);
    } catch {
      notes.push(`cvr '${md.cvr}' is not a valid Danish CVR — skipped`);
    }
  }

  db.transaction(() => {
    const row = db
      .query("SELECT name, cvr FROM companies WHERE id = 1")
      .get() as { name: string | null; cvr: string | null } | null;

    const setName = (value: string, current: string | null): boolean => {
      const isDefault = !current || current.trim() === "" || current === "Rentemester company";
      if (!isDefault && !options.overwrite) {
        notes.push(`name kept ('${current}') — source value '${value}' not applied`);
        return false;
      }
      return true;
    };
    const setCvr = (current: string | null): boolean => {
      if (current && current.trim() !== "" && !options.overwrite) {
        notes.push(`cvr kept ('${current}') — source value not applied`);
        return false;
      }
      return true;
    };

    if (!row) {
      // No company row yet — create it directly from the source.
      const name = md.name?.trim() || "Rentemester company";
      db.prepare("INSERT INTO companies (id, name, cvr) VALUES (1, ?, ?)").run(name, cvr);
      if (md.name?.trim()) updatedFields.push("name");
      if (cvr) updatedFields.push("cvr");
    } else {
      const applyName = md.name?.trim() ? setName(md.name.trim(), row.name) : false;
      const applyCvr = cvr ? setCvr(row.cvr) : false;
      if (applyName) {
        db.prepare("UPDATE companies SET name = ? WHERE id = 1").run(md.name!.trim());
        updatedFields.push("name");
      }
      if (applyCvr) {
        db.prepare("UPDATE companies SET cvr = ? WHERE id = 1").run(cvr);
        updatedFields.push("cvr");
      }
    }

    // Schema has no columns for these — record them for the audit trail.
    const carried: string[] = [];
    if (md.address) carried.push(`address='${md.address}'`);
    if (md.postalCode || md.city) carried.push(`city='${[md.postalCode, md.city].filter(Boolean).join(" ")}'`);
    if (md.email) carried.push(`email='${md.email}'`);
    if (md.phone) carried.push(`phone='${md.phone}'`);
    if (md.website) carried.push(`website='${md.website}'`);

    insertAuditLog(db, {
      eventType: "import_company_reconcile",
      entityType: "company",
      entityId: 1,
      message:
        `Reconciled company master data from '${source.sourceSystem}': ` +
        `updated [${updatedFields.join(", ") || "nothing"}]` +
        (carried.length > 0 ? `; export also carried ${carried.join(", ")}` : ""),
      createdBy: options.createdBy,
      createdByProgram: options.createdByProgram,
    });
  })();

  return { updatedFields, notes };
}

/** Stable rule identifiers for the reconciliation steps. */
export const RECONCILE_RULES = { CHART: CHART_RULE, COMPANY: COMPANY_RULE } as const;
