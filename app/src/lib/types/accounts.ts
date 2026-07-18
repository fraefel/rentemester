// #344 — Kontoplan-view (read-only).

export type AccountRow = {
  accountNo: string;
  name: string;
  type: string;
  normalBalance: string;
  defaultVatCode: string | null;
  hasPostings: boolean;
};

/** The bookkeeping role a chart-of-accounts mapping serves. */
export type AccountRole =
  | "bank"
  | "debtors"
  | "creditors"
  | "output_vat"
  | "input_vat"
  | "reverse_charge_vat"
  | "vat_settlement"
  | "operational_default";

/** The server's read-only, fail-closed role lookup (a dry run, not a write). */
export type AccountRoleResolution =
  | { ok: true; role: AccountRole; accountNo: string; version: number }
  | { ok: false; role: AccountRole; error: string };

export type AccountRoles = {
  status: "complete" | "incomplete" | "ambiguous";
  missing: AccountRole[];
  ambiguous: AccountRole[];
  resolutions: AccountRoleResolution[];
};

export type CompanyAccounts = {
  slug: string;
  company: {
    name: string;
    cvr: string | null;
    country: string;
    currency: string;
  };
  accounts: AccountRow[];
  byType: Record<string, number>;
  /** Confirmed account-role mappings and their read-only resolution preview. */
  accountRoles: AccountRoles;
};

export type AccountsResponse = {
  ok: true;
  accounts: CompanyAccounts;
};
