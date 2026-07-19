CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_by_version TEXT NOT NULL,
  applied_by_commit TEXT
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'Unnamed company',
  country TEXT NOT NULL DEFAULT 'DK',
  currency TEXT NOT NULL DEFAULT 'DKK',
  cvr TEXT,
  fiscal_year_start_month INTEGER NOT NULL DEFAULT 1 CHECK(fiscal_year_start_month BETWEEN 1 AND 12),
  fiscal_year_label_strategy TEXT NOT NULL DEFAULT 'end-year' CHECK(fiscal_year_label_strategy IN ('end-year', 'start-year', 'span')),
  -- CVR-register stamdata, snapshotted by `company sync-cvr`. All nullable —
  -- the company works fully offline; these are only an enrichment.
  address TEXT,
  postal_code TEXT,
  city TEXT,
  company_form TEXT,
  industry_code TEXT,
  industry_text TEXT,
  cvr_status TEXT,
  audit_waived INTEGER,
  cvr_synced_at TEXT,
  -- #221: the owner's own default payment terms (days from issue to due date).
  -- Captured once on the company profile so every issued invoice inherits it.
  payment_terms_days INTEGER NOT NULL DEFAULT 14 CHECK(payment_terms_days BETWEEN 0 AND 365),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  account_no TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('asset','liability','equity','income','expense','vat')),
  normal_balance TEXT NOT NULL CHECK(normal_balance IN ('debit','credit')),
  active INTEGER NOT NULL DEFAULT 1,
  default_vat_code TEXT,
  allow_direct_posting INTEGER NOT NULL DEFAULT 1
);

-- #544: semantic roles are deliberately independent from account numbers.
-- Imported charts often use different numbering, so a role can only be used
-- after a human-confirmed mapping has passed the central compatibility check.
CREATE TABLE IF NOT EXISTS account_role_mappings (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('bank','debtors','creditors','output_vat','input_vat','reverse_charge_vat','vat_settlement','operational_default')),
  account_no TEXT NOT NULL REFERENCES accounts(account_no),
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','superseded','inactive')),
  version INTEGER NOT NULL,
  confirmed_by TEXT NOT NULL,
  confirmation_source TEXT NOT NULL DEFAULT 'explicit' CHECK(confirmation_source IN ('native_seed','explicit')),
  confirmed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(role, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_role_one_active_confirmed
ON account_role_mappings(role) WHERE status = 'confirmed';

-- Importers can suggest mappings, but suggestions never become posting input.
CREATE TABLE IF NOT EXISTS account_role_proposals (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('bank','debtors','creditors','output_vat','input_vat','reverse_charge_vat','vat_settlement','operational_default')),
  account_no TEXT NOT NULL REFERENCES accounts(account_no),
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','rejected','accepted')),
  proposed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(role, account_no, source)
);

CREATE TABLE IF NOT EXISTS sequences (
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  value INTEGER NOT NULL CHECK(value >= 0),
  PRIMARY KEY (kind, scope)
);

CREATE TABLE IF NOT EXISTS vies_validations (
  country_code TEXT NOT NULL,
  vat_number TEXT NOT NULL,
  valid INTEGER NOT NULL,
  name TEXT,
  address TEXT,
  validated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  raw_response TEXT,
  PRIMARY KEY (country_code, vat_number)
);

-- ===== CVR LOOKUP CACHE (CVR-register) =====
-- Snapshot cache for the Danish CVR register (distribution.virk.dk). CVR data
-- is non-deterministic external network data, so it is NEVER read live during
-- bookkeeping — a lookup writes one snapshot row here, stamped with fetched_at,
-- and every later read is served from this table. Like vies_validations this is
-- a deliberately MUTABLE cache (re-lookup overwrites via ON CONFLICT) — it has
-- no append-only trigger. The CVR number is stored as 8 digits, no DK prefix.
CREATE TABLE IF NOT EXISTS cvr_lookups (
  cvr TEXT PRIMARY KEY,
  name TEXT,
  address TEXT,
  postal_code TEXT,
  city TEXT,
  municipality_code INTEGER,
  company_form_code INTEGER,
  company_form_short TEXT,
  company_form_long TEXT,
  status TEXT,
  industry_code TEXT,
  industry_text TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  start_date TEXT,
  fiscal_year_start TEXT,
  fiscal_year_end TEXT,
  audit_waived INTEGER,
  share_capital NUMERIC,
  share_capital_currency TEXT,
  employees INTEGER,
  advertising_protected INTEGER NOT NULL DEFAULT 0,
  management_json TEXT,
  raw_response TEXT,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
-- ===== END CVR LOOKUP CACHE =====

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  vat_or_cvr TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  ean_number TEXT,
  -- EJER-3: NULL = ingen eksplicit kundefrist — fakturaen arver virksomhedens
  -- profilfrist (companies.payment_terms_days) på fakturatidspunktet.
  payment_terms_days INTEGER CHECK(payment_terms_days IS NULL OR payment_terms_days > 0),
  default_currency TEXT NOT NULL DEFAULT 'DKK',
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(vat_or_cvr, name)
);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  vat_or_cvr TEXT,
  country_code TEXT,
  identifier_kind TEXT CHECK(identifier_kind IN ('dk_cvr','eu_vat','non_eu')),
  identity_status TEXT NOT NULL DEFAULT 'human_resolution_required' CHECK(identity_status IN ('resolved','human_resolution_required')),
  email TEXT,
  phone TEXT,
  website TEXT,
  default_expense_account TEXT,
  default_vat_treatment TEXT,
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(vat_or_cvr, name)
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  document_no TEXT UNIQUE,
  source TEXT NOT NULL,
  original_filename TEXT,
  stored_path TEXT,
  mime_type TEXT,
  sha256_hash TEXT NOT NULL UNIQUE,
  upload_datetime TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  supplier_name TEXT,
  invoice_no TEXT,
  invoice_date TEXT,
  amount_inc_vat NUMERIC,
  currency TEXT NOT NULL DEFAULT 'DKK',
  status TEXT NOT NULL DEFAULT 'ingested',
  document_type TEXT NOT NULL DEFAULT 'purchase_sale',
  delivery_description TEXT,
  sender_name TEXT,
  sender_address TEXT,
  sender_vat_cvr TEXT,
  supplier_country_code TEXT,
  supplier_identifier_kind TEXT CHECK(supplier_identifier_kind IN ('dk_cvr','eu_vat','non_eu')),
  supplier_identity_status TEXT CHECK(supplier_identity_status IN ('resolved','human_resolution_required')),
  recipient_name TEXT,
  recipient_address TEXT,
  recipient_vat_cvr TEXT,
  vat_amount NUMERIC,
  payment_details TEXT,
  exemption_code TEXT,
  payload_json TEXT,
  retain_until TEXT
);

CREATE INDEX IF NOT EXISTS idx_documents_purchase_sale_logical_identity
ON documents(sender_vat_cvr, invoice_no, invoice_date)
WHERE document_type = 'purchase_sale';

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_issued_invoice_no_unique
ON documents(invoice_no)
WHERE document_type = 'issued_invoice';

