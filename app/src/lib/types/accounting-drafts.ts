export type AccountingDraftLine = {
  accountNo: string;
  debitAmount?: number;
  creditAmount?: number;
  vatCode?: string;
  text?: string;
};

export type AccountingDraftPayload = {
  transactionDate: string;
  text: string;
  documentId?: number;
  sourceBankTransactionId?: number;
  currency?: string;
  amountForeign?: number;
  amountDkk?: number;
  fxRateToDkk?: number;
  lines: AccountingDraftLine[];
};

export type AccountingDraftStatus =
  | "created"
  | "revised"
  | "submitted"
  | "rejected"
  | "approved_posted";

export type AccountingDraft = {
  id: string;
  version: number;
  status: AccountingDraftStatus;
  payloadHash: string;
  eventHash: string;
  payload: AccountingDraftPayload;
  actorId: string;
  reason?: string;
  journalEntryId?: number;
  journal?: {
    ok: boolean;
    entryId?: number;
    entryNo?: string;
    entryHash?: string;
  };
};
