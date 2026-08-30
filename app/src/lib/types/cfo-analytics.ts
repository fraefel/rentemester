// Versioned, source-linked read model shared by the CFO cockpit, HTTP and MCP.

export type CfoAnalyticsScope = "company" | "portfolio" | "group";

export type CfoAnalyticsRow = {
  companySlug: string;
  sourceType: "ledger" | "archive";
  sourceHash: string;
  sourceId: string;
  journalEntryId: number | null;
  journalEntryNo: string | null;
  documentId: number | null;
  documentHash: string | null;
  partyId: string | null;
  partyName: string | null;
  accountNo: string;
  accountName: string | null;
  transactionDate: string;
  currency: string;
  amount: number;
  text: string | null;
};

export type CfoAnalyticsResult = {
  ok: true;
  schemaVersion: string;
  scope: "company" | "portfolio";
  status: "ready" | "incomplete";
  asOf: string;
  from: string;
  to: string;
  companies: string[];
  partial: boolean;
  mode: "legal-company" | "juxtaposed-non-consolidated";
  aggregate: "none" | "sum";
  limitations: string[];
  rows: CfoAnalyticsRow[];
  page: { limit: number; nextCursor: string | null };
  freshness: Array<{ source: "ledger" | "archive"; companySlug: string; latestTransactionDate: string }>;
  evidenceCompleteness: Array<{ companySlug: string; status: "ready"; postedWithoutDocument: number; openExceptions: number } | { companySlug: string; status: "unavailable"; reason: string }>;
  reconciliation: { rowCount: number; amountByCurrency?: Record<string, number>; sourceHashes: string[]; method: string; omitted?: string };
};

export type CfoGroupAnalyticsResult = {
  ok: true;
  schemaVersion: string;
  scope: "group";
  status: "ready" | "unsupported";
  asOf: string;
  limitations: string[];
  group: {
    scope?: "consolidated-report";
    status: "ready" | "blocked";
    currency?: string;
    blockers: string[];
    consolidatedFigures: null | Array<{
      lineId: string;
      label: string;
      rawCompanySum: number;
      eliminationAdjustment: number;
      consolidatedAmount: number;
    }>;
  };
};

export type CfoAnalyticsResponse = CfoAnalyticsResult | CfoGroupAnalyticsResult;
