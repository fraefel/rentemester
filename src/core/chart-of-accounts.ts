import type { Database } from "bun:sqlite";
import { insertAuditLog, type ResolveActorInput } from "./actor";
import { trimToNull } from "./ean";
import { readRuleBundleMetadata } from "./rules-metadata";

export const ACCOUNT_TYPES = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
  "vat",
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const NORMAL_BALANCES = ["debit", "credit"] as const;
export type NormalBalance = (typeof NORMAL_BALANCES)[number];

export type CreateAccountInput = {
  accountNo: string;
  name: string;
  type: AccountType | string;
  normalBalance?: NormalBalance | string | null;
  defaultVatCode?: string | null;
  allowDirectPosting?: boolean;
};

export type AccountRecord = {
  id: number;
  accountNo: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  defaultVatCode: string | null;
  allowDirectPosting: boolean;
  active: boolean;
};

type AccountRow = {
  id: number;
  account_no: string;
  name: string;
  type: string;
  normal_balance: string;
  default_vat_code: string | null;
  allow_direct_posting: number;
  active: number;
};

function rowToRecord(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    accountNo: row.account_no,
    name: row.name,
    type: row.type as AccountType,
    normalBalance: row.normal_balance as NormalBalance,
    defaultVatCode: row.default_vat_code,
    allowDirectPosting: Boolean(row.allow_direct_posting),
    active: Boolean(row.active),
  };
}

function isAccountType(value: string): value is AccountType {
  return (ACCOUNT_TYPES as readonly string[]).includes(value);
}

function isNormalBalance(value: string): value is NormalBalance {
  return (NORMAL_BALANCES as readonly string[]).includes(value);
}

function defaultNormalBalance(type: AccountType): NormalBalance {
  return type === "asset" || type === "expense" ? "debit" : "credit";
}

export function getAccountByNo(db: Database, accountNo: string): AccountRecord | null {
  const row = db
    .query(
      `SELECT id, account_no, name, type, normal_balance, default_vat_code, allow_direct_posting, active
       FROM accounts WHERE account_no = ? LIMIT 1`,
    )
    .get(accountNo) as AccountRow | null;
  return row ? rowToRecord(row) : null;
}

export type CreateAccountResult =
  | { ok: true; accountNo: string; appliedRules: string[]; errors: [] }
  | { ok: false; errors: string[] };

const RULE_ID = "DK-CHART-OF-ACCOUNTS-ADD-001";

export function createAccount(
  db: Database,
  input: CreateAccountInput,
  options: ResolveActorInput = {},
): CreateAccountResult {
  const accountNo = trimToNull(input.accountNo);
  if (!accountNo) return { ok: false, errors: ["accountNo is required"] };

  const name = trimToNull(input.name);
  if (!name) return { ok: false, errors: ["name is required"] };

  const rawType = trimToNull(input.type);
  if (!rawType) return { ok: false, errors: ["type is required"] };
  if (!isAccountType(rawType)) {
    return {
      ok: false,
      errors: [`type must be one of ${ACCOUNT_TYPES.join("|")} (got '${rawType}')`],
    };
  }
  const type: AccountType = rawType;

  let normalBalance: NormalBalance;
  const rawNormalBalance = trimToNull(input.normalBalance ?? null);
  if (rawNormalBalance) {
    if (!isNormalBalance(rawNormalBalance)) {
      return {
        ok: false,
        errors: [
          `normalBalance must be one of ${NORMAL_BALANCES.join("|")} (got '${rawNormalBalance}')`,
        ],
      };
    }
    normalBalance = rawNormalBalance;
  } else {
    normalBalance = defaultNormalBalance(type);
  }

  const defaultVatCode = trimToNull(input.defaultVatCode ?? null);
  if (defaultVatCode) {
    const canonicalVatCodes = new Set(
      readRuleBundleMetadata().flatMap((bundle) => bundle.vatCodes),
    );
    if (!canonicalVatCodes.has(defaultVatCode)) {
      return {
        ok: false,
        errors: [
          `defaultVatCode must be a canonical VAT code (got '${defaultVatCode}')`,
        ],
      };
    }
  }
  const allowDirectPosting = input.allowDirectPosting === false ? 0 : 1;

  let duplicate = false;
  try {
    db.transaction(() => {
      // The existence check belongs under the SAME IMMEDIATE writer lock as
      // the insert. Checking before BEGIN IMMEDIATE leaves a race where two
      // processes both observe absence and one leaks a raw SQLite error.
      if (getAccountByNo(db, accountNo)) {
        duplicate = true;
        return;
      }
      db.run(
        `INSERT INTO accounts (account_no, name, type, normal_balance, default_vat_code, allow_direct_posting)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [accountNo, name, type, normalBalance, defaultVatCode, allowDirectPosting],
      );
      insertAuditLog(db, {
        eventType: "accounts_add",
        entityType: "account",
        entityId: accountNo,
        message: `Added account ${accountNo} ${name} (${type}/${normalBalance})`,
        createdBy: options.createdBy,
        createdByProgram: options.createdByProgram,
      });
    }, { immediate: true })();
  } catch (error) {
    // A separate connection can still win between process scheduling and
    // BEGIN IMMEDIATE. Keep that database-level safeguard, but translate it
    // into the same stable business envelope as the in-transaction check.
    if (
      error instanceof Error &&
      /UNIQUE constraint failed:\s*accounts\.account_no/i.test(error.message)
    ) {
      duplicate = true;
    } else {
      throw error;
    }
  }

  if (duplicate) {
    return {
      ok: false,
      errors: [`account ${accountNo} already exists in the chart of accounts`],
    };
  }

  return {
    ok: true,
    accountNo,
    appliedRules: [RULE_ID],
    errors: [],
  };
}
