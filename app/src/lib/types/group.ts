/** Structure/status-only group overview. Financial consolidation is absent. */
export type GroupOverview = {
  ok: true;
  scope: "structure-status-only";
  consolidationStatus: "not-available";
  consolidatedFigures: null;
  rawCompanySums: null;
  blockers: string[];
  manifestStatus: "not-configured" | "ready" | "blocked";
  asOf: string;
  groups: Array<{
    partial: boolean;
    id?: string;
    name?: string;
    visibleMemberships: Array<{
      id: string;
      companySlug: string;
      validFrom: string;
      validToExclusive?: string;
      archived: boolean;
    }>;
    visibleOwnership: Array<{
      id: string;
      parentCompanySlug: string;
      childCompanySlug: string;
      basisPoints: number;
      validFrom: string;
      validToExclusive?: string;
      evidenceRefs: string[];
    }>;
    readiness: "ready" | "blocked";
    blockers: string[];
  }>;
};

export type IntercompanySide = {
  companySlug: string;
  currency: string;
  position: "receivable" | "payable";
  balance: number;
  accountNos: string[];
  sourceRefs: Array<{ entryId: number; entryNo: string; lineId: number; accountNo: string; transactionDate: string; amount: number }>;
  sourceSnapshot: { ledgerHeadHash: string | null; entryCount: number; selectionHash: string };
};

export type IntercompanyReconciliation = {
  ok: true;
  scope: "intercompany-reconciliation";
  asOf: string;
  rows: Array<{
    mappingId?: string;
    mappingHash?: string;
    left?: IntercompanySide;
    right?: IntercompanySide;
    status: "matched" | "mismatch" | "not-comparable";
    difference?: number;
    reason: "exact-native-currency-difference" | "currency-mismatch" | "blocked";
    blockers: string[];
  }>;
};

export type ConsolidationEliminations = {
  ok: true;
  scope: "consolidation-eliminations";
  asOf: string;
  rows: Array<{
    status: "applied" | "blocked";
    eliminationId?: string;
    payloadHash?: string;
    eventHash?: string;
    blockers: string[];
    payload?: {
      kind: "intercompany-balance";
      mappingId: string;
      currency: string;
      amountOre: string;
      left: { companySlug: string };
      right: { companySlug: string };
    };
  }>;
};

export type ConsolidatedReport = {
  ok: true;
  scope: "consolidated-report";
  status: "ready" | "blocked";
  profileId?: string;
  profileHash?: string;
  groupId?: string;
  period: { from: string; to: string };
  currency?: string;
  blockers: string[];
  rawCompanySums: Array<{ lineId: string; byCompany: Array<{ companySlug: string; amount: number; sourceHashes: string[] }>; total: number }>;
  appliedEliminations: Array<{ eliminationId: string; payloadHash: string; adjustments: Array<{ lineId: string; amount: number }> }>;
  consolidatedFigures: null | Array<{ lineId: string; label: string; section: "asset" | "liability" | "equity" | "income" | "expense"; rawCompanySum: number; eliminationAdjustment: number; consolidatedAmount: number }>;
  sourceSnapshots: Array<{ companySlug: string; ledgerHeadHash: string | null; entryCount: number }>;
};

export type ConsolidationReportProfiles = {
  ok: true;
  scope: "consolidation-report-profiles";
  asOf: string;
  profiles: Array<{
    id: string;
    groupId: string;
    currency: string;
    validFrom: string;
    validToExclusive?: string;
  }>;
};