-- ===== BANK CLUSTER (#186-189,#182) =====
-- A company can hold several bank accounts (driftskonto, valutakonto,
-- opsparingskonto, ...). Imported transactions are coupled to one of these so
-- reconciliation can be scoped to a single account (#187).
CREATE TABLE IF NOT EXISTS bank_accounts (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  bank_name TEXT,
  registration_no TEXT,
  account_no TEXT,
  iban TEXT,
  currency TEXT NOT NULL DEFAULT 'DKK',
  ledger_account_no TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(ledger_account_no) REFERENCES accounts(account_no)
);
-- ===== END BANK CLUSTER (#186-189,#182) =====

CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY,
  transaction_date TEXT NOT NULL,
  booking_date TEXT,
  text TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL DEFAULT 'DKK',
  reference TEXT,
  amount_dkk NUMERIC,
  fx_rate_to_dkk NUMERIC,
  source_file_hash TEXT,
  import_batch_id TEXT,
  transaction_hash TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'imported',
  retain_until TEXT,
  -- ===== BANK CLUSTER (#186-189,#182) =====
  -- bank_account_id is nullable for rows imported before #187; new imports
  -- always set it. Extra structured columns (#188) and the running balance
  -- (#189) are nullable and populated by import profiles that supply them.
  bank_account_id INTEGER REFERENCES bank_accounts(id),
  counterparty_name TEXT,
  counterparty_account TEXT,
  message TEXT,
  archive_reference TEXT,
  customer_reference TEXT,
  balance_after NUMERIC,
  raw_json TEXT
  -- ===== END BANK CLUSTER (#186-189,#182) =====
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY,
  entry_no TEXT NOT NULL UNIQUE,
  transaction_date TEXT NOT NULL,
  registration_datetime TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  text TEXT NOT NULL,
  source_bank_transaction_id INTEGER,
  document_id INTEGER,
  currency TEXT NOT NULL DEFAULT 'DKK',
  amount_foreign NUMERIC,
  amount_dkk NUMERIC,
  fx_rate_to_dkk NUMERIC,
  rule_version TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_by_program TEXT NOT NULL DEFAULT 'rentemester',
  status TEXT NOT NULL CHECK(status IN ('posted','reversed')) DEFAULT 'posted',
  reversal_of_entry_id INTEGER,
  previous_hash TEXT,
  entry_hash TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 1,
  retain_until TEXT,
  FOREIGN KEY(source_bank_transaction_id) REFERENCES bank_transactions(id),
  FOREIGN KEY(document_id) REFERENCES documents(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_bank_source_posted
ON journal_entries(source_bank_transaction_id)
WHERE source_bank_transaction_id IS NOT NULL AND status = 'posted';

-- `status = reversed` describes a real reversal row, never an alternate way to
-- hide an ordinary posting from status-filtered controls. Keep the two fields
-- structurally coupled at the database boundary; audit verification below the
-- write boundary separately detects legacy rows created before this guard.
CREATE TRIGGER IF NOT EXISTS journal_entries_reversal_shape_insert
BEFORE INSERT ON journal_entries
WHEN (NEW.status = 'reversed' AND NEW.reversal_of_entry_id IS NULL)
  OR (NEW.status = 'posted' AND NEW.reversal_of_entry_id IS NOT NULL)
  OR (
    NEW.reversal_of_entry_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
        FROM journal_entries original
       WHERE original.id = NEW.reversal_of_entry_id
         AND original.status = 'posted'
         AND original.reversal_of_entry_id IS NULL
         AND original.id < NEW.id
    )
  )
  OR (
    NEW.reversal_of_entry_id IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM journal_entries prior_reversal
       WHERE prior_reversal.reversal_of_entry_id = NEW.reversal_of_entry_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'journal reversal status requires one existing unreversed posted original');
END;

-- Invoice documents and their applications are append-only domain evidence.
-- A bare reversal is blocked. The sole exception is the final half of the
-- atomic legacy-booking repair: a dependency-free, unclassified issued-invoice
-- journal may be reversed only after a different active canonical posting has
-- already been linked in the same transaction. Credit notes stay unconditional.
CREATE TRIGGER IF NOT EXISTS invoice_evidence_no_standalone_reversal
BEFORE INSERT ON journal_entries
WHEN NEW.reversal_of_entry_id IS NOT NULL
 AND EXISTS (
   SELECT 1
     FROM journal_entries original
     JOIN documents d ON d.id = original.document_id
    WHERE original.id = NEW.reversal_of_entry_id
      AND d.document_type IN ('issued_invoice', 'credit_note')
 )
 AND NOT EXISTS (
   SELECT 1
     FROM journal_entries original
     JOIN documents d ON d.id = original.document_id
    WHERE original.id = NEW.reversal_of_entry_id
      AND d.document_type = 'issued_invoice'
      AND d.status IN ('issued', 'open')
      AND original.status = 'posted'
      AND original.reversal_of_entry_id IS NULL
      AND original.source_bank_transaction_id IS NULL
      AND original.locked = 1
      AND NEW.status = 'reversed'
      AND NEW.locked = 1
      AND NEW.document_id IS original.document_id
      AND NEW.transaction_date = original.transaction_date
      AND NEW.source_bank_transaction_id IS NULL
      AND NEW.currency = original.currency
      AND NEW.amount_foreign IS original.amount_foreign
      AND NEW.amount_dkk IS original.amount_dkk
      AND NEW.fx_rate_to_dkk IS original.fx_rate_to_dkk
      AND NOT EXISTS (
        SELECT 1 FROM journal_entries prior_reversal
         WHERE prior_reversal.reversal_of_entry_id = original.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM issued_invoice_postings old_link
         WHERE old_link.journal_entry_id = original.id
      )
      AND EXISTS (
        SELECT 1
          FROM issued_invoice_postings replacement_link
          JOIN journal_entries replacement
            ON replacement.id = replacement_link.journal_entry_id
         WHERE replacement_link.invoice_document_id = d.id
           AND replacement.id <> original.id
           AND replacement.status = 'posted'
           AND replacement.reversal_of_entry_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM journal_entries replacement_reversal
              WHERE replacement_reversal.reversal_of_entry_id = replacement.id
           )
      )
      AND NOT EXISTS (SELECT 1 FROM invoice_payments WHERE invoice_document_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM invoice_refunds WHERE invoice_document_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM invoice_claim_payments WHERE invoice_document_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM invoice_reminders WHERE invoice_document_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM invoice_compensation_claims WHERE invoice_document_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM invoice_interest_claims WHERE invoice_document_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM invoice_interest_corrections WHERE invoice_document_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM invoice_bad_debt_writeoffs WHERE invoice_document_id = d.id)
      AND NOT EXISTS (
        SELECT 1 FROM documents credit
         WHERE credit.document_type = 'credit_note'
           AND credit.payment_details = d.invoice_no
      )
      AND NOT EXISTS (
        SELECT 1 FROM credit_note_postings credit
         WHERE credit.original_invoice_document_id = d.id
      )
      AND NOT EXISTS (SELECT 1 FROM credit_note_postings WHERE journal_entry_id = original.id)
      AND NOT EXISTS (SELECT 1 FROM invoice_payments WHERE journal_entry_id = original.id)
      AND NOT EXISTS (SELECT 1 FROM invoice_refunds WHERE journal_entry_id = original.id)
      AND NOT EXISTS (SELECT 1 FROM invoice_claim_payments WHERE journal_entry_id = original.id)
      AND NOT EXISTS (SELECT 1 FROM invoice_bad_debt_writeoffs WHERE journal_entry_id = original.id)
      AND NOT EXISTS (SELECT 1 FROM invoice_interest_corrections WHERE journal_entry_id = original.id)
      AND NOT EXISTS (SELECT 1 FROM invoice_reminder_postings WHERE journal_entry_id = original.id)
      AND NOT EXISTS (SELECT 1 FROM invoice_compensation_postings WHERE journal_entry_id = original.id)
      AND NOT EXISTS (SELECT 1 FROM invoice_interest_postings WHERE journal_entry_id = original.id)
      AND NOT EXISTS (SELECT 1 FROM import_document_links WHERE journal_entry_id = original.id)
      AND NOT EXISTS (SELECT 1 FROM opening_balances WHERE journal_entry_id = original.id)
      AND NOT EXISTS (SELECT 1 FROM asset_depreciation_entries WHERE journal_entry_id = original.id)
      AND NOT EXISTS (SELECT 1 FROM asset_writeoffs WHERE journal_entry_id = original.id)
      AND NOT EXISTS (SELECT 1 FROM accruals WHERE registration_journal_entry_id = original.id)
      AND NOT EXISTS (SELECT 1 FROM accrual_schedule_postings WHERE journal_entry_id = original.id)
      AND NOT EXISTS (SELECT 1 FROM payables WHERE journal_entry_id = original.id)
      AND NOT EXISTS (SELECT 1 FROM payable_payments WHERE journal_entry_id = original.id)
      AND NOT EXISTS (
        SELECT 1
          FROM journal_entries other
         WHERE other.document_id = d.id
           AND other.id <> original.id
           AND other.status = 'posted'
           AND other.reversal_of_entry_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM journal_entries other_reversal
              WHERE other_reversal.reversal_of_entry_id = other.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM issued_invoice_postings replacement_link
              WHERE replacement_link.invoice_document_id = d.id
                AND replacement_link.journal_entry_id = other.id
           )
      )
 )
BEGIN
  SELECT RAISE(ABORT, 'invoice evidence cannot be reversed without an atomic invoice correction workflow');
END;

-- A credit note has exactly one accounting journal for its entire lifetime:
-- the journal named by its credit_note_postings row. The link is inserted
-- immediately after the journal inside the same transaction, so the first row
-- is allowed while every later row on the same credit-note document is
-- rejected, regardless of forged status/reversal metadata. Credit-note
-- reversals are prohibited by invoice_evidence_no_standalone_reversal.
CREATE TRIGGER IF NOT EXISTS credit_note_single_active_journal
BEFORE INSERT ON journal_entries
WHEN EXISTS (
   SELECT 1 FROM documents d
    WHERE d.id = NEW.document_id
      AND d.document_type = 'credit_note'
 )
 AND EXISTS (
   SELECT 1
     FROM journal_entries existing
    WHERE existing.document_id = NEW.document_id
 )
BEGIN
  SELECT RAISE(ABORT, 'credit note documents can have only one accounting journal');
END;

CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY,
  journal_entry_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  debit_amount NUMERIC NOT NULL DEFAULT 0 CHECK(debit_amount >= 0),
  credit_amount NUMERIC NOT NULL DEFAULT 0 CHECK(credit_amount >= 0),
  vat_code TEXT,
  currency TEXT NOT NULL DEFAULT 'DKK',
  text TEXT,
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id),
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  CHECK(NOT (debit_amount > 0 AND credit_amount > 0))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  message TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounting_periods (
  id INTEGER PRIMARY KEY,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('vat_period','vat_quarter','fiscal_year','custom')),
  status TEXT NOT NULL CHECK(status IN ('open','closed','reported')) DEFAULT 'open',
  closed_at TEXT,
  closed_by TEXT,
  reported_at TEXT,
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(period_start, period_end, kind)
);

-- Explicit, append-only identity for the one journal that booked an issued
-- invoice. Settlement must never infer this from a journal's shape: reminder,
-- interest and arbitrary document-linked journals can also debit an asset and
-- credit income.
CREATE TABLE IF NOT EXISTS issued_invoice_postings (
  invoice_document_id INTEGER PRIMARY KEY,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  receivable_account_id INTEGER NOT NULL,
  booked_gross_dkk NUMERIC NOT NULL CHECK(booked_gross_dkk > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id),
  FOREIGN KEY(receivable_account_id) REFERENCES accounts(id)
);

-- Credit notes are principal reductions and therefore need their own explicit
-- journal identity. A document row without this link is an unresolved legacy
-- item and is excluded fail-closed from invoice balances.
CREATE TABLE IF NOT EXISTS credit_note_postings (
  credit_note_document_id INTEGER PRIMARY KEY,
  original_invoice_document_id INTEGER NOT NULL,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  receivable_account_id INTEGER NOT NULL,
  booked_gross_dkk NUMERIC NOT NULL CHECK(booked_gross_dkk > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(credit_note_document_id) REFERENCES documents(id),
  FOREIGN KEY(original_invoice_document_id) REFERENCES documents(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id),
  FOREIGN KEY(receivable_account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_credit_note_postings_original_invoice
ON credit_note_postings(original_invoice_document_id);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  bank_transaction_id INTEGER,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  payment_date TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK(amount > 0),
  currency TEXT NOT NULL DEFAULT 'DKK',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id),
  FOREIGN KEY(bank_transaction_id) REFERENCES bank_transactions(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE TABLE IF NOT EXISTS invoice_refunds (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  bank_transaction_id INTEGER,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  refund_date TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK(amount > 0),
  currency TEXT NOT NULL DEFAULT 'DKK',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id),
  FOREIGN KEY(bank_transaction_id) REFERENCES bank_transactions(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE TABLE IF NOT EXISTS invoice_reminders (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  reminder_date TEXT NOT NULL,
  fee_amount NUMERIC NOT NULL CHECK(fee_amount > 0),
  currency TEXT NOT NULL DEFAULT 'DKK',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS invoice_compensation_claims (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL UNIQUE,
  claim_date TEXT NOT NULL,
  amount_dkk NUMERIC NOT NULL CHECK(amount_dkk > 0),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS invoice_interest_claims (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  claim_date TEXT NOT NULL,
  reference_rate_percent NUMERIC NOT NULL,
  annual_interest_rate_percent NUMERIC NOT NULL,
  -- Whether reference_rate_percent came from the statutory half-yearly table
  -- (renteloven § 5) or was a manual human override. A table claim whose window
  -- crosses a 1/1 or 1/7 rate change was BILLED with each half-year's own rate
  -- (JUR-7 segmentation); a manual claim is one deliberate rate for the whole
  -- window. proposeInterestCorrection must reconstruct the lawful interest the
  -- SAME way it was billed, so it has to know which — the single stored rate is
  -- not enough to tell a multi-rate table window from a single-rate manual one.
  -- Legacy rows (pre-JUR-7) default to 'manual-override' so they reconstruct
  -- exactly as before (one stored rate), never retroactively re-segmented.
  reference_rate_source TEXT NOT NULL DEFAULT 'manual-override'
    CHECK(reference_rate_source IN ('statutory-table', 'manual-override')),
  overdue_days INTEGER NOT NULL,
  principal_open_balance NUMERIC NOT NULL,
  amount_dkk NUMERIC NOT NULL CHECK(amount_dkk > 0),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(invoice_document_id, claim_date, reference_rate_percent),
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS invoice_compensation_postings (
  id INTEGER PRIMARY KEY,
  compensation_claim_id INTEGER NOT NULL UNIQUE,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(compensation_claim_id) REFERENCES invoice_compensation_claims(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE TABLE IF NOT EXISTS invoice_reminder_postings (
  id INTEGER PRIMARY KEY,
  reminder_id INTEGER NOT NULL UNIQUE,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(reminder_id) REFERENCES invoice_reminders(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE TABLE IF NOT EXISTS invoice_interest_postings (
  id INTEGER PRIMARY KEY,
  interest_claim_id INTEGER NOT NULL UNIQUE,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(interest_claim_id) REFERENCES invoice_interest_claims(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

-- Canonical, database-owned shape of a claim-origin journal. Reminder fees,
-- compensation and late interest are all DKK receivables against claim income:
-- exactly one or more debtor-asset debits and income credits, no VAT/FX/bank
-- side effects and no other account classes. Both INSERT triggers and runtime
-- audit consume this view so direct SQL and application calls share one rule.
CREATE VIEW IF NOT EXISTS invoice_claim_posting_journal_evidence AS
SELECT j.id AS journal_entry_id,
       j.document_id,
       j.transaction_date,
       j.source_bank_transaction_id,
       j.currency,
       j.amount_foreign,
       j.amount_dkk,
       j.fx_rate_to_dkk,
       j.status,
       j.reversal_of_entry_id,
       EXISTS (
         SELECT 1 FROM journal_entries reversal
          WHERE reversal.reversal_of_entry_id = j.id
       ) AS has_reversal,
       COUNT(jl.id) AS line_count,
       CAST(ROUND(100 * COALESCE(SUM(jl.debit_amount), 0)) AS INTEGER) AS total_debit_ore,
       CAST(ROUND(100 * COALESCE(SUM(jl.credit_amount), 0)) AS INTEGER) AS total_credit_ore,
       CAST(ROUND(100 * COALESCE(SUM(
         CASE
           WHEN a.type = 'asset'
            AND a.normal_balance = 'debit'
            AND jl.debit_amount > 0
            AND jl.credit_amount = 0
            AND jl.vat_code IS NULL
            AND UPPER(TRIM(COALESCE(jl.currency, 'DKK'))) = 'DKK'
           THEN jl.debit_amount ELSE 0
         END
       ), 0)) AS INTEGER) AS receivable_debit_ore,
       CAST(ROUND(100 * COALESCE(SUM(
         CASE
           WHEN a.type = 'income'
            AND a.normal_balance = 'credit'
            AND jl.credit_amount > 0
            AND jl.debit_amount = 0
            AND jl.vat_code IS NULL
            AND UPPER(TRIM(COALESCE(jl.currency, 'DKK'))) = 'DKK'
           THEN jl.credit_amount ELSE 0
         END
       ), 0)) AS INTEGER) AS income_credit_ore,
       COALESCE(SUM(
         CASE
           WHEN (
             a.type = 'asset'
             AND a.normal_balance = 'debit'
             AND jl.debit_amount > 0
             AND jl.credit_amount = 0
             AND jl.vat_code IS NULL
             AND UPPER(TRIM(COALESCE(jl.currency, 'DKK'))) = 'DKK'
           ) OR (
             a.type = 'income'
             AND a.normal_balance = 'credit'
             AND jl.credit_amount > 0
             AND jl.debit_amount = 0
             AND jl.vat_code IS NULL
             AND UPPER(TRIM(COALESCE(jl.currency, 'DKK'))) = 'DKK'
           ) THEN 0 ELSE 1
         END
       ), 0) AS invalid_line_count
  FROM journal_entries j
  LEFT JOIN journal_lines jl ON jl.journal_entry_id = j.id
  LEFT JOIN accounts a ON a.id = jl.account_id
 GROUP BY j.id;

-- A correcting reversal of over-claimed morarente. When a balance reduction
-- (payment / credit note) is recorded with an effective date inside an already
-- POSTED interest claim's window, the lawful date-aware interest for that window
-- becomes lower than what was booked. This row records the correcting journal
-- entry (debit interest income, credit receivable) that reverses the excess.
-- amount_dkk is always the positive excess being reversed; getInvoiceStatus
-- subtracts it from the interest-claim balance. Append-only, like every claim.
CREATE TABLE IF NOT EXISTS invoice_interest_corrections (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  correction_date TEXT NOT NULL,
  amount_dkk NUMERIC NOT NULL CHECK(amount_dkk > 0),
  reason TEXT,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

-- A correction is irreversible domain evidence, so its complete causal plan is
-- persisted first inside the same write transaction. The INSERT trigger below
-- accepts only the exact journal/date/amount/accounts/claims in this one-time
-- plan; direct unplanned correction rows therefore fail before becoming
-- append-only poison.
CREATE TABLE IF NOT EXISTS invoice_interest_correction_plans (
  journal_entry_id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  correction_date TEXT NOT NULL,
  amount_dkk NUMERIC NOT NULL CHECK(amount_dkk > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id),
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS invoice_interest_correction_plan_claims (
  journal_entry_id INTEGER NOT NULL,
  interest_claim_id INTEGER NOT NULL,
  claim_date TEXT NOT NULL,
  amount_dkk NUMERIC NOT NULL CHECK(amount_dkk > 0),
  claim_ceiling_dkk NUMERIC NOT NULL CHECK(claim_ceiling_dkk > 0),
  PRIMARY KEY(journal_entry_id, interest_claim_id),
  FOREIGN KEY(journal_entry_id) REFERENCES invoice_interest_correction_plans(journal_entry_id),
  FOREIGN KEY(interest_claim_id) REFERENCES invoice_interest_claims(id)
);

CREATE TABLE IF NOT EXISTS invoice_interest_correction_plan_lines (
  journal_entry_id INTEGER NOT NULL,
  account_no TEXT NOT NULL,
  debit_amount NUMERIC NOT NULL DEFAULT 0 CHECK(debit_amount >= 0),
  credit_amount NUMERIC NOT NULL DEFAULT 0 CHECK(credit_amount >= 0),
  PRIMARY KEY(journal_entry_id, account_no),
  FOREIGN KEY(journal_entry_id) REFERENCES invoice_interest_correction_plans(journal_entry_id),
  FOREIGN KEY(account_no) REFERENCES accounts(account_no),
  CHECK((debit_amount > 0 AND credit_amount = 0) OR (credit_amount > 0 AND debit_amount = 0))
);

CREATE TABLE IF NOT EXISTS invoice_claim_payments (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  bank_transaction_id INTEGER,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  payment_date TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK(amount > 0),
  currency TEXT NOT NULL DEFAULT 'DKK',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id),
  FOREIGN KEY(bank_transaction_id) REFERENCES bank_transactions(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

-- Status/list reads validate journal evidence per invoice. These indexes keep
-- that scoped validation logarithmic instead of rescanning every application
-- table once per invoice.
CREATE INDEX IF NOT EXISTS idx_invoice_payments_document
ON invoice_payments(invoice_document_id);
CREATE INDEX IF NOT EXISTS idx_invoice_refunds_document
ON invoice_refunds(invoice_document_id);
CREATE INDEX IF NOT EXISTS idx_invoice_claim_payments_document
ON invoice_claim_payments(invoice_document_id);

CREATE TABLE IF NOT EXISTS invoice_bad_debt_writeoffs (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  writeoff_date TEXT NOT NULL,
  gross_amount NUMERIC NOT NULL CHECK(gross_amount > 0),
  net_amount NUMERIC NOT NULL CHECK(net_amount >= 0),
  vat_amount NUMERIC NOT NULL CHECK(vat_amount >= 0),
  note TEXT,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

-- Map every canonical principal journal (and its reversal, when present) back
-- to the invoice receivable it affects. Consumers can reconstruct the exact
-- DKK carrying balance from posted journal lines instead of re-scaling the
-- foreign invoice at its original rate and manufacturing rounding drift.
CREATE VIEW IF NOT EXISTS invoice_principal_receivable_effects AS
WITH principal_entries AS (
  SELECT posting.invoice_document_id,
         posting.journal_entry_id,
         posting.receivable_account_id
    FROM issued_invoice_postings posting
  UNION
  SELECT credit.original_invoice_document_id,
         credit.journal_entry_id,
         posting.receivable_account_id
    FROM credit_note_postings credit
    JOIN issued_invoice_postings posting
      ON posting.invoice_document_id = credit.original_invoice_document_id
  UNION
  SELECT payment.invoice_document_id,
         payment.journal_entry_id,
         posting.receivable_account_id
    FROM invoice_payments payment
    JOIN issued_invoice_postings posting
      ON posting.invoice_document_id = payment.invoice_document_id
   WHERE payment.journal_entry_id IS NOT NULL
  UNION
  SELECT refund.invoice_document_id,
         refund.journal_entry_id,
         posting.receivable_account_id
    FROM invoice_refunds refund
    JOIN issued_invoice_postings posting
      ON posting.invoice_document_id = refund.invoice_document_id
   WHERE refund.journal_entry_id IS NOT NULL
  UNION
  SELECT writeoff.invoice_document_id,
         writeoff.journal_entry_id,
         posting.receivable_account_id
    FROM invoice_bad_debt_writeoffs writeoff
    JOIN issued_invoice_postings posting
      ON posting.invoice_document_id = writeoff.invoice_document_id
)
SELECT principal.invoice_document_id,
       principal.journal_entry_id,
       principal.receivable_account_id
  FROM principal_entries principal
UNION ALL
SELECT principal.invoice_document_id,
       reversal.id AS journal_entry_id,
       principal.receivable_account_id
  FROM principal_entries principal
  JOIN journal_entries reversal
    ON reversal.reversal_of_entry_id = principal.journal_entry_id;

-- Canonical evidence for a bad-debt write-off. The retained domain amounts are
-- in invoice currency; this view derives the exact DKK journal amount from the
-- receivable's journal carrying balance and the VAT split from the issued
-- invoice's immutable basis, then requires two or three lines: debit a
-- directly-postable expense with DK_BAD_DEBT_25, debit the output-VAT role
-- active when the journal was registered when the cumulative allocation is
-- non-zero, and credit the invoice's booked receivable account. Both the
-- INSERT trigger and runtime audit consume it.
CREATE VIEW IF NOT EXISTS invoice_bad_debt_writeoff_journal_evidence AS
WITH basis AS (
  SELECT writeoff.id AS writeoff_id,
         writeoff.invoice_document_id,
         writeoff.journal_entry_id,
         writeoff.writeoff_date,
         writeoff.gross_amount,
         writeoff.net_amount,
         writeoff.vat_amount,
         invoice.document_type,
         invoice.payload_json,
         UPPER(TRIM(COALESCE(invoice.currency, 'DKK'))) AS invoice_currency,
         invoice.invoice_date,
         invoice.amount_inc_vat AS invoice_gross_amount,
         invoice.vat_amount AS invoice_vat_amount,
         journal.document_id AS journal_document_id,
         journal.transaction_date,
         journal.registration_datetime,
         journal.source_bank_transaction_id,
         UPPER(TRIM(COALESCE(journal.currency, 'DKK'))) AS journal_currency,
         journal.amount_foreign,
         journal.amount_dkk,
         journal.fx_rate_to_dkk,
         journal.status,
         journal.reversal_of_entry_id,
         EXISTS (
           SELECT 1 FROM journal_entries reversal
            WHERE reversal.reversal_of_entry_id = journal.id
         ) AS has_reversal,
         posting.receivable_account_id,
         posting.journal_entry_id AS invoice_journal_entry_id,
         EXISTS (
           SELECT 1
             FROM credit_note_postings later_posting
             JOIN documents later_credit
               ON later_credit.id = later_posting.credit_note_document_id
            WHERE later_posting.original_invoice_document_id = writeoff.invoice_document_id
              AND (
                later_credit.invoice_date > writeoff.writeoff_date
                OR (
                  later_credit.invoice_date = writeoff.writeoff_date
                  AND later_posting.journal_entry_id > writeoff.journal_entry_id
                )
              )
         ) AS has_later_credit_note,
         CAST(ROUND(100 * invoice.amount_inc_vat) AS INTEGER) AS invoice_gross_amount_ore,
         CAST(ROUND(100 * invoice.vat_amount) AS INTEGER) AS invoice_vat_amount_ore,
         CAST(ROUND(100 * writeoff.gross_amount) AS INTEGER) AS gross_amount_ore,
         CAST(ROUND(100 * COALESCE((
           SELECT SUM(line.debit_amount - line.credit_amount)
             FROM invoice_principal_receivable_effects effect
             JOIN journal_lines line
               ON line.journal_entry_id = effect.journal_entry_id
              AND line.account_id = effect.receivable_account_id
            WHERE effect.invoice_document_id = writeoff.invoice_document_id
              AND effect.receivable_account_id = posting.receivable_account_id
              AND effect.journal_entry_id < writeoff.journal_entry_id
         ), 0)) AS INTEGER) AS carrying_before_ore,
         CAST(ROUND(100 * (
           COALESCE(invoice.amount_inc_vat, 0)
           - COALESCE((
             SELECT SUM(payment.amount)
               FROM invoice_payments payment
              WHERE payment.invoice_document_id = writeoff.invoice_document_id
                AND (
                  payment.payment_date < writeoff.writeoff_date
                  OR (
                    payment.payment_date = writeoff.writeoff_date
                    AND COALESCE(payment.journal_entry_id, 0) < writeoff.journal_entry_id
                  )
                )
           ), 0)
           - COALESCE((
             SELECT SUM(credit.amount_inc_vat)
               FROM credit_note_postings credit_posting
               JOIN documents credit
                 ON credit.id = credit_posting.credit_note_document_id
                AND credit.document_type = 'credit_note'
              WHERE credit_posting.original_invoice_document_id = writeoff.invoice_document_id
                AND (
                  credit.invoice_date < writeoff.writeoff_date
                  OR (
                    credit.invoice_date = writeoff.writeoff_date
                    AND credit_posting.journal_entry_id < writeoff.journal_entry_id
                  )
                )
           ), 0)
           + COALESCE((
             SELECT SUM(refund.amount)
               FROM invoice_refunds refund
              WHERE refund.invoice_document_id = writeoff.invoice_document_id
                AND (
                  refund.refund_date < writeoff.writeoff_date
                  OR (
                    refund.refund_date = writeoff.writeoff_date
                    AND COALESCE(refund.journal_entry_id, 0) < writeoff.journal_entry_id
                  )
                )
           ), 0)
           - COALESCE((
             SELECT SUM(prior.gross_amount)
               FROM invoice_bad_debt_writeoffs prior
              WHERE prior.invoice_document_id = writeoff.invoice_document_id
                AND prior.id <> writeoff.id
                AND (
                  prior.writeoff_date < writeoff.writeoff_date
                  OR (
                    prior.writeoff_date = writeoff.writeoff_date
                    AND prior.journal_entry_id < writeoff.journal_entry_id
                  )
                )
           ), 0)
         )) AS INTEGER) AS open_before_ore,
         CAST(ROUND(100 * (
           COALESCE((
             SELECT SUM(credit.amount_inc_vat)
               FROM credit_note_postings credit_posting
               JOIN documents credit
                 ON credit.id = credit_posting.credit_note_document_id
                AND credit.document_type = 'credit_note'
              WHERE credit_posting.original_invoice_document_id = writeoff.invoice_document_id
                AND (
                  credit.invoice_date < writeoff.writeoff_date
                  OR (
                    credit.invoice_date = writeoff.writeoff_date
                    AND credit_posting.journal_entry_id < writeoff.journal_entry_id
                  )
                )
           ), 0)
           + COALESCE((
             SELECT SUM(prior.gross_amount)
               FROM invoice_bad_debt_writeoffs prior
              WHERE prior.invoice_document_id = writeoff.invoice_document_id
                AND prior.id <> writeoff.id
                AND (
                  prior.writeoff_date < writeoff.writeoff_date
                  OR (
                    prior.writeoff_date = writeoff.writeoff_date
                    AND prior.journal_entry_id < writeoff.journal_entry_id
                  )
                )
           ), 0)
         )) AS INTEGER) AS prior_relief_gross_ore,
         CAST(ROUND(100 * (
           COALESCE((
             SELECT SUM(credit.vat_amount)
               FROM credit_note_postings credit_posting
               JOIN documents credit
                 ON credit.id = credit_posting.credit_note_document_id
                AND credit.document_type = 'credit_note'
              WHERE credit_posting.original_invoice_document_id = writeoff.invoice_document_id
                AND (
                  credit.invoice_date < writeoff.writeoff_date
                  OR (
                    credit.invoice_date = writeoff.writeoff_date
                    AND credit_posting.journal_entry_id < writeoff.journal_entry_id
                  )
                )
           ), 0)
           + COALESCE((
             SELECT SUM(prior.vat_amount)
               FROM invoice_bad_debt_writeoffs prior
              WHERE prior.invoice_document_id = writeoff.invoice_document_id
                AND prior.id <> writeoff.id
                AND (
                  prior.writeoff_date < writeoff.writeoff_date
                  OR (
                    prior.writeoff_date = writeoff.writeoff_date
                    AND prior.journal_entry_id < writeoff.journal_entry_id
                  )
                )
           ), 0)
         )) AS INTEGER) AS prior_domain_vat_relief_ore,
         CAST(ROUND(100 * COALESCE((
           SELECT SUM(line.credit_amount)
             FROM journal_lines line
             JOIN accounts account ON account.id = line.account_id
            WHERE line.journal_entry_id = posting.journal_entry_id
              AND account.type = 'vat'
              AND account.normal_balance = 'credit'
              AND line.debit_amount = 0
              AND line.credit_amount > 0
              AND line.vat_code IS NULL
         ), 0)) AS INTEGER) AS original_output_vat_ore,
         CAST(ROUND(100 * (
           COALESCE((
             SELECT SUM(line.debit_amount)
               FROM credit_note_postings credit_posting
               JOIN documents credit
                 ON credit.id = credit_posting.credit_note_document_id
                AND credit.document_type = 'credit_note'
               JOIN journal_lines line
                 ON line.journal_entry_id = credit_posting.journal_entry_id
               JOIN accounts account ON account.id = line.account_id
              WHERE credit_posting.original_invoice_document_id = writeoff.invoice_document_id
                AND account.type = 'vat'
                AND account.normal_balance = 'credit'
                AND line.debit_amount > 0
                AND line.credit_amount = 0
                AND line.vat_code IS NULL
                AND (
                  credit.invoice_date < writeoff.writeoff_date
                  OR (
                    credit.invoice_date = writeoff.writeoff_date
                    AND credit_posting.journal_entry_id < writeoff.journal_entry_id
                  )
                )
           ), 0)
           + COALESCE((
             SELECT SUM(line.debit_amount)
               FROM invoice_bad_debt_writeoffs prior
               JOIN journal_lines line ON line.journal_entry_id = prior.journal_entry_id
               JOIN accounts account ON account.id = line.account_id
              WHERE prior.invoice_document_id = writeoff.invoice_document_id
                AND prior.id <> writeoff.id
                AND account.type = 'vat'
                AND account.normal_balance = 'credit'
                AND line.debit_amount > 0
                AND line.credit_amount = 0
                AND line.vat_code IS NULL
                AND (
                  prior.writeoff_date < writeoff.writeoff_date
                  OR (
                    prior.writeoff_date = writeoff.writeoff_date
                    AND prior.journal_entry_id < writeoff.journal_entry_id
                  )
                )
           ), 0)
         )) AS INTEGER) AS prior_dkk_vat_relief_ore
    FROM invoice_bad_debt_writeoffs writeoff
    JOIN documents invoice ON invoice.id = writeoff.invoice_document_id
    JOIN journal_entries journal ON journal.id = writeoff.journal_entry_id
    LEFT JOIN issued_invoice_postings posting
      ON posting.invoice_document_id = writeoff.invoice_document_id
),
relief_basis AS (
  SELECT basis.*,
         basis.prior_relief_gross_ore + basis.gross_amount_ore AS cumulative_relief_gross_ore
    FROM basis
),
domain_basis AS (
  SELECT relief_basis.*,
         (
           CASE
             WHEN relief_basis.cumulative_relief_gross_ore = relief_basis.invoice_gross_amount_ore
             THEN relief_basis.invoice_vat_amount_ore
             ELSE CAST(ROUND(
               relief_basis.invoice_vat_amount_ore * relief_basis.cumulative_relief_gross_ore * 1.0 /
               NULLIF(relief_basis.invoice_gross_amount_ore, 0)
             ) AS INTEGER)
           END
           - relief_basis.prior_domain_vat_relief_ore
         ) AS expected_domain_vat_ore
    FROM relief_basis
),
carrying_basis AS (
  SELECT domain_basis.*,
         CASE
           WHEN domain_basis.invoice_currency = 'DKK' THEN domain_basis.gross_amount_ore
           WHEN domain_basis.gross_amount_ore = domain_basis.open_before_ore THEN domain_basis.carrying_before_ore
           ELSE CAST(ROUND(
             domain_basis.carrying_before_ore * domain_basis.gross_amount_ore * 1.0 /
             NULLIF(domain_basis.open_before_ore, 0)
           ) AS INTEGER)
         END AS expected_gross_ore
    FROM domain_basis
),
split_basis AS (
  SELECT carrying_basis.*,
         CASE
           WHEN carrying_basis.invoice_currency = 'DKK'
           THEN carrying_basis.expected_domain_vat_ore
           ELSE (
             CASE
               WHEN carrying_basis.cumulative_relief_gross_ore = carrying_basis.invoice_gross_amount_ore
               THEN carrying_basis.original_output_vat_ore
               ELSE CAST(ROUND(
                 carrying_basis.original_output_vat_ore * carrying_basis.cumulative_relief_gross_ore * 1.0 /
                 NULLIF(carrying_basis.invoice_gross_amount_ore, 0)
               ) AS INTEGER)
             END
             - carrying_basis.prior_dkk_vat_relief_ore
           )
         END AS expected_vat_ore
    FROM carrying_basis
),
aggregated AS (
  SELECT split_basis.*,
         split_basis.gross_amount_ore - split_basis.expected_domain_vat_ore AS expected_domain_net_ore,
         split_basis.expected_gross_ore - split_basis.expected_vat_ore AS expected_net_ore,
         COUNT(line.id) AS line_count,
         CAST(ROUND(100 * COALESCE(SUM(line.debit_amount), 0)) AS INTEGER) AS total_debit_ore,
         CAST(ROUND(100 * COALESCE(SUM(line.credit_amount), 0)) AS INTEGER) AS total_credit_ore,
         CAST(ROUND(100 * COALESCE(SUM(CASE
           WHEN account.type = 'expense'
            AND account.normal_balance = 'debit'
            AND line.debit_amount > 0
            AND line.credit_amount = 0
            AND line.vat_code = 'DK_BAD_DEBT_25'
            AND UPPER(TRIM(COALESCE(line.currency, 'DKK'))) = 'DKK'
           THEN line.debit_amount ELSE 0
         END), 0)) AS INTEGER) AS expense_debit_ore,
         CAST(ROUND(100 * COALESCE(SUM(CASE
           WHEN account.type = 'vat'
            AND account.normal_balance = 'credit'
            AND EXISTS (
              SELECT 1
                FROM account_role_mappings mapping
               WHERE mapping.role = 'output_vat'
                 AND mapping.account_no = account.account_no
                 AND mapping.confirmed_at <= split_basis.registration_datetime
                 AND mapping.confirmed_at = (
                   SELECT MAX(candidate.confirmed_at)
                     FROM account_role_mappings candidate
                    WHERE candidate.role = 'output_vat'
                      AND candidate.confirmed_at <= split_basis.registration_datetime
                 )
            )
            AND line.debit_amount > 0
            AND line.credit_amount = 0
            AND line.vat_code IS NULL
            AND UPPER(TRIM(COALESCE(line.currency, 'DKK'))) = 'DKK'
           THEN line.debit_amount ELSE 0
         END), 0)) AS INTEGER) AS output_vat_debit_ore,
         CAST(ROUND(100 * COALESCE(SUM(CASE
           WHEN line.account_id = split_basis.receivable_account_id
            AND account.type = 'asset'
            AND account.normal_balance = 'debit'
            AND line.credit_amount > 0
            AND line.debit_amount = 0
            AND line.vat_code IS NULL
            AND UPPER(TRIM(COALESCE(line.currency, 'DKK'))) = 'DKK'
           THEN line.credit_amount ELSE 0
         END), 0)) AS INTEGER) AS receivable_credit_ore,
         COALESCE(SUM(CASE
           WHEN (
             account.type = 'expense'
             AND account.normal_balance = 'debit'
             AND line.debit_amount > 0
             AND line.credit_amount = 0
             AND line.vat_code = 'DK_BAD_DEBT_25'
             AND UPPER(TRIM(COALESCE(line.currency, 'DKK'))) = 'DKK'
           ) OR (
             account.type = 'vat'
             AND account.normal_balance = 'credit'
             AND EXISTS (
               SELECT 1
                 FROM account_role_mappings mapping
                WHERE mapping.role = 'output_vat'
                  AND mapping.account_no = account.account_no
                  AND mapping.confirmed_at <= split_basis.registration_datetime
                  AND mapping.confirmed_at = (
                    SELECT MAX(candidate.confirmed_at)
                      FROM account_role_mappings candidate
                     WHERE candidate.role = 'output_vat'
                       AND candidate.confirmed_at <= split_basis.registration_datetime
                  )
             )
             AND line.debit_amount > 0
             AND line.credit_amount = 0
             AND line.vat_code IS NULL
             AND UPPER(TRIM(COALESCE(line.currency, 'DKK'))) = 'DKK'
           ) OR (
             line.account_id = split_basis.receivable_account_id
             AND account.type = 'asset'
             AND account.normal_balance = 'debit'
             AND line.credit_amount > 0
             AND line.debit_amount = 0
             AND line.vat_code IS NULL
             AND UPPER(TRIM(COALESCE(line.currency, 'DKK'))) = 'DKK'
           ) THEN 0 ELSE 1
         END), 0) AS invalid_line_count
    FROM split_basis
    LEFT JOIN journal_lines line ON line.journal_entry_id = split_basis.journal_entry_id
    LEFT JOIN accounts account ON account.id = line.account_id
   GROUP BY split_basis.writeoff_id
)
SELECT aggregated.*,
       CASE WHEN
         document_type = 'issued_invoice'
         AND json_valid(payload_json)
         AND json_extract(payload_json, '$.vatTreatment') = 'standard'
         AND invoice_gross_amount > 0
         AND invoice_vat_amount > 0
         AND cumulative_relief_gross_ore <= invoice_gross_amount_ore
         AND expected_domain_vat_ore >= 0
         AND expected_domain_vat_ore <= gross_amount_ore
         AND original_output_vat_ore > 0
         AND expected_vat_ore >= 0
         AND expected_vat_ore <= expected_gross_ore
         AND CAST(ROUND(100 * vat_amount) AS INTEGER) = expected_domain_vat_ore
         AND CAST(ROUND(100 * net_amount) AS INTEGER) = expected_domain_net_ore
         AND journal_document_id = invoice_document_id
         AND transaction_date = writeoff_date
         AND invoice_date IS NOT NULL
         AND writeoff_date >= invoice_date
         AND invoice_journal_entry_id IS NOT NULL
         AND journal_entry_id > invoice_journal_entry_id
         AND has_later_credit_note = 0
         AND source_bank_transaction_id IS NULL
         AND status = 'posted'
         AND reversal_of_entry_id IS NULL
         AND has_reversal = 0
         AND journal_currency = invoice_currency
         AND receivable_account_id IS NOT NULL
         AND line_count = CASE WHEN expected_vat_ore = 0 THEN 2 ELSE 3 END
         AND total_debit_ore = expected_gross_ore
         AND total_credit_ore = expected_gross_ore
         AND expense_debit_ore = expected_net_ore
         AND output_vat_debit_ore = expected_vat_ore
         AND receivable_credit_ore = expected_gross_ore
         AND invalid_line_count = 0
         AND CAST(ROUND(100 * gross_amount) AS INTEGER) <= open_before_ore
         AND carrying_before_ore > 0
         AND (invoice_currency <> 'DKK' OR carrying_before_ore = open_before_ore)
         AND expected_gross_ore > 0
         AND (
           (invoice_currency = 'DKK'
            AND amount_foreign IS NULL
            AND amount_dkk IS NULL
            AND fx_rate_to_dkk IS NULL)
           OR
           (invoice_currency <> 'DKK'
            AND CAST(ROUND(100 * amount_foreign) AS INTEGER) = CAST(ROUND(100 * gross_amount) AS INTEGER)
            AND CAST(ROUND(100 * amount_dkk) AS INTEGER) = expected_gross_ore
            AND CAST(ROUND(100 * amount_foreign * fx_rate_to_dkk) AS INTEGER) = expected_gross_ore)
         )
       THEN 1 ELSE 0 END AS is_valid
  FROM aggregated;

CREATE TRIGGER IF NOT EXISTS invoice_bad_debt_writeoffs_validate_insert
AFTER INSERT ON invoice_bad_debt_writeoffs
WHEN EXISTS (
       SELECT 1
         FROM invoice_bad_debt_writeoffs writeoff
         LEFT JOIN invoice_bad_debt_writeoff_journal_evidence evidence
           ON evidence.writeoff_id = writeoff.id
        WHERE writeoff.invoice_document_id = NEW.invoice_document_id
          AND COALESCE(evidence.is_valid, 0) <> 1
     )
  OR NOT EXISTS (
       SELECT 1
         FROM journal_lines line
         JOIN accounts account ON account.id = line.account_id
        WHERE line.journal_entry_id = NEW.journal_entry_id
          AND account.type = 'expense'
          AND account.normal_balance = 'debit'
          AND account.active = 1
          AND account.allow_direct_posting = 1
          AND line.debit_amount > 0
          AND line.credit_amount = 0
          AND line.vat_code = 'DK_BAD_DEBT_25'
     )
  OR (
       EXISTS (
         SELECT 1
           FROM invoice_bad_debt_writeoff_journal_evidence evidence
          WHERE evidence.writeoff_id = NEW.id
            AND evidence.expected_vat_ore > 0
       )
       AND NOT EXISTS (
         SELECT 1
           FROM journal_lines line
           JOIN accounts account ON account.id = line.account_id
           JOIN account_role_mappings mapping
             ON mapping.account_no = account.account_no
            AND mapping.role = 'output_vat'
            AND mapping.status = 'confirmed'
          WHERE line.journal_entry_id = NEW.journal_entry_id
            AND account.type = 'vat'
            AND account.normal_balance = 'credit'
            AND account.active = 1
            AND line.debit_amount > 0
            AND line.credit_amount = 0
            AND line.vat_code IS NULL
       )
     )
BEGIN
  SELECT RAISE(ABORT, 'invoice bad-debt writeoff requires the exact VAT-relief expense/output-VAT/receivable journal');
END;

-- Principal applications can be inserted after a write-off while carrying an
-- earlier effective date. Credit notes must be finalized before the first
-- bad-debt allocation; payments/refunds re-evaluate every existing write-off
-- so no new link can commit a state that only becomes red on the next audit.
CREATE TRIGGER IF NOT EXISTS credit_note_postings_preserve_bad_debt_evidence
AFTER INSERT ON credit_note_postings
WHEN EXISTS (
  SELECT 1 FROM invoice_bad_debt_writeoffs writeoff
   WHERE writeoff.invoice_document_id = NEW.original_invoice_document_id
)
BEGIN
  SELECT RAISE(ABORT, 'credit note cannot be linked after an invoice bad-debt writeoff');
END;

CREATE TRIGGER IF NOT EXISTS invoice_payments_preserve_bad_debt_evidence
AFTER INSERT ON invoice_payments
WHEN EXISTS (
  SELECT 1
    FROM invoice_bad_debt_writeoffs writeoff
    LEFT JOIN invoice_bad_debt_writeoff_journal_evidence evidence
      ON evidence.writeoff_id = writeoff.id
   WHERE writeoff.invoice_document_id = NEW.invoice_document_id
     AND COALESCE(evidence.is_valid, 0) <> 1
)
BEGIN
  SELECT RAISE(ABORT, 'payment would invalidate existing invoice bad-debt evidence');
END;

CREATE TRIGGER IF NOT EXISTS invoice_refunds_preserve_bad_debt_evidence
AFTER INSERT ON invoice_refunds
WHEN EXISTS (
  SELECT 1
    FROM invoice_bad_debt_writeoffs writeoff
    LEFT JOIN invoice_bad_debt_writeoff_journal_evidence evidence
      ON evidence.writeoff_id = writeoff.id
   WHERE writeoff.invoice_document_id = NEW.invoice_document_id
     AND COALESCE(evidence.is_valid, 0) <> 1
)
BEGIN
  SELECT RAISE(ABORT, 'refund would invalidate existing invoice bad-debt evidence');
END;

CREATE TABLE IF NOT EXISTS exceptions (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open',
  related_bank_transaction_id INTEGER,
  related_document_id INTEGER,
  message TEXT NOT NULL,
  required_action TEXT,
  source_evidence TEXT,
  posting_preview TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_note TEXT
);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS accounting_periods_guard_update
BEFORE UPDATE ON accounting_periods
WHEN OLD.period_start != NEW.period_start
   OR OLD.period_end != NEW.period_end
   OR OLD.kind != NEW.kind
   OR OLD.created_at != NEW.created_at
   OR OLD.status = 'reported'
   OR (OLD.status = 'closed' AND NEW.status = 'open')
   OR (OLD.status = 'open' AND NEW.status = 'reported')
   OR NEW.status NOT IN ('open', 'closed', 'reported')
BEGIN
  SELECT RAISE(ABORT, 'accounting periods may only progress open -> closed -> reported; period bounds are immutable');
END;

CREATE TRIGGER IF NOT EXISTS accounting_periods_no_delete
BEFORE DELETE ON accounting_periods
BEGIN
  SELECT RAISE(ABORT, 'accounting periods are append-only');
END;

CREATE TRIGGER IF NOT EXISTS sequences_monotone_update
BEFORE UPDATE ON sequences
WHEN OLD.kind != NEW.kind
   OR OLD.scope != NEW.scope
   OR NEW.value < OLD.value
BEGIN
  SELECT RAISE(ABORT, 'sequences are immutable identifiers and monotonically increasing');
END;

CREATE TRIGGER IF NOT EXISTS sequences_no_delete
BEFORE DELETE ON sequences
BEGIN
  SELECT RAISE(ABORT, 'sequences are append-only');
END;

CREATE TRIGGER IF NOT EXISTS exceptions_guard_update
BEFORE UPDATE ON exceptions
WHEN OLD.type != NEW.type
   OR OLD.severity != NEW.severity
   OR OLD.related_bank_transaction_id IS NOT NEW.related_bank_transaction_id
   OR OLD.related_document_id IS NOT NEW.related_document_id
   OR OLD.created_at != NEW.created_at
   OR (OLD.status = 'resolved' AND NEW.status = 'open')
BEGIN
  SELECT RAISE(ABORT, 'exceptions may only progress from open to resolved; identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS exceptions_no_delete
BEFORE DELETE ON exceptions
BEGIN
  SELECT RAISE(ABORT, 'exceptions are append-only; resolve them instead');
END;

CREATE TRIGGER IF NOT EXISTS companies_fiscal_lock
BEFORE UPDATE ON companies
WHEN (OLD.fiscal_year_start_month != NEW.fiscal_year_start_month
   OR OLD.fiscal_year_label_strategy != NEW.fiscal_year_label_strategy)
 AND EXISTS(SELECT 1 FROM journal_entries LIMIT 1)
BEGIN
  SELECT RAISE(ABORT, 'fiscal year configuration is locked after the first journal entry');
END;

-- customers and vendors are ordinary mutable master-data tables. They are
-- deliberately NOT append-only: the bookkeeping law's immutability requirement
-- covers the posted ledger and the invoice/document snapshots that materialise
-- buyer/sender fields at issue/ingest time — not the contact records, which
-- may be corrected and enriched freely. (Older ledgers had append-only triggers
-- here; db.ts migrate() drops them.)

CREATE TRIGGER IF NOT EXISTS journal_entries_no_update
BEFORE UPDATE ON journal_entries
BEGIN
  SELECT RAISE(ABORT, 'journal_entries are append-only; create reversal instead');
END;

CREATE TRIGGER IF NOT EXISTS journal_entries_no_delete
BEFORE DELETE ON journal_entries
BEGIN
  SELECT RAISE(ABORT, 'journal_entries are append-only; create reversal instead');
END;

CREATE TRIGGER IF NOT EXISTS journal_lines_no_update
BEFORE UPDATE ON journal_lines
BEGIN
  SELECT RAISE(ABORT, 'journal_lines are append-only; reverse the parent entry instead');
END;

CREATE TRIGGER IF NOT EXISTS journal_lines_no_delete
BEFORE DELETE ON journal_lines
BEGIN
  SELECT RAISE(ABORT, 'journal_lines are append-only; reverse the parent entry instead');
END;

CREATE TRIGGER IF NOT EXISTS documents_no_update_issued_invoice
BEFORE UPDATE ON documents
WHEN OLD.document_type IN ('issued_invoice','credit_note')
BEGIN
  SELECT RAISE(ABORT, 'issued invoice documents are append-only; create credit note instead');
END;

CREATE TRIGGER IF NOT EXISTS documents_no_delete_issued_invoice
BEFORE DELETE ON documents
WHEN OLD.document_type IN ('issued_invoice','credit_note')
BEGIN
  SELECT RAISE(ABORT, 'issued invoice documents are append-only; create credit note instead');
END;

CREATE TRIGGER IF NOT EXISTS documents_no_update_when_linked
BEFORE UPDATE ON documents
WHEN OLD.document_type IN ('purchase_sale','cash_register_receipt')
  AND EXISTS(SELECT 1 FROM journal_entries WHERE document_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'document is linked to a journal entry and cannot be modified; reverse the entry first');
END;

CREATE TRIGGER IF NOT EXISTS documents_no_delete_when_linked
BEFORE DELETE ON documents
WHEN OLD.document_type IN ('purchase_sale','cash_register_receipt')
  AND EXISTS(SELECT 1 FROM journal_entries WHERE document_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'document is linked to a journal entry and cannot be deleted; reverse the entry first');
END;

CREATE TRIGGER IF NOT EXISTS bank_transactions_no_update_when_referenced
BEFORE UPDATE ON bank_transactions
WHEN EXISTS(SELECT 1 FROM journal_entries WHERE source_bank_transaction_id = OLD.id)
   OR EXISTS(SELECT 1 FROM invoice_payments WHERE bank_transaction_id = OLD.id)
   OR EXISTS(SELECT 1 FROM invoice_refunds WHERE bank_transaction_id = OLD.id)
   OR EXISTS(SELECT 1 FROM invoice_claim_payments WHERE bank_transaction_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'bank transaction is referenced by ledger or payment records and cannot be modified');
END;

CREATE TRIGGER IF NOT EXISTS bank_transactions_no_delete
BEFORE DELETE ON bank_transactions
BEGIN
  SELECT RAISE(ABORT, 'bank transactions are append-only; correct via journal reversal or new import');
END;

-- ===== BANK CLUSTER (#186-189,#182) =====
-- Bank accounts are append-only identity records: only the `active` flag may
-- change (to retire a closed account), everything else is immutable so
-- already-imported transactions keep pointing at a stable account definition.
CREATE TRIGGER IF NOT EXISTS bank_accounts_guard_update
BEFORE UPDATE ON bank_accounts
WHEN OLD.slug != NEW.slug
   OR OLD.name != NEW.name
   OR OLD.bank_name IS NOT NEW.bank_name
   OR OLD.registration_no IS NOT NEW.registration_no
   OR OLD.account_no IS NOT NEW.account_no
   OR OLD.iban IS NOT NEW.iban
   OR OLD.currency != NEW.currency
   OR OLD.ledger_account_no IS NOT NEW.ledger_account_no
   OR OLD.created_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'bank accounts are append-only; only the active flag may change');
END;

CREATE TRIGGER IF NOT EXISTS bank_accounts_no_delete
BEFORE DELETE ON bank_accounts
BEGIN
  SELECT RAISE(ABORT, 'bank accounts are append-only; deactivate them instead');
END;
-- ===== END BANK CLUSTER (#186-189,#182) =====

CREATE TRIGGER IF NOT EXISTS invoice_payments_require_journal
BEFORE INSERT ON invoice_payments
BEGIN
  SELECT RAISE(ABORT, 'invoice payments must reference a journal entry')
    WHERE NEW.journal_entry_id IS NULL;
  SELECT RAISE(ABORT, 'invoice payment journal evidence must match invoice, bank transaction, and payment date')
    WHERE NEW.journal_entry_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
          FROM journal_entries j
          JOIN documents d
            ON d.id = NEW.invoice_document_id
           AND d.document_type = 'issued_invoice'
         WHERE j.id = NEW.journal_entry_id
           AND j.status = 'posted'
           AND NOT EXISTS (
             SELECT 1 FROM journal_entries reversal
              WHERE reversal.reversal_of_entry_id = j.id
           )
           AND j.document_id IS NEW.invoice_document_id
           AND j.source_bank_transaction_id IS NEW.bank_transaction_id
           AND j.transaction_date = NEW.payment_date
           AND UPPER(TRIM(COALESCE(j.currency, 'DKK'))) = UPPER(TRIM(COALESCE(NEW.currency, 'DKK')))
      );
  SELECT RAISE(ABORT, 'invoice payment journal evidence must debit bank and credit debtors')
    WHERE NEW.journal_entry_id IS NOT NULL
      AND (
        NOT EXISTS (
          SELECT 1
            FROM journal_lines jl
            JOIN accounts a ON a.id = jl.account_id
           WHERE jl.journal_entry_id = NEW.journal_entry_id
             AND a.type = 'asset'
             AND a.normal_balance = 'debit'
             AND jl.debit_amount > 0
             AND jl.credit_amount = 0
        )
        OR NOT EXISTS (
          SELECT 1
            FROM journal_lines jl
            JOIN accounts a ON a.id = jl.account_id
           WHERE jl.journal_entry_id = NEW.journal_entry_id
             AND a.type = 'asset'
             AND a.normal_balance = 'debit'
             AND jl.credit_amount > 0
             AND jl.debit_amount = 0
        )
      );
END;

CREATE TRIGGER IF NOT EXISTS invoice_payments_no_update
BEFORE UPDATE ON invoice_payments
BEGIN
  SELECT RAISE(ABORT, 'invoice payments are append-only; add a correcting payment application instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_payments_no_delete
BEFORE DELETE ON invoice_payments
BEGIN
  SELECT RAISE(ABORT, 'invoice payments are append-only; add a correcting payment application instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_refunds_no_update
BEFORE UPDATE ON invoice_refunds
BEGIN
  SELECT RAISE(ABORT, 'invoice refunds are append-only; add a correcting refund application instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_refunds_require_journal
BEFORE INSERT ON invoice_refunds
BEGIN
  SELECT RAISE(ABORT, 'invoice refunds must reference a journal entry')
    WHERE NEW.journal_entry_id IS NULL;
  SELECT RAISE(ABORT, 'invoice refund journal evidence must match invoice, bank transaction, and refund date')
    WHERE NEW.journal_entry_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
          FROM journal_entries j
          JOIN documents d
            ON d.id = NEW.invoice_document_id
           AND d.document_type = 'issued_invoice'
         WHERE j.id = NEW.journal_entry_id
           AND j.status = 'posted'
           AND NOT EXISTS (
             SELECT 1 FROM journal_entries reversal
              WHERE reversal.reversal_of_entry_id = j.id
           )
           AND j.document_id IS NEW.invoice_document_id
           AND j.source_bank_transaction_id IS NEW.bank_transaction_id
           AND j.transaction_date = NEW.refund_date
           AND UPPER(TRIM(COALESCE(j.currency, 'DKK'))) = UPPER(TRIM(COALESCE(NEW.currency, 'DKK')))
      );
  SELECT RAISE(ABORT, 'invoice refund journal evidence must debit debtors and credit bank')
    WHERE NEW.journal_entry_id IS NOT NULL
      AND (
        NOT EXISTS (
          SELECT 1
            FROM journal_lines jl
            JOIN accounts a ON a.id = jl.account_id
           WHERE jl.journal_entry_id = NEW.journal_entry_id
             AND a.type = 'asset'
             AND a.normal_balance = 'debit'
             AND jl.debit_amount > 0
             AND jl.credit_amount = 0
        )
        OR NOT EXISTS (
          SELECT 1
            FROM journal_lines jl
            JOIN accounts a ON a.id = jl.account_id
           WHERE jl.journal_entry_id = NEW.journal_entry_id
             AND a.type = 'asset'
             AND a.normal_balance = 'debit'
             AND jl.credit_amount > 0
             AND jl.debit_amount = 0
        )
      );
END;

CREATE TRIGGER IF NOT EXISTS invoice_refunds_no_delete
BEFORE DELETE ON invoice_refunds
BEGIN
  SELECT RAISE(ABORT, 'invoice refunds are append-only; add a correcting refund application instead');
END;

CREATE TRIGGER IF NOT EXISTS issued_invoice_postings_no_update
BEFORE UPDATE ON issued_invoice_postings
BEGIN
  SELECT RAISE(ABORT, 'issued invoice posting links are append-only');
END;

CREATE TRIGGER IF NOT EXISTS issued_invoice_postings_validate_insert
BEFORE INSERT ON issued_invoice_postings
BEGIN
  SELECT RAISE(ABORT, 'invalid issued invoice posting identity')
    WHERE NOT EXISTS (
      SELECT 1
        FROM documents d
        JOIN journal_entries j
          ON j.id = NEW.journal_entry_id
         AND j.document_id = d.id
        JOIN accounts a ON a.id = NEW.receivable_account_id
       WHERE d.id = NEW.invoice_document_id
         AND d.document_type = 'issued_invoice'
         AND j.status = 'posted'
         AND j.reversal_of_entry_id IS NULL
         AND j.transaction_date = d.invoice_date
         AND j.source_bank_transaction_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM journal_entries reversal
            WHERE reversal.reversal_of_entry_id = j.id
         )
         AND a.type = 'asset'
         AND a.normal_balance = 'debit'
    );
  SELECT RAISE(ABORT, 'issued invoice posting effects do not match booked gross')
    WHERE CAST(ROUND(100 * (
            SELECT COALESCE(SUM(debit_amount), 0)
              FROM journal_lines
             WHERE journal_entry_id = NEW.journal_entry_id
          )) AS INTEGER) <> CAST(ROUND(100 * NEW.booked_gross_dkk) AS INTEGER)
       OR CAST(ROUND(100 * (
            SELECT COALESCE(SUM(credit_amount), 0)
              FROM journal_lines
             WHERE journal_entry_id = NEW.journal_entry_id
          )) AS INTEGER) <> CAST(ROUND(100 * NEW.booked_gross_dkk) AS INTEGER)
       OR CAST(ROUND(100 * (
            SELECT COALESCE(SUM(debit_amount) - SUM(credit_amount), 0)
              FROM journal_lines
             WHERE journal_entry_id = NEW.journal_entry_id
               AND account_id = NEW.receivable_account_id
          )) AS INTEGER) <> CAST(ROUND(100 * NEW.booked_gross_dkk) AS INTEGER)
       OR NOT EXISTS (
            SELECT 1
              FROM journal_lines jl
              JOIN accounts a ON a.id = jl.account_id
             WHERE jl.journal_entry_id = NEW.journal_entry_id
               AND jl.account_id <> NEW.receivable_account_id
               AND a.type = 'income'
               AND a.normal_balance = 'credit'
               AND jl.debit_amount = 0
               AND jl.credit_amount > 0
               AND jl.vat_code IS NOT NULL
          )
       OR EXISTS (
            SELECT 1
              FROM journal_lines jl
              JOIN accounts a ON a.id = jl.account_id
             WHERE jl.journal_entry_id = NEW.journal_entry_id
               AND jl.account_id <> NEW.receivable_account_id
               AND NOT (
                 (a.type = 'income' AND a.normal_balance = 'credit'
                  AND jl.debit_amount = 0 AND jl.credit_amount > 0
                  AND jl.vat_code IS NOT NULL)
                 OR
                 (a.type = 'vat' AND a.normal_balance = 'credit'
                  AND jl.debit_amount = 0 AND jl.credit_amount > 0
                  AND jl.vat_code IS NULL)
               )
          );
END;

CREATE TRIGGER IF NOT EXISTS issued_invoice_postings_no_delete
BEFORE DELETE ON issued_invoice_postings
BEGIN
  SELECT RAISE(ABORT, 'issued invoice posting links are append-only');
END;

CREATE TRIGGER IF NOT EXISTS credit_note_postings_no_update
BEFORE UPDATE ON credit_note_postings
BEGIN
  SELECT RAISE(ABORT, 'credit note posting links are append-only');
END;

CREATE TRIGGER IF NOT EXISTS credit_note_postings_validate_insert
BEFORE INSERT ON credit_note_postings
BEGIN
  SELECT RAISE(ABORT, 'invalid credit note posting identity')
    WHERE NOT EXISTS (
      SELECT 1
        FROM documents c
        JOIN documents original ON original.id = NEW.original_invoice_document_id
        JOIN issued_invoice_postings invoice_posting
          ON invoice_posting.invoice_document_id = original.id
         AND invoice_posting.receivable_account_id = NEW.receivable_account_id
        JOIN journal_entries j
          ON j.id = NEW.journal_entry_id
         AND j.document_id = c.id
        JOIN accounts a ON a.id = NEW.receivable_account_id
       WHERE c.id = NEW.credit_note_document_id
         AND c.document_type = 'credit_note'
         AND original.document_type = 'issued_invoice'
         AND c.payment_details IS original.invoice_no
         AND c.amount_inc_vat > 0
         AND UPPER(COALESCE(c.currency, 'DKK')) = UPPER(COALESCE(original.currency, 'DKK'))
         AND j.status = 'posted'
         AND j.reversal_of_entry_id IS NULL
         AND j.transaction_date = c.invoice_date
         AND j.source_bank_transaction_id IS NULL
         AND UPPER(COALESCE(j.currency, 'DKK')) = UPPER(COALESCE(c.currency, 'DKK'))
         AND (
           UPPER(COALESCE(c.currency, 'DKK')) = 'DKK'
           OR (
             j.amount_foreign > 0
             AND j.amount_dkk > 0
             AND j.fx_rate_to_dkk > 0
             AND CAST(ROUND(100 * j.amount_dkk) AS INTEGER) =
                 CAST(ROUND(100 * NEW.booked_gross_dkk) AS INTEGER)
             AND CAST(ROUND(100 * j.amount_foreign * j.fx_rate_to_dkk) AS INTEGER) =
                 CAST(ROUND(100 * j.amount_dkk) AS INTEGER)
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM journal_entries reversal
            WHERE reversal.reversal_of_entry_id = j.id
         )
         AND a.type = 'asset'
         AND a.normal_balance = 'debit'
    );
  SELECT RAISE(ABORT, 'credit note postings exceed original invoice amount')
    WHERE CAST(ROUND(100 * (
            SELECT COALESCE(SUM(existing_credit.amount_inc_vat), 0)
              FROM credit_note_postings existing_link
              JOIN documents existing_credit
                ON existing_credit.id = existing_link.credit_note_document_id
             WHERE existing_link.original_invoice_document_id = NEW.original_invoice_document_id
          )) AS INTEGER)
          + CAST(ROUND(100 * (
            SELECT amount_inc_vat FROM documents
             WHERE id = NEW.credit_note_document_id
          )) AS INTEGER)
          > CAST(ROUND(100 * (
            SELECT amount_inc_vat FROM documents
             WHERE id = NEW.original_invoice_document_id
          )) AS INTEGER)
       OR CAST(ROUND(100 * (
            SELECT COALESCE(SUM(booked_gross_dkk), 0)
              FROM credit_note_postings
             WHERE original_invoice_document_id = NEW.original_invoice_document_id
          )) AS INTEGER)
          + CAST(ROUND(100 * NEW.booked_gross_dkk) AS INTEGER)
          > CAST(ROUND(100 * (
            SELECT booked_gross_dkk
              FROM issued_invoice_postings
             WHERE invoice_document_id = NEW.original_invoice_document_id
          )) AS INTEGER);
  SELECT RAISE(ABORT, 'credit note posting effects do not match booked gross')
    WHERE CAST(ROUND(100 * (
            SELECT COALESCE(SUM(debit_amount), 0)
              FROM journal_lines
             WHERE journal_entry_id = NEW.journal_entry_id
          )) AS INTEGER) <> CAST(ROUND(100 * NEW.booked_gross_dkk) AS INTEGER)
       OR CAST(ROUND(100 * (
            SELECT COALESCE(SUM(credit_amount), 0)
              FROM journal_lines
             WHERE journal_entry_id = NEW.journal_entry_id
          )) AS INTEGER) <> CAST(ROUND(100 * NEW.booked_gross_dkk) AS INTEGER)
       OR CAST(ROUND(100 * (
            SELECT COALESCE(SUM(credit_amount) - SUM(debit_amount), 0)
              FROM journal_lines
             WHERE journal_entry_id = NEW.journal_entry_id
               AND account_id = NEW.receivable_account_id
          )) AS INTEGER) <> CAST(ROUND(100 * NEW.booked_gross_dkk) AS INTEGER)
       OR NOT EXISTS (
            SELECT 1
              FROM journal_lines jl
              JOIN accounts a ON a.id = jl.account_id
             WHERE jl.journal_entry_id = NEW.journal_entry_id
               AND jl.account_id <> NEW.receivable_account_id
               AND a.type = 'income'
               AND a.normal_balance = 'credit'
               AND jl.debit_amount > 0
               AND jl.credit_amount = 0
               AND jl.vat_code IS NOT NULL
          )
       OR EXISTS (
            SELECT 1
              FROM journal_lines jl
              JOIN accounts a ON a.id = jl.account_id
             WHERE jl.journal_entry_id = NEW.journal_entry_id
               AND jl.account_id <> NEW.receivable_account_id
               AND NOT (
                 (a.type = 'income' AND a.normal_balance = 'credit'
                  AND jl.debit_amount > 0 AND jl.credit_amount = 0
                  AND jl.vat_code IS NOT NULL)
                 OR
                 (a.type = 'vat' AND a.normal_balance = 'credit'
                  AND jl.debit_amount > 0 AND jl.credit_amount = 0
                  AND jl.vat_code IS NULL)
               )
          );
END;

CREATE TRIGGER IF NOT EXISTS credit_note_postings_no_delete
BEFORE DELETE ON credit_note_postings
BEGIN
  SELECT RAISE(ABORT, 'credit note posting links are append-only');
END;

CREATE TRIGGER IF NOT EXISTS invoice_reminders_no_update
BEFORE UPDATE ON invoice_reminders
BEGIN
  SELECT RAISE(ABORT, 'invoice reminders are append-only; add a later reminder or corrective note instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_reminders_no_delete
BEFORE DELETE ON invoice_reminders
BEGIN
  SELECT RAISE(ABORT, 'invoice reminders are append-only; add a corrective note instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_compensation_claims_no_update
BEFORE UPDATE ON invoice_compensation_claims
BEGIN
  SELECT RAISE(ABORT, 'invoice compensation claims are append-only; add a correcting note instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_compensation_claims_no_delete
BEFORE DELETE ON invoice_compensation_claims
BEGIN
  SELECT RAISE(ABORT, 'invoice compensation claims are append-only; add a corrective note instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_claims_no_update
BEFORE UPDATE ON invoice_interest_claims
BEGIN
  SELECT RAISE(ABORT, 'invoice interest claims are append-only; add a correcting note instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_claims_no_delete
BEFORE DELETE ON invoice_interest_claims
BEGIN
  SELECT RAISE(ABORT, 'invoice interest claims are append-only; add a corrective note instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_compensation_postings_validate_insert
BEFORE INSERT ON invoice_compensation_postings
BEGIN
  SELECT RAISE(ABORT, 'compensation posting must be an exact DKK receivable/income journal on or after the claim date')
    WHERE NOT EXISTS (
      SELECT 1
        FROM invoice_compensation_claims claim
        JOIN documents d
          ON d.id = claim.invoice_document_id
         AND d.document_type = 'issued_invoice'
         AND UPPER(TRIM(COALESCE(d.currency, 'DKK'))) = 'DKK'
        JOIN invoice_claim_posting_journal_evidence evidence
          ON evidence.journal_entry_id = NEW.journal_entry_id
       WHERE claim.id = NEW.compensation_claim_id
         AND evidence.document_id = claim.invoice_document_id
         AND evidence.transaction_date >= claim.claim_date
         AND evidence.source_bank_transaction_id IS NULL
         AND UPPER(TRIM(COALESCE(evidence.currency, 'DKK'))) = 'DKK'
         AND evidence.amount_foreign IS NULL
         AND evidence.amount_dkk IS NULL
         AND evidence.fx_rate_to_dkk IS NULL
         AND evidence.status = 'posted'
         AND evidence.reversal_of_entry_id IS NULL
         AND evidence.has_reversal = 0
         AND evidence.line_count >= 2
         AND evidence.invalid_line_count = 0
         AND evidence.total_debit_ore = CAST(ROUND(100 * claim.amount_dkk) AS INTEGER)
         AND evidence.total_credit_ore = CAST(ROUND(100 * claim.amount_dkk) AS INTEGER)
         AND evidence.receivable_debit_ore = CAST(ROUND(100 * claim.amount_dkk) AS INTEGER)
         AND evidence.income_credit_ore = CAST(ROUND(100 * claim.amount_dkk) AS INTEGER)
    );
END;

CREATE TRIGGER IF NOT EXISTS invoice_reminder_postings_validate_insert
BEFORE INSERT ON invoice_reminder_postings
BEGIN
  SELECT RAISE(ABORT, 'reminder posting must be an exact DKK receivable/income journal on or after the reminder date')
    WHERE NOT EXISTS (
      SELECT 1
        FROM invoice_reminders reminder
        JOIN documents d
          ON d.id = reminder.invoice_document_id
         AND d.document_type = 'issued_invoice'
         AND UPPER(TRIM(COALESCE(d.currency, 'DKK'))) = 'DKK'
        JOIN invoice_claim_posting_journal_evidence evidence
          ON evidence.journal_entry_id = NEW.journal_entry_id
       WHERE reminder.id = NEW.reminder_id
         AND UPPER(TRIM(COALESCE(reminder.currency, 'DKK'))) = 'DKK'
         AND evidence.document_id = reminder.invoice_document_id
         AND evidence.transaction_date >= reminder.reminder_date
         AND evidence.source_bank_transaction_id IS NULL
         AND UPPER(TRIM(COALESCE(evidence.currency, 'DKK'))) = 'DKK'
         AND evidence.amount_foreign IS NULL
         AND evidence.amount_dkk IS NULL
         AND evidence.fx_rate_to_dkk IS NULL
         AND evidence.status = 'posted'
         AND evidence.reversal_of_entry_id IS NULL
         AND evidence.has_reversal = 0
         AND evidence.line_count >= 2
         AND evidence.invalid_line_count = 0
         AND evidence.total_debit_ore = CAST(ROUND(100 * reminder.fee_amount) AS INTEGER)
         AND evidence.total_credit_ore = CAST(ROUND(100 * reminder.fee_amount) AS INTEGER)
         AND evidence.receivable_debit_ore = CAST(ROUND(100 * reminder.fee_amount) AS INTEGER)
         AND evidence.income_credit_ore = CAST(ROUND(100 * reminder.fee_amount) AS INTEGER)
    );
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_postings_validate_insert
BEFORE INSERT ON invoice_interest_postings
BEGIN
  SELECT RAISE(ABORT, 'interest posting must be an exact DKK receivable/income journal on or after the claim date')
    WHERE NOT EXISTS (
      SELECT 1
        FROM invoice_interest_claims claim
        JOIN documents d
          ON d.id = claim.invoice_document_id
         AND d.document_type = 'issued_invoice'
         AND UPPER(TRIM(COALESCE(d.currency, 'DKK'))) = 'DKK'
        JOIN invoice_claim_posting_journal_evidence evidence
          ON evidence.journal_entry_id = NEW.journal_entry_id
       WHERE claim.id = NEW.interest_claim_id
         AND evidence.document_id = claim.invoice_document_id
         AND evidence.transaction_date >= claim.claim_date
         AND evidence.source_bank_transaction_id IS NULL
         AND UPPER(TRIM(COALESCE(evidence.currency, 'DKK'))) = 'DKK'
         AND evidence.amount_foreign IS NULL
         AND evidence.amount_dkk IS NULL
         AND evidence.fx_rate_to_dkk IS NULL
         AND evidence.status = 'posted'
         AND evidence.reversal_of_entry_id IS NULL
         AND evidence.has_reversal = 0
         AND evidence.line_count >= 2
         AND evidence.invalid_line_count = 0
         AND evidence.total_debit_ore = CAST(ROUND(100 * claim.amount_dkk) AS INTEGER)
         AND evidence.total_credit_ore = CAST(ROUND(100 * claim.amount_dkk) AS INTEGER)
         AND evidence.receivable_debit_ore = CAST(ROUND(100 * claim.amount_dkk) AS INTEGER)
         AND evidence.income_credit_ore = CAST(ROUND(100 * claim.amount_dkk) AS INTEGER)
    );
END;

CREATE TRIGGER IF NOT EXISTS invoice_compensation_postings_no_update
BEFORE UPDATE ON invoice_compensation_postings
BEGIN
  SELECT RAISE(ABORT, 'invoice compensation postings are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_compensation_postings_no_delete
BEFORE DELETE ON invoice_compensation_postings
BEGIN
  SELECT RAISE(ABORT, 'invoice compensation postings are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_reminder_postings_no_update
BEFORE UPDATE ON invoice_reminder_postings
BEGIN
  SELECT RAISE(ABORT, 'invoice reminder postings are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_reminder_postings_no_delete
BEFORE DELETE ON invoice_reminder_postings
BEGIN
  SELECT RAISE(ABORT, 'invoice reminder postings are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_postings_no_update
BEFORE UPDATE ON invoice_interest_postings
BEGIN
  SELECT RAISE(ABORT, 'invoice interest postings are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_postings_no_delete
BEFORE DELETE ON invoice_interest_postings
BEGIN
  SELECT RAISE(ABORT, 'invoice interest postings are append-only; reverse the journal entry instead');
END;

-- Database-authoritative interest-correction evidence. The application plan is
-- never its own authority: these deterministic views reconstruct the lawful
-- per-claim/global ceiling in integer ore, the certainly outstanding receivable
-- and income capacity, and the exact historical-account allocation. The INSERT
-- trigger below requires an exact match, so a direct SQL caller cannot forge a
-- larger plan or move the correction onto unrelated/current accounts.
CREATE VIEW IF NOT EXISTS invoice_interest_correction_authorized_claims AS
WITH RECURSIVE
claim_windows AS (
  SELECT c.id AS claim_id,
         c.invoice_document_id,
         c.claim_date,
         c.reference_rate_percent,
         c.annual_interest_rate_percent,
         c.reference_rate_source,
         CAST(ROUND(c.amount_dkk * 100) AS INTEGER) AS claimed_ore,
         CAST(ROUND(COALESCE(d.amount_inc_vat, 0) * 100) AS INTEGER) AS gross_ore,
         COALESCE(
           (
             SELECT prior.claim_date
               FROM invoice_interest_claims prior
              WHERE prior.invoice_document_id = c.invoice_document_id
                AND (
                  prior.claim_date < c.claim_date
                  OR (prior.claim_date = c.claim_date AND prior.id < c.id)
                )
              ORDER BY prior.claim_date DESC, prior.id DESC
              LIMIT 1
           ),
           CASE
             WHEN json_valid(d.payload_json)
              AND json_type(d.payload_json, '$.dueDate') = 'text'
             THEN json_extract(d.payload_json, '$.dueDate')
           END,
           CASE WHEN d.invoice_date IS NOT NULL THEN date(d.invoice_date, '+30 days') END
         ) AS window_start,
         COALESCE(
           CASE
             WHEN json_valid(d.payload_json)
              AND json_type(d.payload_json, '$.dueDate') = 'text'
             THEN json_extract(d.payload_json, '$.dueDate')
           END,
           CASE WHEN d.invoice_date IS NOT NULL THEN date(d.invoice_date, '+30 days') END
         ) AS effective_due_date
    FROM invoice_interest_claims c
    JOIN documents d
      ON d.id = c.invoice_document_id
     AND d.document_type = 'issued_invoice'
    JOIN invoice_interest_postings posting
      ON posting.interest_claim_id = c.id
    JOIN journal_entries journal
      ON journal.id = posting.journal_entry_id
     AND journal.document_id = c.invoice_document_id
     AND journal.status = 'posted'
     AND journal.reversal_of_entry_id IS NULL
   WHERE NOT EXISTS (
     SELECT 1 FROM journal_entries reversal
      WHERE reversal.reversal_of_entry_id = journal.id
   )
),
balance_events AS (
  SELECT invoice_document_id,
         payment_date AS event_date,
         -CAST(ROUND(amount * 100) AS INTEGER) AS delta_ore
    FROM invoice_payments
  UNION ALL
  SELECT posting.original_invoice_document_id,
         credit.invoice_date,
         -CAST(ROUND(COALESCE(credit.amount_inc_vat, 0) * 100) AS INTEGER)
    FROM credit_note_postings posting
    JOIN documents credit
      ON credit.id = posting.credit_note_document_id
     AND credit.document_type = 'credit_note'
  UNION ALL
  SELECT invoice_document_id,
         refund_date,
         CAST(ROUND(amount * 100) AS INTEGER)
    FROM invoice_refunds
  UNION ALL
  SELECT invoice_document_id,
         writeoff_date,
         -CAST(ROUND(gross_amount * 100) AS INTEGER)
    FROM invoice_bad_debt_writeoffs
),
claim_events AS (
  SELECT window.claim_id,
         COALESCE(event.event_date, window.effective_due_date, window.window_start) AS event_date,
         event.delta_ore
    FROM claim_windows window
    JOIN balance_events event
      ON event.invoice_document_id = window.invoice_document_id
),
rate_boundaries(claim_id, boundary, claim_date) AS (
  SELECT claim_id,
         CASE
           WHEN substr(window_start, 6, 5) < '07-01'
             THEN substr(window_start, 1, 4) || '-07-01'
           ELSE printf('%04d-01-01', CAST(substr(window_start, 1, 4) AS INTEGER) + 1)
         END,
         claim_date
    FROM claim_windows
   WHERE reference_rate_source = 'statutory-table'
     AND window_start IS NOT NULL
     AND window_start < claim_date
     AND CASE
           WHEN substr(window_start, 6, 5) < '07-01'
             THEN substr(window_start, 1, 4) || '-07-01'
           ELSE printf('%04d-01-01', CAST(substr(window_start, 1, 4) AS INTEGER) + 1)
         END < claim_date
  UNION ALL
  SELECT claim_id, date(boundary, '+6 months'), claim_date
    FROM rate_boundaries
   WHERE date(boundary, '+6 months') < claim_date
),
breakpoints AS (
  SELECT claim_id, window_start AS breakpoint
    FROM claim_windows
   WHERE window_start IS NOT NULL
  UNION
  SELECT claim_id, claim_date
    FROM claim_windows
  UNION
  SELECT event.claim_id, event.event_date
    FROM claim_events event
    JOIN claim_windows window ON window.claim_id = event.claim_id
   WHERE event.event_date > window.window_start
     AND event.event_date < window.claim_date
  UNION
  SELECT claim_id, boundary
    FROM rate_boundaries
),
ordered_segments AS (
  SELECT claim_id,
         breakpoint AS segment_start,
         LEAD(breakpoint) OVER (PARTITION BY claim_id ORDER BY breakpoint) AS segment_end
    FROM breakpoints
),
segment_values AS (
  SELECT window.claim_id,
         window.invoice_document_id,
         window.claim_date,
         window.claimed_ore,
         segment.segment_start,
         segment.segment_end,
         MAX(
           0,
           window.gross_ore + COALESCE((
             SELECT SUM(event.delta_ore)
               FROM claim_events event
              WHERE event.claim_id = window.claim_id
                AND event.event_date <= segment.segment_start
           ), 0)
         ) AS principal_ore,
         CASE
           WHEN window.reference_rate_source = 'manual-override'
             THEN CAST(ROUND(window.annual_interest_rate_percent * 100) AS INTEGER)
           WHEN segment.segment_start >= '2025-07-01' THEN 975
           WHEN segment.segment_start >= '2025-01-01' THEN 1075
           WHEN segment.segment_start >= '2024-07-01' THEN 1150
           WHEN segment.segment_start >= '2024-01-01' THEN 1175
           WHEN segment.segment_start >= '2023-07-01' THEN 1125
           WHEN segment.segment_start >= '2023-01-01' THEN 990
           ELSE CAST(ROUND((window.reference_rate_percent + 8) * 100) AS INTEGER)
         END AS annual_rate_basis_points,
         CAST(julianday(segment.segment_end) - julianday(segment.segment_start) AS INTEGER) AS segment_days
    FROM claim_windows window
    JOIN ordered_segments segment ON segment.claim_id = window.claim_id
   WHERE segment.segment_end IS NOT NULL
     AND segment.segment_end > segment.segment_start
),
claim_numerators AS (
  SELECT window.claim_id,
         window.invoice_document_id,
         window.claim_date,
         window.claimed_ore,
         window.window_start,
         COALESCE(SUM(
           CAST(CAST(segment.principal_ore AS INTEGER) / 3650000 AS INTEGER)
           * CAST(segment.annual_rate_basis_points AS INTEGER)
           * CAST(segment.segment_days AS INTEGER)
         ), 0) AS lawful_whole_ore,
         COALESCE(SUM(
           (CAST(segment.principal_ore AS INTEGER) % 3650000)
           * CAST(segment.annual_rate_basis_points AS INTEGER)
           * CAST(segment.segment_days AS INTEGER)
         ), 0) AS lawful_remainder_numerator
    FROM claim_windows window
    LEFT JOIN segment_values segment ON segment.claim_id = window.claim_id
   GROUP BY window.claim_id, window.invoice_document_id, window.claim_date,
            window.claimed_ore, window.window_start
),
claim_math AS (
  SELECT claim_id,
         invoice_document_id,
         claim_date,
         claimed_ore,
         lawful_whole_ore,
         lawful_remainder_numerator,
         CASE
           WHEN window_start IS NULL THEN claimed_ore
           ELSE lawful_whole_ore
                + CAST((lawful_remainder_numerator + 1825000) / 3650000 AS INTEGER)
         END AS lawful_ore
    FROM claim_numerators
),
invoice_math AS (
  SELECT invoice_document_id,
         MAX(
           0,
           SUM(claimed_ore)
           - SUM(lawful_whole_ore)
           - CAST((SUM(lawful_remainder_numerator) + 1825000) / 3650000 AS INTEGER)
         ) AS global_ceiling_ore
    FROM claim_math
   GROUP BY invoice_document_id
),
raw_claims AS (
  SELECT claim.claim_id,
         claim.invoice_document_id,
         claim.claim_date,
         MAX(0, claim.claimed_ore - claim.lawful_ore) AS raw_ceiling_ore,
         invoice.global_ceiling_ore
    FROM claim_math claim
    JOIN invoice_math invoice USING (invoice_document_id)
),
positive_claims AS (
  SELECT *,
         COALESCE(SUM(raw_ceiling_ore) OVER (
           PARTITION BY invoice_document_id
           ORDER BY claim_date, claim_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ), 0) AS prior_raw_ore,
         SUM(raw_ceiling_ore) OVER (PARTITION BY invoice_document_id) AS total_raw_ore,
         ROW_NUMBER() OVER (
           PARTITION BY invoice_document_id
           ORDER BY claim_date DESC, claim_id DESC
         ) AS reverse_rank
    FROM raw_claims
   WHERE raw_ceiling_ore > 0
),
allocated AS (
  SELECT claim_id,
         invoice_document_id,
         claim_date,
         raw_ceiling_ore,
         global_ceiling_ore,
         MIN(raw_ceiling_ore, MAX(0, global_ceiling_ore - prior_raw_ore))
         + CASE
             WHEN reverse_rank = 1 AND global_ceiling_ore > total_raw_ore
             THEN global_ceiling_ore - total_raw_ore
             ELSE 0
           END AS authorised_ceiling_ore
    FROM positive_claims
)
SELECT claim_id,
       invoice_document_id,
       claim_date,
       raw_ceiling_ore / 100.0 AS raw_ceiling_dkk,
       global_ceiling_ore / 100.0 AS global_ceiling_dkk,
       authorised_ceiling_ore / 100.0 AS authorised_ceiling_dkk
 FROM allocated
 WHERE authorised_ceiling_ore > 0;

CREATE VIEW IF NOT EXISTS invoice_interest_correction_receivable_capacity AS
WITH
claim_asset_origins AS (
  SELECT reminder.invoice_document_id,
         'other' AS claim_kind,
         account.account_no,
         CAST(ROUND(SUM(line.debit_amount - line.credit_amount) * 100) AS INTEGER) AS effect_ore
    FROM invoice_reminders reminder
    JOIN invoice_reminder_postings posting ON posting.reminder_id = reminder.id
    JOIN journal_entries journal
      ON journal.id = posting.journal_entry_id
     AND journal.document_id = reminder.invoice_document_id
     AND journal.status = 'posted'
     AND journal.reversal_of_entry_id IS NULL
    JOIN journal_lines line ON line.journal_entry_id = journal.id
    JOIN accounts account
      ON account.id = line.account_id
     AND account.type = 'asset'
     AND account.normal_balance = 'debit'
   WHERE NOT EXISTS (SELECT 1 FROM journal_entries reversal WHERE reversal.reversal_of_entry_id = journal.id)
   GROUP BY reminder.invoice_document_id, account.account_no
  UNION ALL
  SELECT claim.invoice_document_id,
         'other',
         account.account_no,
         CAST(ROUND(SUM(line.debit_amount - line.credit_amount) * 100) AS INTEGER)
    FROM invoice_compensation_claims claim
    JOIN invoice_compensation_postings posting ON posting.compensation_claim_id = claim.id
    JOIN journal_entries journal
      ON journal.id = posting.journal_entry_id
     AND journal.document_id = claim.invoice_document_id
     AND journal.status = 'posted'
     AND journal.reversal_of_entry_id IS NULL
    JOIN journal_lines line ON line.journal_entry_id = journal.id
    JOIN accounts account
      ON account.id = line.account_id
     AND account.type = 'asset'
     AND account.normal_balance = 'debit'
   WHERE NOT EXISTS (SELECT 1 FROM journal_entries reversal WHERE reversal.reversal_of_entry_id = journal.id)
   GROUP BY claim.invoice_document_id, account.account_no
  UNION ALL
  SELECT claim.invoice_document_id,
         'interest',
         account.account_no,
         CAST(ROUND(SUM(line.debit_amount - line.credit_amount) * 100) AS INTEGER)
    FROM invoice_interest_claims claim
    JOIN invoice_interest_postings posting ON posting.interest_claim_id = claim.id
    JOIN journal_entries journal
      ON journal.id = posting.journal_entry_id
     AND journal.document_id = claim.invoice_document_id
     AND journal.status = 'posted'
     AND journal.reversal_of_entry_id IS NULL
    JOIN journal_lines line ON line.journal_entry_id = journal.id
    JOIN accounts account
      ON account.id = line.account_id
     AND account.type = 'asset'
     AND account.normal_balance = 'debit'
   WHERE NOT EXISTS (SELECT 1 FROM journal_entries reversal WHERE reversal.reversal_of_entry_id = journal.id)
   GROUP BY claim.invoice_document_id, account.account_no
),
correction_asset_effects AS (
  SELECT correction.invoice_document_id,
         account.account_no,
         CAST(ROUND(SUM(line.debit_amount - line.credit_amount) * 100) AS INTEGER) AS effect_ore
    FROM invoice_interest_corrections correction
    JOIN journal_entries journal
      ON journal.id = correction.journal_entry_id
     AND journal.document_id = correction.invoice_document_id
     AND journal.status = 'posted'
     AND journal.reversal_of_entry_id IS NULL
    JOIN journal_lines line ON line.journal_entry_id = journal.id
    JOIN accounts account
      ON account.id = line.account_id
     AND account.type = 'asset'
     AND account.normal_balance = 'debit'
   WHERE NOT EXISTS (SELECT 1 FROM journal_entries reversal WHERE reversal.reversal_of_entry_id = journal.id)
   GROUP BY correction.invoice_document_id, account.account_no
),
origin_accounts AS (
  SELECT invoice_document_id, account_no FROM claim_asset_origins
  UNION
  SELECT invoice_document_id, account_no FROM correction_asset_effects
),
origin_balances AS (
  SELECT key.invoice_document_id,
         key.account_no,
         MAX(0, COALESCE((
           SELECT SUM(origin.effect_ore)
             FROM claim_asset_origins origin
            WHERE origin.invoice_document_id = key.invoice_document_id
              AND origin.account_no = key.account_no
              AND origin.claim_kind = 'interest'
         ), 0) + COALESCE((
           SELECT SUM(correction.effect_ore)
             FROM correction_asset_effects correction
            WHERE correction.invoice_document_id = key.invoice_document_id
              AND correction.account_no = key.account_no
         ), 0)) AS interest_ore,
         MAX(0, COALESCE((
           SELECT SUM(origin.effect_ore)
             FROM claim_asset_origins origin
            WHERE origin.invoice_document_id = key.invoice_document_id
              AND origin.account_no = key.account_no
              AND origin.claim_kind = 'other'
         ), 0)) AS other_ore
    FROM origin_accounts key
),
with_payments AS (
  SELECT balance.*,
         COALESCE((
           SELECT SUM(CAST(ROUND(payment.amount * 100) AS INTEGER))
             FROM invoice_claim_payments payment
            WHERE payment.invoice_document_id = balance.invoice_document_id
         ), 0) AS paid_ore,
         COALESCE(SUM(balance.interest_ore + balance.other_ore) OVER (
           PARTITION BY balance.invoice_document_id
           ORDER BY balance.account_no
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ), 0) AS prior_origin_ore
    FROM origin_balances balance
),
remaining AS (
  SELECT *,
         interest_ore + other_ore
         - MIN(interest_ore + other_ore, MAX(0, paid_ore - prior_origin_ore)) AS aggregate_remaining_ore
    FROM with_payments
)
SELECT invoice_document_id,
       account_no,
       MIN(interest_ore, MAX(0, aggregate_remaining_ore - other_ore)) / 100.0 AS certain_interest_dkk
  FROM remaining
 WHERE MIN(interest_ore, MAX(0, aggregate_remaining_ore - other_ore)) > 0;

CREATE VIEW IF NOT EXISTS invoice_interest_correction_income_capacity AS
WITH income_effects AS (
  SELECT claim.invoice_document_id,
         account.account_no,
         CAST(ROUND(SUM(line.credit_amount - line.debit_amount) * 100) AS INTEGER) AS effect_ore
    FROM invoice_interest_claims claim
    JOIN invoice_interest_postings posting ON posting.interest_claim_id = claim.id
    JOIN journal_entries journal
      ON journal.id = posting.journal_entry_id
     AND journal.document_id = claim.invoice_document_id
     AND journal.status = 'posted'
     AND journal.reversal_of_entry_id IS NULL
    JOIN journal_lines line ON line.journal_entry_id = journal.id
    JOIN accounts account
      ON account.id = line.account_id
     AND account.type = 'income'
     AND account.normal_balance = 'credit'
   WHERE NOT EXISTS (SELECT 1 FROM journal_entries reversal WHERE reversal.reversal_of_entry_id = journal.id)
   GROUP BY claim.invoice_document_id, account.account_no
  UNION ALL
  SELECT correction.invoice_document_id,
         account.account_no,
         CAST(ROUND(SUM(line.credit_amount - line.debit_amount) * 100) AS INTEGER)
    FROM invoice_interest_corrections correction
    JOIN journal_entries journal
      ON journal.id = correction.journal_entry_id
     AND journal.document_id = correction.invoice_document_id
     AND journal.status = 'posted'
     AND journal.reversal_of_entry_id IS NULL
    JOIN journal_lines line ON line.journal_entry_id = journal.id
    JOIN accounts account
      ON account.id = line.account_id
     AND account.type = 'income'
     AND account.normal_balance = 'credit'
   WHERE NOT EXISTS (SELECT 1 FROM journal_entries reversal WHERE reversal.reversal_of_entry_id = journal.id)
   GROUP BY correction.invoice_document_id, account.account_no
)
SELECT invoice_document_id,
       account_no,
       SUM(effect_ore) / 100.0 AS available_income_dkk
  FROM income_effects
 GROUP BY invoice_document_id, account_no
HAVING SUM(effect_ore) > 0;

CREATE VIEW IF NOT EXISTS invoice_interest_correction_expected_plan_lines AS
WITH claim_account_effects AS (
  SELECT planned.journal_entry_id,
         planned.interest_claim_id,
         planned.amount_dkk,
         account.account_no,
         'receivable_credit' AS effect_kind,
         CAST(ROUND(SUM(line.debit_amount - line.credit_amount) * 100) AS INTEGER) AS available_ore
    FROM invoice_interest_correction_plan_claims planned
    JOIN invoice_interest_postings posting ON posting.interest_claim_id = planned.interest_claim_id
    JOIN journal_entries journal ON journal.id = posting.journal_entry_id
    JOIN journal_lines line ON line.journal_entry_id = journal.id
    JOIN accounts account
      ON account.id = line.account_id
     AND account.type = 'asset'
     AND account.normal_balance = 'debit'
   GROUP BY planned.journal_entry_id, planned.interest_claim_id, planned.amount_dkk, account.account_no
  UNION ALL
  SELECT planned.journal_entry_id,
         planned.interest_claim_id,
         planned.amount_dkk,
         account.account_no,
         'income_debit',
         CAST(ROUND(SUM(line.credit_amount - line.debit_amount) * 100) AS INTEGER)
    FROM invoice_interest_correction_plan_claims planned
    JOIN invoice_interest_postings posting ON posting.interest_claim_id = planned.interest_claim_id
    JOIN journal_entries journal ON journal.id = posting.journal_entry_id
    JOIN journal_lines line ON line.journal_entry_id = journal.id
    JOIN accounts account
      ON account.id = line.account_id
     AND account.type = 'income'
     AND account.normal_balance = 'credit'
   GROUP BY planned.journal_entry_id, planned.interest_claim_id, planned.amount_dkk, account.account_no
),
ordered_effects AS (
  SELECT *,
         COALESCE(SUM(available_ore) OVER (
           PARTITION BY journal_entry_id, interest_claim_id, effect_kind
           ORDER BY account_no
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ), 0) AS prior_available_ore
    FROM claim_account_effects
   WHERE available_ore > 0
),
allocations AS (
  SELECT journal_entry_id,
         account_no,
         effect_kind,
         MIN(
           available_ore,
           MAX(0, CAST(ROUND(amount_dkk * 100) AS INTEGER) - prior_available_ore)
         ) AS allocated_ore
    FROM ordered_effects
),
aggregated AS (
  SELECT journal_entry_id,
         account_no,
         SUM(CASE WHEN effect_kind = 'income_debit' THEN allocated_ore ELSE 0 END) AS debit_ore,
         SUM(CASE WHEN effect_kind = 'receivable_credit' THEN allocated_ore ELSE 0 END) AS credit_ore
    FROM allocations
   WHERE allocated_ore > 0
   GROUP BY journal_entry_id, account_no
)
SELECT journal_entry_id,
       account_no,
       debit_ore / 100.0 AS debit_amount,
       credit_ore / 100.0 AS credit_amount
  FROM aggregated;

CREATE TRIGGER IF NOT EXISTS invoice_interest_corrections_validate_insert
BEFORE INSERT ON invoice_interest_corrections
BEGIN
  SELECT RAISE(ABORT, 'invalid interest correction journal identity')
    WHERE NOT EXISTS (
      SELECT 1
        FROM documents d
        JOIN journal_entries j
          ON j.id = NEW.journal_entry_id
         AND j.document_id = d.id
       WHERE d.id = NEW.invoice_document_id
         AND d.document_type = 'issued_invoice'
         AND j.transaction_date = NEW.correction_date
         AND j.status = 'posted'
         AND j.reversal_of_entry_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM journal_entries reversal
            WHERE reversal.reversal_of_entry_id = j.id
         )
         AND UPPER(COALESCE(j.currency, 'DKK')) = 'DKK'
         AND j.amount_foreign IS NULL
         AND j.amount_dkk IS NULL
         AND j.fx_rate_to_dkk IS NULL
         AND j.source_bank_transaction_id IS NULL
    );
  SELECT RAISE(ABORT, 'interest correction journal effects do not match amount')
    WHERE CAST(ROUND(100 * (
            SELECT COALESCE(SUM(debit_amount), 0)
              FROM journal_lines
             WHERE journal_entry_id = NEW.journal_entry_id
          )) AS INTEGER) <> CAST(ROUND(100 * NEW.amount_dkk) AS INTEGER)
       OR CAST(ROUND(100 * (
            SELECT COALESCE(SUM(credit_amount), 0)
              FROM journal_lines
             WHERE journal_entry_id = NEW.journal_entry_id
          )) AS INTEGER) <> CAST(ROUND(100 * NEW.amount_dkk) AS INTEGER)
       OR NOT EXISTS (
            SELECT 1 FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
             WHERE jl.journal_entry_id = NEW.journal_entry_id
               AND a.type = 'income' AND a.normal_balance = 'credit'
               AND jl.debit_amount > 0 AND jl.credit_amount = 0
          )
       OR NOT EXISTS (
            SELECT 1 FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
             WHERE jl.journal_entry_id = NEW.journal_entry_id
               AND a.type = 'asset' AND a.normal_balance = 'debit'
               AND jl.credit_amount > 0 AND jl.debit_amount = 0
          )
       OR EXISTS (
            SELECT 1 FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
             WHERE jl.journal_entry_id = NEW.journal_entry_id
               AND NOT (
                 (a.type = 'income' AND a.normal_balance = 'credit'
                  AND jl.debit_amount > 0 AND jl.credit_amount = 0)
                 OR
                 (a.type = 'asset' AND a.normal_balance = 'debit'
                  AND jl.credit_amount > 0 AND jl.debit_amount = 0)
               )
          );
  SELECT RAISE(ABORT, 'interest correction requires an exact one-time causal plan')
    WHERE NOT EXISTS (
      SELECT 1
        FROM invoice_interest_correction_plans plan
       WHERE plan.journal_entry_id = NEW.journal_entry_id
         AND plan.invoice_document_id = NEW.invoice_document_id
         AND plan.correction_date = NEW.correction_date
         AND CAST(ROUND(plan.amount_dkk * 100) AS INTEGER) = CAST(ROUND(NEW.amount_dkk * 100) AS INTEGER)
    );
  SELECT RAISE(ABORT, 'interest correction causal claim plan is invalid or exceeds its ceiling')
    WHERE NOT EXISTS (
            SELECT 1
              FROM invoice_interest_correction_plan_claims
             WHERE journal_entry_id = NEW.journal_entry_id
          )
       OR CAST(ROUND(100 * (
            SELECT COALESCE(SUM(amount_dkk), 0)
              FROM invoice_interest_correction_plan_claims
             WHERE journal_entry_id = NEW.journal_entry_id
          )) AS INTEGER) <> CAST(ROUND(100 * NEW.amount_dkk) AS INTEGER)
       OR EXISTS (
            SELECT 1
              FROM invoice_interest_correction_plan_claims planned
              LEFT JOIN invoice_interest_claims claim
                ON claim.id = planned.interest_claim_id
              LEFT JOIN invoice_interest_postings posting
                ON posting.interest_claim_id = claim.id
              LEFT JOIN journal_entries claim_journal
                ON claim_journal.id = posting.journal_entry_id
              LEFT JOIN invoice_interest_correction_authorized_claims authority
                ON authority.claim_id = planned.interest_claim_id
               AND authority.invoice_document_id = NEW.invoice_document_id
             WHERE planned.journal_entry_id = NEW.journal_entry_id
               AND (
                 claim.id IS NULL
                 OR claim.invoice_document_id <> NEW.invoice_document_id
                 OR planned.claim_date <> claim.claim_date
                 OR NEW.correction_date < claim.claim_date
                 OR CAST(ROUND(planned.amount_dkk * 100) AS INTEGER) > CAST(ROUND(planned.claim_ceiling_dkk * 100) AS INTEGER)
                 OR authority.claim_id IS NULL
                 OR CAST(ROUND(planned.claim_ceiling_dkk * 100) AS INTEGER)
                    <> CAST(ROUND(authority.authorised_ceiling_dkk * 100) AS INTEGER)
                 OR posting.id IS NULL
                 OR claim_journal.status <> 'posted'
                 OR claim_journal.reversal_of_entry_id IS NOT NULL
                 OR EXISTS (
                   SELECT 1 FROM journal_entries claim_reversal
                    WHERE claim_reversal.reversal_of_entry_id = claim_journal.id
                 )
                 OR CAST(ROUND(100 * (
                      SELECT COALESCE(SUM(prior_planned.amount_dkk), 0)
                        FROM invoice_interest_correction_plan_claims prior_planned
                        JOIN invoice_interest_corrections prior_correction
                          ON prior_correction.journal_entry_id = prior_planned.journal_entry_id
                       WHERE prior_planned.interest_claim_id = planned.interest_claim_id
                    )) AS INTEGER) + CAST(ROUND(planned.amount_dkk * 100) AS INTEGER)
                    > CAST(ROUND(planned.claim_ceiling_dkk * 100) AS INTEGER)
               )
          );
  SELECT RAISE(ABORT, 'interest correction journal does not exactly match its planned accounts')
    WHERE NOT EXISTS (
            SELECT 1
              FROM invoice_interest_correction_plan_lines
             WHERE journal_entry_id = NEW.journal_entry_id
          )
       OR CAST(ROUND(100 * (
            SELECT COALESCE(SUM(debit_amount), 0)
              FROM invoice_interest_correction_plan_lines
             WHERE journal_entry_id = NEW.journal_entry_id
          )) AS INTEGER) <> CAST(ROUND(100 * NEW.amount_dkk) AS INTEGER)
       OR CAST(ROUND(100 * (
            SELECT COALESCE(SUM(credit_amount), 0)
              FROM invoice_interest_correction_plan_lines
             WHERE journal_entry_id = NEW.journal_entry_id
          )) AS INTEGER) <> CAST(ROUND(100 * NEW.amount_dkk) AS INTEGER)
       OR EXISTS (
            SELECT 1
              FROM invoice_interest_correction_plan_lines planned
             WHERE planned.journal_entry_id = NEW.journal_entry_id
               AND (
                 CAST(ROUND(planned.debit_amount * 100) AS INTEGER) <> CAST(ROUND(100 * (
                   SELECT COALESCE(SUM(lines.debit_amount), 0)
                     FROM journal_lines lines
                     JOIN accounts account ON account.id = lines.account_id
                    WHERE lines.journal_entry_id = NEW.journal_entry_id
                      AND account.account_no = planned.account_no
                 )) AS INTEGER)
                 OR CAST(ROUND(planned.credit_amount * 100) AS INTEGER) <> CAST(ROUND(100 * (
                   SELECT COALESCE(SUM(lines.credit_amount), 0)
                     FROM journal_lines lines
                     JOIN accounts account ON account.id = lines.account_id
                    WHERE lines.journal_entry_id = NEW.journal_entry_id
                      AND account.account_no = planned.account_no
                 )) AS INTEGER)
               )
          )
       OR EXISTS (
            SELECT 1
              FROM journal_lines lines
              JOIN accounts account ON account.id = lines.account_id
             WHERE lines.journal_entry_id = NEW.journal_entry_id
               AND NOT EXISTS (
                 SELECT 1
                   FROM invoice_interest_correction_plan_lines planned
                  WHERE planned.journal_entry_id = NEW.journal_entry_id
                    AND planned.account_no = account.account_no
               )
          )
       OR EXISTS (
            SELECT 1
              FROM invoice_interest_correction_plan_lines planned
             WHERE planned.journal_entry_id = NEW.journal_entry_id
               AND NOT EXISTS (
                 SELECT 1
                   FROM invoice_interest_correction_expected_plan_lines expected
                  WHERE expected.journal_entry_id = planned.journal_entry_id
                    AND expected.account_no = planned.account_no
                    AND CAST(ROUND(expected.debit_amount * 100) AS INTEGER)
                        = CAST(ROUND(planned.debit_amount * 100) AS INTEGER)
                    AND CAST(ROUND(expected.credit_amount * 100) AS INTEGER)
                        = CAST(ROUND(planned.credit_amount * 100) AS INTEGER)
               )
          )
       OR EXISTS (
            SELECT 1
              FROM invoice_interest_correction_expected_plan_lines expected
             WHERE expected.journal_entry_id = NEW.journal_entry_id
               AND NOT EXISTS (
                 SELECT 1
                   FROM invoice_interest_correction_plan_lines planned
                  WHERE planned.journal_entry_id = expected.journal_entry_id
                    AND planned.account_no = expected.account_no
                    AND CAST(ROUND(planned.debit_amount * 100) AS INTEGER)
                        = CAST(ROUND(expected.debit_amount * 100) AS INTEGER)
                    AND CAST(ROUND(planned.credit_amount * 100) AS INTEGER)
                        = CAST(ROUND(expected.credit_amount * 100) AS INTEGER)
               )
          )
       OR EXISTS (
            SELECT 1
              FROM invoice_interest_correction_plan_lines planned
             WHERE planned.journal_entry_id = NEW.journal_entry_id
               AND planned.credit_amount > 0
               AND CAST(ROUND(planned.credit_amount * 100) AS INTEGER) > COALESCE((
                 SELECT CAST(ROUND(capacity.certain_interest_dkk * 100) AS INTEGER)
                   FROM invoice_interest_correction_receivable_capacity capacity
                  WHERE capacity.invoice_document_id = NEW.invoice_document_id
                    AND capacity.account_no = planned.account_no
               ), 0)
          )
       OR EXISTS (
            SELECT 1
              FROM invoice_interest_correction_plan_lines planned
             WHERE planned.journal_entry_id = NEW.journal_entry_id
               AND planned.debit_amount > 0
               AND CAST(ROUND(planned.debit_amount * 100) AS INTEGER) > COALESCE((
                 SELECT CAST(ROUND(capacity.available_income_dkk * 100) AS INTEGER)
                   FROM invoice_interest_correction_income_capacity capacity
                  WHERE capacity.invoice_document_id = NEW.invoice_document_id
                    AND capacity.account_no = planned.account_no
               ), 0)
          );
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_correction_plans_no_update
BEFORE UPDATE ON invoice_interest_correction_plans
BEGIN
  SELECT RAISE(ABORT, 'invoice interest correction plans are append-only');
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_correction_plans_no_delete
BEFORE DELETE ON invoice_interest_correction_plans
BEGIN
  SELECT RAISE(ABORT, 'invoice interest correction plans are append-only');
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_correction_plan_claims_no_update
BEFORE UPDATE ON invoice_interest_correction_plan_claims
BEGIN
  SELECT RAISE(ABORT, 'invoice interest correction causal claims are append-only');
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_correction_plan_claims_validate_insert
BEFORE INSERT ON invoice_interest_correction_plan_claims
BEGIN
  SELECT RAISE(ABORT, 'interest correction claim plan exceeds the DB-authoritative lawful ceiling')
    WHERE NOT EXISTS (
      SELECT 1
        FROM invoice_interest_correction_plans plan
        JOIN invoice_interest_correction_authorized_claims authority
          ON authority.claim_id = NEW.interest_claim_id
         AND authority.invoice_document_id = plan.invoice_document_id
       WHERE plan.journal_entry_id = NEW.journal_entry_id
         AND NEW.claim_date = authority.claim_date
         AND CAST(ROUND(NEW.claim_ceiling_dkk * 100) AS INTEGER)
             = CAST(ROUND(authority.authorised_ceiling_dkk * 100) AS INTEGER)
         AND CAST(ROUND(100 * (
               SELECT COALESCE(SUM(prior_planned.amount_dkk), 0)
                 FROM invoice_interest_correction_plan_claims prior_planned
                 JOIN invoice_interest_corrections prior_correction
                   ON prior_correction.journal_entry_id = prior_planned.journal_entry_id
                WHERE prior_planned.interest_claim_id = NEW.interest_claim_id
             )) AS INTEGER)
             + CAST(ROUND(NEW.amount_dkk * 100) AS INTEGER)
             <= CAST(ROUND(authority.authorised_ceiling_dkk * 100) AS INTEGER)
    );
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_correction_plan_claims_no_delete
BEFORE DELETE ON invoice_interest_correction_plan_claims
BEGIN
  SELECT RAISE(ABORT, 'invoice interest correction causal claims are append-only');
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_correction_plan_lines_no_update
BEFORE UPDATE ON invoice_interest_correction_plan_lines
BEGIN
  SELECT RAISE(ABORT, 'invoice interest correction plan lines are append-only');
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_correction_plan_lines_no_delete
BEFORE DELETE ON invoice_interest_correction_plan_lines
BEGIN
  SELECT RAISE(ABORT, 'invoice interest correction plan lines are append-only');
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_corrections_no_update
BEFORE UPDATE ON invoice_interest_corrections
BEGIN
  SELECT RAISE(ABORT, 'invoice interest corrections are append-only; add another correction instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_corrections_no_delete
BEFORE DELETE ON invoice_interest_corrections
BEGIN
  SELECT RAISE(ABORT, 'invoice interest corrections are append-only; add another correction instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_claim_payments_no_update
BEFORE UPDATE ON invoice_claim_payments
BEGIN
  SELECT RAISE(ABORT, 'invoice claim payments are append-only; add a correcting claim payment application instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_claim_payments_require_journal
BEFORE INSERT ON invoice_claim_payments
BEGIN
  SELECT RAISE(ABORT, 'invoice claim payments must reference a journal entry')
    WHERE NEW.journal_entry_id IS NULL;
  SELECT RAISE(ABORT, 'invoice claim payment journal evidence must match invoice, bank transaction, and payment date')
    WHERE NEW.journal_entry_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
          FROM journal_entries j
          JOIN documents d
            ON d.id = NEW.invoice_document_id
           AND d.document_type = 'issued_invoice'
         WHERE j.id = NEW.journal_entry_id
           AND j.status = 'posted'
           AND NOT EXISTS (
             SELECT 1 FROM journal_entries reversal
              WHERE reversal.reversal_of_entry_id = j.id
           )
           AND j.document_id IS NEW.invoice_document_id
           AND j.source_bank_transaction_id IS NEW.bank_transaction_id
           AND j.transaction_date = NEW.payment_date
           AND UPPER(TRIM(COALESCE(j.currency, 'DKK'))) = UPPER(TRIM(COALESCE(NEW.currency, 'DKK')))
      );
  SELECT RAISE(ABORT, 'invoice claim payment cannot predate its active claim evidence')
    WHERE EXISTS (
      SELECT 1
        FROM (
          SELECT reminder.invoice_document_id,
                 reminder.reminder_date AS effective_date,
                 posting.journal_entry_id,
                 journal.transaction_date AS journal_date
            FROM invoice_reminders reminder
            JOIN invoice_reminder_postings posting ON posting.reminder_id = reminder.id
            JOIN journal_entries journal ON journal.id = posting.journal_entry_id
           WHERE journal.status = 'posted'
             AND journal.reversal_of_entry_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM journal_entries reversal
                WHERE reversal.reversal_of_entry_id = journal.id
             )
          UNION ALL
          SELECT claim.invoice_document_id,
                 claim.claim_date AS effective_date,
                 posting.journal_entry_id,
                 journal.transaction_date AS journal_date
            FROM invoice_compensation_claims claim
            JOIN invoice_compensation_postings posting ON posting.compensation_claim_id = claim.id
            JOIN journal_entries journal ON journal.id = posting.journal_entry_id
           WHERE journal.status = 'posted'
             AND journal.reversal_of_entry_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM journal_entries reversal
                WHERE reversal.reversal_of_entry_id = journal.id
             )
          UNION ALL
          SELECT claim.invoice_document_id,
                 claim.claim_date AS effective_date,
                 posting.journal_entry_id,
                 journal.transaction_date AS journal_date
            FROM invoice_interest_claims claim
            JOIN invoice_interest_postings posting ON posting.interest_claim_id = claim.id
            JOIN journal_entries journal ON journal.id = posting.journal_entry_id
           WHERE journal.status = 'posted'
             AND journal.reversal_of_entry_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM journal_entries reversal
                WHERE reversal.reversal_of_entry_id = journal.id
             )
        ) active_claim
       WHERE active_claim.invoice_document_id = NEW.invoice_document_id
         AND (
           active_claim.effective_date > NEW.payment_date
           OR active_claim.journal_date > NEW.payment_date
           OR (
             NEW.bank_transaction_id IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM bank_transactions bank
                WHERE bank.id = NEW.bank_transaction_id
                  AND (
                    active_claim.effective_date > bank.transaction_date
                    OR active_claim.journal_date > bank.transaction_date
                  )
             )
           )
           OR active_claim.journal_entry_id >= NEW.journal_entry_id
         )
    );
  SELECT RAISE(ABORT, 'invoice claim payment journal evidence must debit bank and credit debtors')
    WHERE NEW.journal_entry_id IS NOT NULL
      AND (
        NOT EXISTS (
          SELECT 1
            FROM journal_lines jl
            JOIN accounts a ON a.id = jl.account_id
           WHERE jl.journal_entry_id = NEW.journal_entry_id
             AND a.type = 'asset'
             AND a.normal_balance = 'debit'
             AND jl.debit_amount > 0
             AND jl.credit_amount = 0
        )
        OR NOT EXISTS (
          SELECT 1
            FROM journal_lines jl
            JOIN accounts a ON a.id = jl.account_id
           WHERE jl.journal_entry_id = NEW.journal_entry_id
             AND a.type = 'asset'
             AND a.normal_balance = 'debit'
             AND jl.credit_amount > 0
             AND jl.debit_amount = 0
        )
      );
END;

CREATE TRIGGER IF NOT EXISTS invoice_claim_payments_no_delete
BEFORE DELETE ON invoice_claim_payments
BEGIN
  SELECT RAISE(ABORT, 'invoice claim payments are append-only; add a correcting claim payment application instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_bad_debt_writeoffs_no_update
BEFORE UPDATE ON invoice_bad_debt_writeoffs
BEGIN
  SELECT RAISE(ABORT, 'invoice bad-debt writeoffs are append-only; add a correcting journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_bad_debt_writeoffs_no_delete
BEFORE DELETE ON invoice_bad_debt_writeoffs
BEGIN
  SELECT RAISE(ABORT, 'invoice bad-debt writeoffs are append-only; add a correcting journal entry instead');
END;

-- ===== RECURRING INVOICES (#118) =====
-- Recurring-invoice templates and their explicit, deterministic generations.
-- A template captures the repeating invoice spec (interval, customer, lines,
-- VAT, delivery-period mode). Generation is an explicit step keyed by an
-- integer period_index counted from first_issue_date — no background
-- scheduling. UNIQUE(template_id, period_index) prevents duplicate generation
-- for the same template/period. Reminders/settlement live on the generated
-- documents row, never on the template.

CREATE TABLE IF NOT EXISTS recurring_invoice_templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  interval TEXT NOT NULL CHECK(interval IN ('monthly', 'quarterly', 'yearly')),
  first_issue_date TEXT NOT NULL,
  next_issue_date TEXT NOT NULL,
  payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK(payment_terms_days BETWEEN 0 AND 365),
  delivery_period_mode TEXT NOT NULL DEFAULT 'issue_month'
    CHECK(delivery_period_mode IN ('issue_month', 'interval_window', 'none')),
  payload_json TEXT NOT NULL,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recurring_invoice_generations (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL,
  period_index INTEGER NOT NULL CHECK(period_index >= 0),
  document_id INTEGER NOT NULL,
  invoice_number TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  delivery_period_start TEXT,
  delivery_period_end TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(template_id) REFERENCES recurring_invoice_templates(id),
  FOREIGN KEY(document_id) REFERENCES documents(id),
  UNIQUE(template_id, period_index)
);

CREATE INDEX IF NOT EXISTS idx_recurring_invoice_generations_template
  ON recurring_invoice_generations(template_id, period_index);

-- Template identity and the embedded payload are immutable; only the
-- next_issue_date marker may advance and active may be retired (1 -> 0).
CREATE TRIGGER IF NOT EXISTS recurring_invoice_templates_guard_update
BEFORE UPDATE ON recurring_invoice_templates
WHEN OLD.name != NEW.name
   OR OLD.interval != NEW.interval
   OR OLD.first_issue_date != NEW.first_issue_date
   OR OLD.payment_terms_days != NEW.payment_terms_days
   OR OLD.delivery_period_mode != NEW.delivery_period_mode
   OR OLD.payload_json != NEW.payload_json
   OR OLD.created_at != NEW.created_at
   OR NEW.next_issue_date < OLD.next_issue_date
   OR (OLD.active = 0 AND NEW.active = 1)
BEGIN
  SELECT RAISE(ABORT, 'recurring invoice templates are append-only; only next_issue_date may advance and active may be retired');
END;

CREATE TRIGGER IF NOT EXISTS recurring_invoice_templates_no_delete
BEFORE DELETE ON recurring_invoice_templates
BEGIN
  SELECT RAISE(ABORT, 'recurring invoice templates are append-only; retire them with active = 0 instead');
END;

CREATE TRIGGER IF NOT EXISTS recurring_invoice_generations_no_update
BEFORE UPDATE ON recurring_invoice_generations
BEGIN
  SELECT RAISE(ABORT, 'recurring invoice generations are append-only audit links; issue a credit note on the generated invoice instead');
END;

CREATE TRIGGER IF NOT EXISTS recurring_invoice_generations_no_delete
BEFORE DELETE ON recurring_invoice_generations
BEGIN
  SELECT RAISE(ABORT, 'recurring invoice generations are append-only audit links; issue a credit note on the generated invoice instead');
END;
-- ===== END RECURRING INVOICES (#118) =====
-- ===== MAIL INTAKE (#122) =====
-- Append-only dedup ledger for the first deterministic bilagsmail intake
-- slice. One row per (message-id, attachment hash) pair that was ingested,
-- so rerunning the same maildrop never creates duplicate documents.
CREATE TABLE IF NOT EXISTS mail_intake_messages (
  id INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL,
  attachment_sha256 TEXT NOT NULL,
  attachment_filename TEXT,
  document_id INTEGER,
  sender TEXT,
  subject TEXT,
  mail_date TEXT,
  ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (message_id, attachment_sha256)
);

CREATE INDEX IF NOT EXISTS idx_mail_intake_messages_message_id
ON mail_intake_messages(message_id);

CREATE TRIGGER IF NOT EXISTS mail_intake_messages_no_update
BEFORE UPDATE ON mail_intake_messages
BEGIN
  SELECT RAISE(ABORT, 'mail intake dedup rows are append-only; re-ingest creates a new row instead');
END;

CREATE TRIGGER IF NOT EXISTS mail_intake_messages_no_delete
BEFORE DELETE ON mail_intake_messages
BEGIN
  SELECT RAISE(ABORT, 'mail intake dedup rows are append-only and cannot be deleted');
END;
-- ===== MILEAGE LOG (#123) =====
-- Standalone kørselsregnskab register. Mileage entries are documentation/audit
-- data only; nothing here is posted to the journal/ledger. The per-kilometre
-- rate is user-supplied and source-backed (rate_basis), never a hardcoded tax
-- rate. Entries are append-only audit data.
CREATE TABLE IF NOT EXISTS mileage_entries (
  id INTEGER PRIMARY KEY,
  entry_no TEXT NOT NULL UNIQUE,
  trip_date TEXT NOT NULL,
  purpose TEXT NOT NULL,
  from_location TEXT NOT NULL,
  to_location TEXT NOT NULL,
  kilometers NUMERIC NOT NULL CHECK(kilometers > 0),
  vehicle TEXT NOT NULL,
  driver TEXT NOT NULL,
  rate_per_km NUMERIC NOT NULL CHECK(rate_per_km > 0),
  amount_basis NUMERIC NOT NULL CHECK(amount_basis >= 0),
  rate_basis TEXT NOT NULL,
  rate_source TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mileage_entries_trip_date
ON mileage_entries(trip_date);

CREATE TRIGGER IF NOT EXISTS mileage_entries_no_update
BEFORE UPDATE ON mileage_entries
BEGIN
  SELECT RAISE(ABORT, 'mileage_entries are append-only audit data; record a correcting entry instead');
END;

CREATE TRIGGER IF NOT EXISTS mileage_entries_no_delete
BEFORE DELETE ON mileage_entries
BEGIN
  SELECT RAISE(ABORT, 'mileage_entries are append-only audit data; record a correcting entry instead');
END;
-- ===== FIXED ASSETS (#124, #125) =====
-- Append-only fixed-asset register plus its depreciation entries (#124) and
-- immediate small-asset write-offs / straksafskrivning (#125). Money is stored
-- in DKK with 2 decimals; the workflow assists bookkeeping while the
-- user/advisor remains responsible for the tax treatment.

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  acquisition_date TEXT NOT NULL,
  cost NUMERIC NOT NULL CHECK(cost > 0),
  depreciation_method TEXT NOT NULL DEFAULT 'linear' CHECK(depreciation_method IN ('linear')),
  useful_life_months INTEGER NOT NULL CHECK(useful_life_months > 0),
  asset_account_no TEXT NOT NULL,
  depreciation_expense_account_no TEXT NOT NULL,
  accumulated_depreciation_account_no TEXT NOT NULL,
  purchase_document_id INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(purchase_document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS asset_depreciation_entries (
  id INTEGER PRIMARY KEY,
  asset_id INTEGER NOT NULL,
  period_index INTEGER NOT NULL CHECK(period_index > 0),
  transaction_date TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK(amount > 0),
  journal_entry_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(asset_id, period_index),
  FOREIGN KEY(asset_id) REFERENCES assets(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE TABLE IF NOT EXISTS asset_writeoffs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  acquisition_date TEXT NOT NULL,
  writeoff_date TEXT NOT NULL,
  cost NUMERIC NOT NULL CHECK(cost > 0),
  purchase_document_id INTEGER NOT NULL UNIQUE,
  expense_account_no TEXT NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK(confirmed IN (0,1)),
  threshold_dkk NUMERIC NOT NULL,
  threshold_rule_source TEXT NOT NULL,
  note TEXT,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(purchase_document_id) REFERENCES documents(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE INDEX IF NOT EXISTS idx_asset_depreciation_entries_asset ON asset_depreciation_entries(asset_id);
CREATE INDEX IF NOT EXISTS idx_assets_purchase_document ON assets(purchase_document_id);

CREATE TRIGGER IF NOT EXISTS assets_no_update
BEFORE UPDATE ON assets
BEGIN
  SELECT RAISE(ABORT, 'assets are append-only; register a correcting asset record instead');
END;

CREATE TRIGGER IF NOT EXISTS assets_no_delete
BEFORE DELETE ON assets
BEGIN
  SELECT RAISE(ABORT, 'assets are append-only; register a correcting asset record instead');
END;

CREATE TRIGGER IF NOT EXISTS asset_depreciation_entries_no_update
BEFORE UPDATE ON asset_depreciation_entries
BEGIN
  SELECT RAISE(ABORT, 'asset depreciation entries are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS asset_depreciation_entries_no_delete
BEFORE DELETE ON asset_depreciation_entries
BEGIN
  SELECT RAISE(ABORT, 'asset depreciation entries are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS asset_writeoffs_no_update
BEFORE UPDATE ON asset_writeoffs
BEGIN
  SELECT RAISE(ABORT, 'asset writeoffs are append-only; add a correcting journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS asset_writeoffs_no_delete
BEFORE DELETE ON asset_writeoffs
BEGIN
  SELECT RAISE(ABORT, 'asset writeoffs are append-only; add a correcting journal entry instead');
END;
-- ===== END FIXED ASSETS (#124, #125) =====
-- ===== PEPPOL SUBMISSION (#128) =====
-- Records a deterministic PEPPOL submission attempt built on top of an
-- existing OIOUBL handoff artifact. Submission records are audit data:
-- append-only, never updated or deleted. The idempotency key protects
-- against duplicate submissions. Access-point credentials are NEVER
-- stored here — only the non-secret access-point id used to derive the
-- submission envelope. The original invoice payload is not mutated.
CREATE TABLE IF NOT EXISTS peppol_submissions (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  invoice_no TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  submission_reference TEXT NOT NULL UNIQUE,
  access_point_id TEXT NOT NULL,
  receiver_endpoint_id TEXT NOT NULL,
  oioubl_sha256 TEXT NOT NULL,
  envelope_sha256 TEXT NOT NULL,
  envelope_xml TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared','acknowledged')),
  transmission_id TEXT,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_peppol_submissions_invoice
  ON peppol_submissions(invoice_document_id);
CREATE INDEX IF NOT EXISTS idx_peppol_submissions_reference
  ON peppol_submissions(submission_reference);

CREATE TRIGGER IF NOT EXISTS peppol_submissions_no_update
BEFORE UPDATE ON peppol_submissions
BEGIN
  SELECT RAISE(ABORT, 'peppol submissions are append-only audit records; record a new submission attempt instead');
END;

CREATE TRIGGER IF NOT EXISTS peppol_submissions_no_delete
BEFORE DELETE ON peppol_submissions
BEGIN
  SELECT RAISE(ABORT, 'peppol submissions are append-only audit records; record a new submission attempt instead');
END;
-- ===== DIGISENSE E-FAKTURA STATE (#efaktura) =====
-- companyKey↔virksomhed + participant-registrering hos Digisense. Dette er
-- IKKE secret-data (API license-key bor i config/digisense.json, aldrig her).
-- companyKey'en scoper næsten alle Digisense-kald og er almindelig
-- registrerings-state. Modsat audit-tabellerne er state'en MUTABEL — en
-- participant kan af-/genregistreres og webhook-status kan ændre sig — så der
-- er bevidst INGEN append-only triggers (samme valg som companies/customers).
CREATE TABLE IF NOT EXISTS digisense_companies (
  id INTEGER PRIMARY KEY,
  company_key TEXT NOT NULL,
  company_type TEXT NOT NULL CHECK(company_type IN ('DK:CVR','NIP')),
  -- CVR/NIP-identifikatoren; ét per virksomhed, derfor UNIQUE (en
  -- genregistrering opdaterer companyKey'en i stedet for at duplikere).
  participant_id TEXT NOT NULL UNIQUE,
  company_name TEXT NOT NULL,
  registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS digisense_participants (
  id INTEGER PRIMARY KEY,
  company_key TEXT NOT NULL,
  network TEXT NOT NULL CHECK(network IN ('nemhandel','peppol')),
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  participant_type TEXT NOT NULL CHECK(participant_type IN ('DK:CVR','GLN')),
  participant_id TEXT NOT NULL,
  -- NULL => ingen webhook; man poller selv (bekræftet designvalg).
  webhook_url TEXT,
  registered_on_network INTEGER NOT NULL DEFAULT 0 CHECK(registered_on_network IN (0, 1)),
  webhook_registered INTEGER NOT NULL DEFAULT 0 CHECK(webhook_registered IN (0, 1)),
  registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- For BÅDE send og modtag registreres et CVR som outbound OG inbound, så
  -- (companyKey, network, direction) er den unikke registrerings-nøgle.
  UNIQUE(company_key, network, direction)
);

CREATE INDEX IF NOT EXISTS idx_digisense_participants_company
  ON digisense_participants(company_key);

-- MODTAG-dedup: én række pr. modtaget Digisense-dokument vi har ingestet.
-- internalId er Digisense' STABILE dedup-nøgle (samme dokument => samme
-- internalId på tværs af polls), så UNIQUE her gør gentaget polling idempotent:
-- et allerede ingested dokument springes over i stedet for at duplikere bilaget.
-- Modsat registrerings-state ovenfor er DETTE en append-only audit-tabel (samme
-- valg som mail_intake_messages) — en ny modtagelse skaber en ny række, og
-- rækker rettes/slettes aldrig.
CREATE TABLE IF NOT EXISTS digisense_received_documents (
  id INTEGER PRIMARY KEY,
  -- Digisense' stabile dedup-nøgle for det modtagne dokument.
  internal_id TEXT NOT NULL UNIQUE,
  company_key TEXT NOT NULL,
  -- NULL => dokumentet blev IKKE ingested. Sammen med skip_reason markerer det
  -- en TERMINAL (uingesterbar) modtagelse: validering fejlede, eller det er en
  -- logisk/indholds-dublet. Rækken skrives alligevel (append-only) så et
  -- permanent-uingesterbart dokument ikke down­loades og fejler igen ved hver
  -- poll — den signerede downloadUrl udløber, og en evig re-download/re-fail-
  -- loop ville ellers opstå. Transiente fejl (download-transport) skriver INGEN
  -- række og prøver igen næste poll.
  document_id INTEGER,
  -- NULL ved en ren ingest; ellers den terminale fejl-grund (quarantine).
  skip_reason TEXT,
  digisense_document_id TEXT,
  source_network TEXT,
  sender_participant_id TEXT,
  sender_name TEXT,
  received_at TEXT,
  ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_digisense_received_documents_company
  ON digisense_received_documents(company_key);

CREATE TRIGGER IF NOT EXISTS digisense_received_documents_no_update
BEFORE UPDATE ON digisense_received_documents
BEGIN
  SELECT RAISE(ABORT, 'digisense received-document dedup rows are append-only; a new receipt creates a new row instead');
END;

CREATE TRIGGER IF NOT EXISTS digisense_received_documents_no_delete
BEFORE DELETE ON digisense_received_documents
BEGIN
  SELECT RAISE(ABORT, 'digisense received-document dedup rows are append-only and cannot be deleted');
END;
-- ===== END DIGISENSE E-FAKTURA STATE (#efaktura) =====
-- ===== OPENING BALANCE (#179) =====
-- Marks that a company's opening balance (primobalance) has been posted.
-- The primobalance itself lives as a normal balanced journal entry in
-- journal_entries (posted via postJournalEntry, hash-chained and audited);
-- this table is only the idempotency marker — exactly one row per company.
-- The single-row constraint enforces "one primobalance per company": the
-- fixed CHECK(id = 1) primary key makes a second INSERT fail. The table is
-- append-only audit data: never updated, never deleted.
CREATE TABLE IF NOT EXISTS opening_balances (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  cut_over_date TEXT NOT NULL,
  journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
  journal_entry_no TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER IF NOT EXISTS opening_balances_no_update
BEFORE UPDATE ON opening_balances
BEGIN
  SELECT RAISE(ABORT, 'opening balance is append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS opening_balances_no_delete
BEFORE DELETE ON opening_balances
BEGIN
  SELECT RAISE(ABORT, 'opening balance is append-only; reverse the journal entry instead');
END;
-- ===== END OPENING BALANCE (#179) =====
-- ===== END PEPPOL SUBMISSION (#128) =====
-- ===== EMAIL DELIVERY (#180) =====
-- Append-only SMTP send log: records that an issued invoice / a reminder was
-- emailed to a customer, so a send is recorded and not silently repeated.
-- This is audit data — never updated or deleted. The unique message_id is
-- the idempotency key. SMTP CREDENTIALS are NEVER stored here; only the
-- non-secret smtp_host used for the send is recorded for the audit trail.
CREATE TABLE IF NOT EXISTS email_send_log (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  invoice_no TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('invoice','reminder')),
  recipient TEXT NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  body_sha256 TEXT NOT NULL,
  smtp_host TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_email_send_log_invoice
  ON email_send_log(invoice_document_id);

CREATE TRIGGER IF NOT EXISTS email_send_log_no_update
BEFORE UPDATE ON email_send_log
BEGIN
  SELECT RAISE(ABORT, 'email send log is append-only audit data; record a new send instead');
END;

CREATE TRIGGER IF NOT EXISTS email_send_log_no_delete
BEFORE DELETE ON email_send_log
BEGIN
  SELECT RAISE(ABORT, 'email send log is append-only audit data; record a new send instead');
END;
-- ===== END EMAIL DELIVERY (#180) =====

-- ===== GDPR (#184) =====
-- Append-only erasure tombstones. A GDPR erasure never UPDATEs/DELETEs the
-- append-only master-data rows or the ledger; instead it records one row per
-- redacted source record here. The GDPR export layer overlays these tombstones
-- so the redacted personal data never resurfaces. Keeping erasure as an
-- append-only journal means the audit chain and bookkeeping integrity are
-- untouched by a data-subject erasure.
CREATE TABLE IF NOT EXISTS gdpr_erasures (
  id INTEGER PRIMARY KEY,
  subject_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('customers','vendors','documents','bank_transactions','audit_log')),
  source_row_id INTEGER NOT NULL,
  redacted_fields TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  retained_until_at_erasure TEXT,
  erased_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(subject_key, source, source_row_id)
);

CREATE INDEX IF NOT EXISTS idx_gdpr_erasures_subject ON gdpr_erasures(subject_key);

CREATE TRIGGER IF NOT EXISTS gdpr_erasures_no_update
BEFORE UPDATE ON gdpr_erasures
BEGIN
  SELECT RAISE(ABORT, 'gdpr_erasures are append-only audit records; record a new erasure instead');
END;

CREATE TRIGGER IF NOT EXISTS gdpr_erasures_no_delete
BEFORE DELETE ON gdpr_erasures
BEGIN
  SELECT RAISE(ABORT, 'gdpr_erasures are append-only audit records; an erasure cannot be revoked');
END;
-- ===== END GDPR (#184) =====

-- ===== IMPORT ARCHIVE (#197) =====
-- A multi-year accounting-system export (Dinero #173) covers several fiscal
-- years; only the cut-over year is posted to the live ledger. The earlier,
-- pre-cut-over years are NOT posted — but discarding them loses audit history
-- and matching context. They are kept here as a READ-ONLY ARCHIVE: prior-year
-- Posteringer and SaldoBalance rows, tagged by source system and fiscal year.
--
-- This is reference data, deliberately OUTSIDE the live ledger: nothing here is
-- part of the hash-chained journal (journal_entries / journal_lines) and the
-- archive is never posted. Like the rest of Rentemester's audit data the rows
-- are append-only — re-importing creates a fresh batch row instead.
--
-- `import_archive_years` is the per-(source_system, fiscal_year) header; its
-- detail rows live in `import_archive_postings` (one per archived Posteringer
-- line) and `import_archive_balances` (one per archived SaldoBalance line).
-- Amounts are stored in KRONER (decimal), exactly as Dinero exports them.
CREATE TABLE IF NOT EXISTS import_archive_years (
  id INTEGER PRIMARY KEY,
  source_system TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  posting_count INTEGER NOT NULL DEFAULT 0 CHECK(posting_count >= 0),
  balance_count INTEGER NOT NULL DEFAULT 0 CHECK(balance_count >= 0),
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_system, fiscal_year)
);

CREATE TABLE IF NOT EXISTS import_archive_postings (
  id INTEGER PRIMARY KEY,
  archive_year_id INTEGER NOT NULL,
  line_no INTEGER NOT NULL CHECK(line_no >= 0),
  account_no TEXT NOT NULL,
  account_name TEXT,
  transaction_date TEXT,
  voucher TEXT,
  voucher_type TEXT,
  text TEXT,
  vat_type TEXT,
  amount NUMERIC NOT NULL,
  running_balance NUMERIC,
  FOREIGN KEY(archive_year_id) REFERENCES import_archive_years(id)
);

CREATE TABLE IF NOT EXISTS import_archive_balances (
  id INTEGER PRIMARY KEY,
  archive_year_id INTEGER NOT NULL,
  line_no INTEGER NOT NULL CHECK(line_no >= 0),
  account_no TEXT NOT NULL,
  account_name TEXT,
  amount NUMERIC NOT NULL,
  FOREIGN KEY(archive_year_id) REFERENCES import_archive_years(id)
);

CREATE INDEX IF NOT EXISTS idx_import_archive_postings_year
  ON import_archive_postings(archive_year_id);
CREATE INDEX IF NOT EXISTS idx_import_archive_balances_year
  ON import_archive_balances(archive_year_id);

CREATE TRIGGER IF NOT EXISTS import_archive_years_no_update
BEFORE UPDATE ON import_archive_years
BEGIN
  SELECT RAISE(ABORT, 'import archive years are append-only reference data; re-import creates a new batch instead');
END;

CREATE TRIGGER IF NOT EXISTS import_archive_years_no_delete
BEFORE DELETE ON import_archive_years
BEGIN
  SELECT RAISE(ABORT, 'import archive years are append-only reference data and cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS import_archive_postings_no_update
BEFORE UPDATE ON import_archive_postings
BEGIN
  SELECT RAISE(ABORT, 'import archive postings are append-only reference data');
END;

CREATE TRIGGER IF NOT EXISTS import_archive_postings_no_delete
BEFORE DELETE ON import_archive_postings
BEGIN
  SELECT RAISE(ABORT, 'import archive postings are append-only reference data and cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS import_archive_balances_no_update
BEFORE UPDATE ON import_archive_balances
BEGIN
  SELECT RAISE(ABORT, 'import archive balances are append-only reference data');
END;

CREATE TRIGGER IF NOT EXISTS import_archive_balances_no_delete
BEFORE DELETE ON import_archive_balances
BEGIN
  SELECT RAISE(ABORT, 'import archive balances are append-only reference data and cannot be deleted');
END;
-- ===== END IMPORT ARCHIVE (#197) =====

-- ===== IMPORT DOCUMENT LINKS (#196) =====
-- A Dinero export ships the actual receipts (`<year>/Bilag/<year>-Bilag-<n>`).
-- Each is ingested through the ordinary documents pipeline and must be linked
-- back to the journal entry its voucher (#195) was posted as.
--
-- `journal_entries` is append-only and locked (journal_entries_no_update), so
-- the entry's `document_id` cannot be set after the fact. Instead a posting and
-- its receipt are connected through THIS dedicated link table — additive, never
-- mutating a posted entry. One row per (document, journal entry) pair, carrying
-- the source voucher number (`Bilag`) the link was matched on for audit.
--
-- Like the rest of Rentemester's audit data the rows are append-only: a
-- re-import that re-ingests the same receipt by hash is a no-op (the documents
-- pipeline dedupes on sha256) and so produces no duplicate link.
CREATE TABLE IF NOT EXISTS import_document_links (
  id INTEGER PRIMARY KEY,
  source_system TEXT NOT NULL,
  voucher_ref TEXT NOT NULL,
  document_id INTEGER NOT NULL,
  journal_entry_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(document_id, journal_entry_id),
  FOREIGN KEY(document_id) REFERENCES documents(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE INDEX IF NOT EXISTS idx_import_document_links_entry
  ON import_document_links(journal_entry_id);

CREATE TRIGGER IF NOT EXISTS import_document_links_no_update
BEFORE UPDATE ON import_document_links
BEGIN
  SELECT RAISE(ABORT, 'import document links are append-only audit links');
END;

CREATE TRIGGER IF NOT EXISTS import_document_links_no_delete
BEFORE DELETE ON import_document_links
BEGIN
  SELECT RAISE(ABORT, 'import document links are append-only audit links and cannot be deleted');
END;
-- ===== END IMPORT DOCUMENT LINKS (#196) =====
-- ===== ACCRUALS / PERIODEAFGRÆNSNINGSPOSTER =====
-- Append-only register of periodeafgrænsningsposter: prepaid expenses
-- (forudbetalte omkostninger), accrued expenses (skyldige omkostninger) and
-- deferred revenue (forudbetalt indtægt). The `accruals` row is the header —
-- the initial balanced journal entry that parks the amount on a balance-sheet
-- accrual account. `accrual_schedule_postings` records each recognition period
-- as it is posted: a balanced journal entry that moves one period's slice off
-- the balance-sheet accrual account and onto the income-statement account.
-- Money is DKK with 2 decimals. Both tables are append-only — a wrong accrual
-- is corrected by reversing its journal entries, never by editing a row.
CREATE TABLE IF NOT EXISTS accruals (
  id INTEGER PRIMARY KEY,
  accrual_type TEXT NOT NULL CHECK(accrual_type IN ('prepaid_expense','accrued_expense','deferred_revenue')),
  description TEXT NOT NULL,
  total_amount NUMERIC NOT NULL CHECK(total_amount > 0),
  recognition_periods INTEGER NOT NULL CHECK(recognition_periods > 0),
  -- The balance-sheet account the amount is parked on between periods (an
  -- asset for prepaid expenses, a liability for accrued expenses / deferred
  -- revenue).
  balance_account_no TEXT NOT NULL,
  -- The income-statement account each period's slice is recognised on.
  result_account_no TEXT NOT NULL,
  -- The first recognition period (YYYY-MM-DD) and the month-step between
  -- periods, so the schedule is fully deterministic from the header alone.
  first_recognition_date TEXT NOT NULL,
  period_step_months INTEGER NOT NULL DEFAULT 1 CHECK(period_step_months > 0),
  document_id INTEGER,
  -- The journal entry that registered the accrual (parks it on the balance
  -- sheet). NULL only transiently inside the registering transaction.
  registration_journal_entry_id INTEGER UNIQUE,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(document_id) REFERENCES documents(id),
  FOREIGN KEY(registration_journal_entry_id) REFERENCES journal_entries(id)
);

CREATE TABLE IF NOT EXISTS accrual_schedule_postings (
  id INTEGER PRIMARY KEY,
  accrual_id INTEGER NOT NULL,
  period_index INTEGER NOT NULL CHECK(period_index > 0),
  recognition_date TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK(amount > 0),
  journal_entry_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(accrual_id, period_index),
  FOREIGN KEY(accrual_id) REFERENCES accruals(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE INDEX IF NOT EXISTS idx_accrual_schedule_postings_accrual ON accrual_schedule_postings(accrual_id);
CREATE INDEX IF NOT EXISTS idx_accruals_document ON accruals(document_id);

-- The registering transaction sets registration_journal_entry_id once, right
-- after the header row exists; that single transition is the only mutation an
-- accrual row may ever undergo. Everything else is append-only — a wrong
-- accrual is corrected by reversing its journal entries.
CREATE TRIGGER IF NOT EXISTS accruals_no_update
BEFORE UPDATE ON accruals
WHEN NOT (OLD.registration_journal_entry_id IS NULL AND NEW.registration_journal_entry_id IS NOT NULL
          AND OLD.id = NEW.id AND OLD.accrual_type = NEW.accrual_type
          AND OLD.description = NEW.description AND OLD.total_amount = NEW.total_amount
          AND OLD.recognition_periods = NEW.recognition_periods
          AND OLD.balance_account_no = NEW.balance_account_no
          AND OLD.result_account_no = NEW.result_account_no
          AND OLD.first_recognition_date = NEW.first_recognition_date
          AND OLD.period_step_months = NEW.period_step_months)
BEGIN
  SELECT RAISE(ABORT, 'accruals are append-only; reverse the journal entries to correct an accrual');
END;

CREATE TRIGGER IF NOT EXISTS accruals_no_delete
BEFORE DELETE ON accruals
BEGIN
  SELECT RAISE(ABORT, 'accruals are append-only; reverse the journal entries to correct an accrual');
END;

CREATE TRIGGER IF NOT EXISTS accrual_schedule_postings_no_update
BEFORE UPDATE ON accrual_schedule_postings
BEGIN
  SELECT RAISE(ABORT, 'accrual schedule postings are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS accrual_schedule_postings_no_delete
BEFORE DELETE ON accrual_schedule_postings
BEGIN
  SELECT RAISE(ABORT, 'accrual schedule postings are append-only; reverse the journal entry instead');
END;
-- ===== END ACCRUALS / PERIODEAFGRÆNSNINGSPOSTER =====
-- ===== BUDGET (budget per konto pr. periode) =====
-- A budget line is an append-only revision: setting a budget for an
-- (account_no, period) pair inserts a NEW row; the row with the highest id for
-- that pair is the effective budget. Nothing is mutated or deleted, so the
-- full history of every budget change is preserved for audit — the same
-- append-only discipline the ledger and recurring-invoice templates follow.
--
-- `period` is a calendar month in YYYY-MM form. `amount` is a kroner figure in
-- the account's natural sign convention (a 5000 expense budget, a 20000 income
-- target) — never negative. The budget-vs-actual report and the liquidity
-- forecast both read the effective line.
CREATE TABLE IF NOT EXISTS budget_lines (
  id INTEGER PRIMARY KEY,
  account_no TEXT NOT NULL,
  period TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK(amount >= 0),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(account_no) REFERENCES accounts(account_no)
);

CREATE INDEX IF NOT EXISTS idx_budget_lines_account_period
  ON budget_lines(account_no, period, id);

CREATE TRIGGER IF NOT EXISTS budget_lines_no_update
BEFORE UPDATE ON budget_lines
BEGIN
  SELECT RAISE(ABORT, 'budget lines are append-only; insert a new revision instead');
END;

CREATE TRIGGER IF NOT EXISTS budget_lines_no_delete
BEFORE DELETE ON budget_lines
BEGIN
  SELECT RAISE(ABORT, 'budget lines are append-only and cannot be deleted; insert a new revision instead');
END;
-- ===== END BUDGET =====

-- ===== PAYABLES / KREDITORSTYRING =====
-- The accounts-payable open-item register, symmetric to the debitor side.
-- A registered supplier bill (`payables`) is an open item that owes money to
-- a creditor: it carries a due date and is recognised in the ledger as a
-- balanced journal entry (debit expense + købsmoms, credit 7000 Leverandørgæld).
-- Outgoing bank payments are matched against the open item in `payable_payments`
-- (debit 7000 Leverandørgæld, credit bank). The open balance is gross amount
-- minus the sum of applied payments. Both tables are append-only audit data:
-- corrections go through journal reversals and a fresh payment application,
-- never an UPDATE/DELETE — exactly like invoice_payments on the debitor side.
CREATE TABLE IF NOT EXISTS payables (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL UNIQUE,
  vendor_id INTEGER,
  supplier_name TEXT,
  bill_no TEXT,
  bill_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  gross_amount NUMERIC NOT NULL CHECK(gross_amount > 0),
  net_amount NUMERIC NOT NULL CHECK(net_amount >= 0),
  vat_amount NUMERIC NOT NULL CHECK(vat_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'DKK',
  journal_entry_id INTEGER NOT NULL UNIQUE,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(document_id) REFERENCES documents(id),
  FOREIGN KEY(vendor_id) REFERENCES vendors(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE TABLE IF NOT EXISTS payable_payments (
  id INTEGER PRIMARY KEY,
  payable_id INTEGER NOT NULL,
  bank_transaction_id INTEGER,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  payment_date TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK(amount > 0),
  currency TEXT NOT NULL DEFAULT 'DKK',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(payable_id) REFERENCES payables(id),
  FOREIGN KEY(bank_transaction_id) REFERENCES bank_transactions(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE INDEX IF NOT EXISTS idx_payables_document ON payables(document_id);
CREATE INDEX IF NOT EXISTS idx_payable_payments_payable ON payable_payments(payable_id);

CREATE TRIGGER IF NOT EXISTS payables_no_update
BEFORE UPDATE ON payables
BEGIN
  SELECT RAISE(ABORT, 'payables are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS payables_no_delete
BEFORE DELETE ON payables
BEGIN
  SELECT RAISE(ABORT, 'payables are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS payable_payments_no_update
BEFORE UPDATE ON payable_payments
BEGIN
  SELECT RAISE(ABORT, 'payable payments are append-only; add a correcting payment application instead');
END;

CREATE TRIGGER IF NOT EXISTS payable_payments_no_delete
BEFORE DELETE ON payable_payments
BEGIN
  SELECT RAISE(ABORT, 'payable payments are append-only; add a correcting payment application instead');
END;
-- ===== END PAYABLES / KREDITORSTYRING =====
