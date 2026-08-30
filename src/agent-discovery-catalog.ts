import { createHash } from "node:crypto";
import { RETRY_OPERATION_NAMES } from "./core/idempotency";
import { getBuildIdentity } from "./core/build-identity";
import { getReleaseProvenance } from "./core/release-provenance";
import { currentRuleBundleVersion } from "./core/rules-metadata";

export const AGENT_CATALOGUE_SCHEMA_VERSION = "rentemester-agent-discovery-v1";
export const AGENT_CATALOGUE_ENTRY_POINT = "meta_about -> agent_capability_search -> agent_workflow_describe -> tools/list";

export type AgentScope = "company" | "workspace" | "legal-group" | "system";
export type WorkflowBoundary = "read" | "dry-run" | "review" | "approval" | "apply" | "irreversible" | "destructive";
export type OperationSafety = "read" | "write" | "destructive";
/** The only retry contracts exposed to agents.  A write never becomes safe
 * merely because it accepts an arbitrary input field. */
export type RetryClass = "safe-read" | "key-idempotent" | "natural-idempotent" | "external-provider-reconciled" | "unsafe-read-back";

export type OperationReference =
  | { surface: "mcp"; name: string }
  | { surface: "cli"; key: string }
  | { surface: "http"; method: string; pattern: string };

export type AgentCapability = {
  id: string;
  title: string;
  purpose: string;
  domain: string;
  outcomes: string[];
  keywords: string[];
  scope: AgentScope;
  supportStatus: "supported" | "partial";
  maturity: "stable" | "limited";
  workflowIds: string[];
  canonicalState: string[];
  unsupportedBoundaries: string[];
};

export type AgentWorkflowStep = {
  id: string;
  dependsOn: string[];
  condition?: string;
  boundary: WorkflowBoundary;
  operation: OperationReference;
  purpose: string;
  prerequisites: string[];
  inputIdentities: string[];
  outputIdentities: string[];
  expectedSafety: OperationSafety;
  expectedIdempotent: boolean;
  requiresActor: boolean;
  requiresConfirmation: boolean;
  requiredArguments?: string[];
  retryClass: RetryClass;
  uncertainOutcomeReadBack?: OperationReference;
  canonicalRecords: string[];
};

export type AgentWorkflow = {
  id: string;
  capabilityId: string;
  title: string;
  intendedOutcome: string;
  nonGoals: string[];
  prerequisites: string[];
  steps: AgentWorkflowStep[];
  blockers: Array<{ code: string; meaning: string }>;
  recovery: string[];
  stopConditions: string[];
  relatedWorkflowIds: string[];
  alternatives: string[];
  unsupportedBoundaries: string[];
};

type StepInput = Omit<AgentWorkflowStep, "dependsOn" | "prerequisites" | "inputIdentities" | "outputIdentities" | "canonicalRecords"> & Partial<Pick<AgentWorkflowStep, "dependsOn" | "prerequisites" | "inputIdentities" | "outputIdentities" | "canonicalRecords">>;

const mcp = (name: string): OperationReference => ({ surface: "mcp", name });
const cli = (key: string): OperationReference => ({ surface: "cli", key });

function step(input: StepInput): AgentWorkflowStep {
  return { dependsOn: [], prerequisites: [], inputIdentities: [], outputIdentities: [], canonicalRecords: [], ...input };
}

function read(id: string, operation: OperationReference, purpose: string, options: Partial<StepInput> = {}): AgentWorkflowStep {
  return step({ id, operation, purpose, boundary: "read", expectedSafety: "read", expectedIdempotent: true, requiresActor: false, requiresConfirmation: false, retryClass: "safe-read", ...options });
}

function write(id: string, operation: OperationReference, purpose: string, options: Partial<StepInput> = {}): AgentWorkflowStep {
  return step({ id, operation, purpose, boundary: "apply", expectedSafety: "write", expectedIdempotent: false, requiresActor: true, requiresConfirmation: true, retryClass: "unsafe-read-back", ...options });
}

function workflow(input: Pick<AgentWorkflow, "id" | "capabilityId" | "title" | "intendedOutcome" | "steps"> & Partial<Omit<AgentWorkflow, "id" | "capabilityId" | "title" | "intendedOutcome" | "steps">>): AgentWorkflow {
  return {
    nonGoals: ["Discovery is not authorization and never executes the workflow."],
    prerequisites: ["Call meta_about and verify build, rules and catalogue identity.", "Resolve every referenced operation in the live surface before mutation.", "Use an explicit company, workspace or legal-group identity where required."],
    blockers: [
      { code: "INPUT_VALIDATION", meaning: "Correct the named schema field before retry." },
      { code: "CONFIRM_OR_ACTOR_REQUIRED", meaning: "The write lacks confirmation, actor attribution or permission." },
      { code: "BUSINESS_PRECONDITION", meaning: "Evidence, period, backup, review or accounting rules block the operation." },
    ],
    recovery: ["Stop at the failing boundary and inspect the structured error or MCP -32602 response.", "Repair only the named precondition, read canonical state again, and use correction/reversal rather than deleting ledger evidence."],
    stopConditions: ["A required human approval is absent.", "A referenced operation is not live on the declared surface.", "The requested outcome crosses an unsupported boundary."],
    relatedWorkflowIds: [], alternatives: [], unsupportedBoundaries: [], ...input,
  };
}

export const AGENT_WORKFLOWS: readonly AgentWorkflow[] = [
  workflow({ id: "company-workspace-setup", capabilityId: "company-workspace", title: "Company and workspace setup", intendedOutcome: "Create or select a company and verify its canonical profile before accounting work.", steps: [
    write("initialize-company", cli("init"), "Create a local company root when no workspace company exists.", { requiresActor: false, requiresConfirmation: false, prerequisites: ["CLI-only: choose an explicit new company path."], outputIdentities: ["company root"], canonicalRecords: ["company database", "company profile"] }),
    write("add-workspace-company", mcp("company_add"), "Add a company to an existing workspace.", { condition: "Use instead of initialize-company for an existing workspace.", outputIdentities: ["company slug"], canonicalRecords: ["workspace manifest"] }),
    read("list-companies", mcp("portfolio_overview"), "Discover companies available through the workspace without inferring hidden companies.", { dependsOn: ["initialize-company|add-workspace-company"], outputIdentities: ["visible company slugs"] }),
    read("read-profile", mcp("company_profile_get"), "Verify the selected company's profile.", { dependsOn: ["list-companies"], inputIdentities: ["company slug/path"], canonicalRecords: ["company profile"] }),
  ], unsupportedBoundaries: ["MCP does not initialize an arbitrary host path; CLI init is explicitly CLI-only.", "Discovery never exposes companies outside the caller's workspace access."] }),
  workflow({ id: "document-mail-intake", capabilityId: "document-intake", title: "Document and mail intake", intendedOutcome: "Store source evidence and review extraction without silently approving or posting it.", steps: [
    write("ingest-document", mcp("documents_ingest"), "Ingest supplied source evidence.", { outputIdentities: ["documentId", "documentNo", "sha256"], canonicalRecords: ["documents", "document originals"] }),
    write("ingest-mail", mcp("mail_intake_ingest"), "Ingest an explicitly selected mail attachment.", { condition: "Use for mail intake instead of ingest-document.", expectedIdempotent: true, retryClass: "external-provider-reconciled", outputIdentities: ["documentId"], canonicalRecords: ["documents", "mail intake audit"] }),
    write("poll-imap", mcp("imap_intake_poll"), "Poll configured IMAP intake and ingest accepted attachments.", { condition: "Use only when IMAP is configured and external access is intended.", expectedIdempotent: true, retryClass: "external-provider-reconciled", outputIdentities: ["intake batch identity"], canonicalRecords: ["documents", "mail intake audit"] }),
    read("list-documents", mcp("documents_list"), "Read back canonical document state.", { dependsOn: ["ingest-document|ingest-mail|poll-imap"], outputIdentities: ["documentId"] }),
    read("review-extraction", mcp("documents_invoice_extraction"), "Review cited invoice extraction where available.", { dependsOn: ["list-documents"], inputIdentities: ["documentId"] }),
  ], unsupportedBoundaries: ["Extraction is evidence for review, not approval or automatic posting.", "The catalogue contains no mailbox credentials or company routing."] }),
  workflow({ id: "bank-reconciliation-batch", capabilityId: "bank-bookkeeping", title: "Bank import, matching and bookkeeping batch", intendedOutcome: "Import bank activity, inspect matches and apply only a hash-bound reviewed bookkeeping batch.", steps: [
    write("import-bank", mcp("bank_import"), "Import bank rows with duplicate protection.", { expectedIdempotent: true, retryClass: "natural-idempotent", outputIdentities: ["importBatchId", "bankTransactionIds"], canonicalRecords: ["bank_transactions", "bank import evidence"] }),
    read("suggest-matches", mcp("bank_suggest_matches"), "Generate read-only matching suggestions.", { dependsOn: ["import-bank"] }),
    read("reconciliation-report", mcp("reconcile_bank"), "Produce the read-only reconciliation report; this does not confirm matches.", { dependsOn: ["import-bank"] }),
    read("batch-plan", mcp("bookkeeping_batch_plan"), "Produce a deterministic plan and hash without changing durable state.", { dependsOn: ["suggest-matches"], boundary: "dry-run", expectedIdempotent: true, retryClass: "safe-read", outputIdentities: ["planHash"] }),
    write("batch-persist", mcp("bookkeeping_batch_persist"), "Persist the reviewed plan and hash; this does not approve or apply it.", { dependsOn: ["batch-plan"], boundary: "dry-run", expectedIdempotent: true, retryClass: "natural-idempotent", inputIdentities: ["runKey"], outputIdentities: ["runId", "planHash"] }),
    write("batch-approve", mcp("bookkeeping_batch_approve"), "Bind an authorised reviewer, time and exact hash to the persisted run.", { dependsOn: ["batch-persist"], boundary: "approval", expectedIdempotent: true, retryClass: "natural-idempotent", inputIdentities: ["runId", "planHash"] }),
    write("batch-apply", mcp("bookkeeping_batch_apply"), "Apply or resume the exact approved run without replanning.", { dependsOn: ["batch-approve"], boundary: "irreversible", retryClass: "natural-idempotent", expectedIdempotent: true, inputIdentities: ["runId", "planHash"], outputIdentities: ["runId", "journalEntryIds"], uncertainOutcomeReadBack: mcp("bookkeeping_batch_status"), canonicalRecords: ["bookkeeping batch runs", "journal entries", "bank reconciliations"] }),
    read("read-bank-state", mcp("bank_list"), "Read back imported and reconciled bank state.", { dependsOn: ["batch-apply"] }),
  ], unsupportedBoundaries: ["reconcile_bank is a report, not an apply operation.", "Suggested or human-review items are never auto-approved."] }),
  workflow({ id: "supplier-expense-booking", capabilityId: "supplier-purchases", title: "Supplier expense booking", intendedOutcome: "Book a documented supplier expense against a bank transaction with the correct VAT treatment.", steps: [
    read("review-document", mcp("documents_list"), "Select the ingested supplier document."),
    read("vat-preflight", mcp("expense_vat_preflight"), "Validate supplier identity, VAT evidence and treatment.", { dependsOn: ["review-document"], boundary: "dry-run" }),
    write("book-expense", mcp("expense_book"), "Post the reviewed expense and bank reconciliation.", { dependsOn: ["vat-preflight"], boundary: "irreversible", retryClass: "key-idempotent", inputIdentities: ["documentId", "bankTransactionId"], uncertainOutcomeReadBack: mcp("journal_list"), canonicalRecords: ["journal entries", "bank reconciliations", "document posting link"] }),
    read("verify-posting", mcp("journal_list"), "Read back the posting.", { dependsOn: ["book-expense"] }),
  ], relatedWorkflowIds: ["supplier-payable-handling", "vat-preparation"] }),
  workflow({ id: "supplier-payable-handling", capabilityId: "supplier-purchases", title: "Supplier payable handling", intendedOutcome: "Register a supplier invoice as an open payable and record its later bank payment.", steps: [
    write("register-payable", mcp("payable_register"), "Register reviewed evidence as a payable.", { boundary: "irreversible", retryClass: "key-idempotent", outputIdentities: ["payableId", "journalEntryId"], canonicalRecords: ["payables", "journal entries"] }),
    read("list-payables", mcp("payable_list"), "Read due/open state.", { dependsOn: ["register-payable"] }),
    write("pay-payable", mcp("payable_pay"), "Match the selected bank payment.", { dependsOn: ["list-payables"], boundary: "irreversible", retryClass: "key-idempotent", inputIdentities: ["payableId", "bankTransactionId"], uncertainOutcomeReadBack: mcp("payable_list"), canonicalRecords: ["payable payments", "bank reconciliations", "journal entries"] }),
    read("verify-payable", mcp("payable_list"), "Read back the payable balance.", { dependsOn: ["pay-payable"] }),
  ], relatedWorkflowIds: ["supplier-expense-booking"] }),
  workflow({ id: "customer-invoice-lifecycle", capabilityId: "customer-invoicing", title: "Customer and invoice lifecycle", intendedOutcome: "Create a customer, issue and post an invoice, then handle delivery, payment, reminder or credit-note branches.", steps: [
    write("create-customer", mcp("customer_create"), "Create canonical customer master data.", { outputIdentities: ["customerId"], canonicalRecords: ["customers"] }),
    read("validate-invoice", mcp("invoice_validate"), "Validate the invoice payload.", { dependsOn: ["create-customer"], boundary: "dry-run" }),
    write("issue-invoice", mcp("invoice_issue"), "Issue immutable invoice evidence.", { dependsOn: ["validate-invoice"], outputIdentities: ["invoiceNumber", "documentId"], uncertainOutcomeReadBack: mcp("invoice_find"), canonicalRecords: ["issued invoices", "invoice documents"] }),
    write("post-invoice", mcp("invoice_post"), "Post the issued invoice.", { dependsOn: ["issue-invoice"], boundary: "irreversible", uncertainOutcomeReadBack: mcp("invoice_status"), canonicalRecords: ["journal entries", "invoice open balance"] }),
    write("send-email", mcp("invoice_send_email"), "Send the issued invoice by configured email.", { dependsOn: ["issue-invoice"], condition: "Optional delivery branch. SMTP has no provider reconciliation contract: read canonical delivery evidence before any retry.", retryClass: "unsafe-read-back", canonicalRecords: ["email delivery evidence"] }),
    write("record-payment", mcp("invoice_settle_bank"), "Match a customer bank payment.", { dependsOn: ["post-invoice"], condition: "Payment branch.", boundary: "irreversible", uncertainOutcomeReadBack: mcp("invoice_status"), canonicalRecords: ["invoice payments", "bank reconciliations", "journal entries"] }),
    write("send-reminder", mcp("invoice_remind"), "Create an eligible overdue reminder.", { dependsOn: ["post-invoice"], condition: "Overdue branch.", canonicalRecords: ["invoice reminders"] }),
    write("credit-note", mcp("invoice_credit_note"), "Correct an issued invoice by credit note.", { dependsOn: ["issue-invoice"], condition: "Correction branch.", boundary: "irreversible", uncertainOutcomeReadBack: mcp("invoice_status"), canonicalRecords: ["credit notes", "journal entries"] }),
    read("invoice-status", mcp("invoice_status"), "Read back invoice, claim and payment state.", { dependsOn: ["post-invoice"] }),
  ], unsupportedBoundaries: ["Issue does not imply delivery or payment.", "No external send is retried blindly after uncertainty."] }),
  workflow({ id: "vat-preparation", capabilityId: "vat", title: "Domestic purchase VAT and period preparation", intendedOutcome: "Validate purchase VAT evidence, post supported treatments and prepare reports without filing externally.", steps: [
    read("purchase-preflight", mcp("expense_vat_preflight"), "Validate domestic supplier and line-level VAT evidence.", { boundary: "dry-run" }),
    write("post-domestic-purchase", mcp("expense_book"), "Post the reviewed domestic treatment.", { dependsOn: ["purchase-preflight"], condition: "Domestic branch.", boundary: "irreversible", retryClass: "key-idempotent", uncertainOutcomeReadBack: mcp("vat_report"), canonicalRecords: ["journal entries with VAT codes"] }),
    write("post-reverse-charge", mcp("vat_post_eu_service_purchase"), "Post a supported EU-service reverse charge.", { dependsOn: ["purchase-preflight"], condition: "Reverse-charge branch.", boundary: "irreversible", uncertainOutcomeReadBack: mcp("vat_report"), canonicalRecords: ["reverse-charge journal entries"] }),
    read("vat-report", mcp("vat_report"), "Prepare the VAT period report.", { dependsOn: ["post-domestic-purchase|post-reverse-charge"] }),
    read("eu-sales-list", mcp("vat_eu_sales_list"), "Prepare EU sales evidence.", { dependsOn: ["vat-report"] }),
  ], unsupportedBoundaries: ["This workflow does not file with an authority.", "Only documented taxable lines create input VAT."] }),
  workflow({ id: "exceptions-corrections", capabilityId: "exceptions-corrections", title: "Exceptions, corrections and reversals", intendedOutcome: "Resolve review blockers and correct posted entries through append-only compensating records.", steps: [
    read("list-exceptions", mcp("exceptions_list"), "Read unresolved exceptions."),
    write("resolve-exception", mcp("exception_resolve"), "Record the reviewed resolution.", { dependsOn: ["list-exceptions"], canonicalRecords: ["exception resolution audit"] }),
    read("review-journal", mcp("journal_list"), "Identify the exact entry requiring correction.", { dependsOn: ["resolve-exception"] }),
    write("reverse-journal", mcp("journal_reverse"), "Append a documented reversal.", { dependsOn: ["review-journal"], boundary: "irreversible", retryClass: "key-idempotent", uncertainOutcomeReadBack: mcp("journal_list"), canonicalRecords: ["reversal journal entry", "audit log"] }),
  ], alternatives: ["Use invoice_credit_note for an issued sales invoice."], unsupportedBoundaries: ["Posted entries and original documents are never overwritten or deleted."] }),
  workflow({ id: "period-close-reopen", capabilityId: "period-management", title: "Period readiness, close and reopen", intendedOutcome: "Inspect period readiness, close deliberately and reopen only through the supported correction path.", steps: [
    read("list-periods", mcp("period_list"), "Inspect period state and blockers."),
    read("close-readiness", mcp("period_close_readiness"), "Compute the exact read-only readiness packet and inspect every control.", { dependsOn: ["list-periods"], canonicalRecords: ["period close readiness packet"] }),
    write("review-readiness", mcp("period_close_review"), "Persist the reviewed packet before any close attempt.", { dependsOn: ["close-readiness"], boundary: "approval", canonicalRecords: ["period close review"] }),
    write("close-period", mcp("period_close"), "Close using the exact persisted review ID and packet hash; never retry after a stale packet.", { dependsOn: ["review-readiness"], boundary: "approval", canonicalRecords: ["period locks", "period close decision"] }),
    read("close-status", mcp("period_close_status"), "Poll the durable reviewed packet without recomputing readiness.", { dependsOn: ["review-readiness"] }),
    write("reopen-period", cli("period reopen"), "Reopen through the CLI-only audited operation.", { dependsOn: ["close-period"], condition: "Correction branch only.", boundary: "approval", requiresConfirmation: false, canonicalRecords: ["period reopen audit"] }),
    read("verify-period", mcp("period_list"), "Read back period state.", { dependsOn: ["close-period|reopen-period"] }),
  ], unsupportedBoundaries: ["Period reopen is CLI-only; no MCP parity is claimed."] }),
  workflow({ id: "backup-health-audit", capabilityId: "operations-assurance", title: "Backup, placement, health and audit verification", intendedOutcome: "Verify health and integrity, create and place a backup, and keep restore as an explicit destructive boundary.", steps: [
    read("healthcheck", mcp("system_healthcheck"), "Verify runtime and ledger readiness."),
    read("audit-verify", mcp("audit_verify"), "Verify the append-only hash chain.", { dependsOn: ["healthcheck"] }),
    read("backup-status", mcp("system_backup_status"), "Inspect backup currency and lock status.", { dependsOn: ["audit-verify"] }),
    write("create-backup", mcp("system_backup"), "Create the confirmed snapshot/archive.", { dependsOn: ["backup-status"], uncertainOutcomeReadBack: mcp("system_backup_status"), canonicalRecords: ["backup manifest", "backup audit"] }),
    write("place-backup", mcp("system_backup_place"), "Place the archive at a configured destination.", { dependsOn: ["create-backup"], canonicalRecords: ["backup placement evidence"] }),
    write("verify-placement", mcp("system_backup_verify_remote_placement"), "Verify placement against its checksum.", { dependsOn: ["place-backup"], canonicalRecords: ["verified placement evidence"] }),
    write("restore", mcp("system_restore_backup"), "Restore only to the explicitly confirmed target.", { dependsOn: ["create-backup"], condition: "Disaster-recovery branch only.", boundary: "destructive", expectedSafety: "destructive", retryClass: "unsafe-read-back", canonicalRecords: ["restored company root", "restore evidence"] }),
  ], unsupportedBoundaries: ["Rentemester does not choose provider retention policy.", "Restore never targets an implicit path."] }),
  workflow({ id: "group-intercompany", capabilityId: "group-intercompany", title: "Portfolio, group and intercompany overview", intendedOutcome: "Inspect a legal group, reconcile approved mappings and produce a read-only consolidated result.", steps: [
    read("portfolio-overview", mcp("portfolio_overview"), "Read accessible portfolio totals."),
    read("group-overview", cli("group overview"), "Read the effective-dated group graph.", { dependsOn: ["portfolio-overview"] }),
    read("intercompany-reconcile", cli("group reconcile"), "Reconcile approved intercompany mappings.", { dependsOn: ["group-overview"] }),
    read("consolidated-report", cli("group consolidated-report"), "Produce the traceable read-only consolidation view.", { dependsOn: ["intercompany-reconcile"], canonicalRecords: ["workspace group graph", "approved mappings", "approved eliminations", "derived consolidation view"] }),
  ], unsupportedBoundaries: ["Each legal entity keeps its own ledger.", "Group operations remain CLI/HTTP-only where no MCP operation is listed."] }),
  workflow({ id: "digisense-nemhandel", capabilityId: "digisense-nemhandel", title: "DigiSense and NemHandel onboarding, send, status and inbound", intendedOutcome: "Configure and onboard, send at most once, read status after uncertainty and ingest inbound documents with deduplication.", steps: [
    read("onboarding-status", mcp("efaktura_onboarding_status"), "Inspect environment and readiness."),
    write("configure", mcp("efaktura_konfigurer"), "Store provider configuration through the secret boundary.", { dependsOn: ["onboarding-status"], expectedIdempotent: true, retryClass: "external-provider-reconciled", canonicalRecords: ["e-invoice configuration audit"] }),
    write("onboard", mcp("efaktura_onboard"), "Register in the selected environment.", { dependsOn: ["configure"], expectedIdempotent: true, retryClass: "external-provider-reconciled", uncertainOutcomeReadBack: mcp("efaktura_onboarding_status"), canonicalRecords: ["participant registration evidence"] }),
    write("send", mcp("efaktura_send"), "Submit the issued invoice once.", { dependsOn: ["onboard"], expectedIdempotent: true, retryClass: "external-provider-reconciled", outputIdentities: ["submissionId"], uncertainOutcomeReadBack: mcp("efaktura_status"), canonicalRecords: ["Peppol submission events"] }),
    write("delivery-status", mcp("efaktura_status"), "Perform the actor-audited, confirmed status lookup for the existing submission.", { dependsOn: ["send"], expectedIdempotent: true, retryClass: "external-provider-reconciled", inputIdentities: ["submissionId"] }),
    write("receive", mcp("efaktura_modtag"), "Poll and ingest inbound documents with deduplication.", { dependsOn: ["onboard"], condition: "Inbound branch.", expectedIdempotent: true, retryClass: "external-provider-reconciled", canonicalRecords: ["inbound documents", "deduplication evidence"] }),
  ], unsupportedBoundaries: ["Test and production are explicit.", "Discovery exposes no credentials or participant identities."] }),
  workflow({ id: "imports-dinero", capabilityId: "imports", title: "Imports including Dinero", intendedOutcome: "Validate a source export, dry-run the supported import and apply only the explicit cut-over scope.", steps: [
    read("supported-systems", cli("import systems"), "Discover supported systems and required files."),
    read("dry-run", cli("import run"), "Validate/dry-run the selected source and fiscal scope.", { dependsOn: ["supported-systems"], boundary: "dry-run", requiresActor: true, requiredArguments: ["--dry-run"], outputIdentities: ["source hashes", "import plan"] }),
    write("apply-import", cli("import run"), "Apply the exact validated import.", { dependsOn: ["dry-run"], requiresConfirmation: false, requiredArguments: ["--apply"], outputIdentities: ["import run identity"], canonicalRecords: ["imported ledger records", "source-hash evidence", "import audit"] }),
    write("import-contacts", cli("import contacts"), "Import Dinero contacts idempotently.", { dependsOn: ["supported-systems"], condition: "Optional contacts branch.", expectedIdempotent: true, requiresConfirmation: false, retryClass: "natural-idempotent", canonicalRecords: ["customers", "vendors", "contact import audit"] }),
    read("archive", mcp("import_archive_list"), "Read the retained source archive.", { dependsOn: ["apply-import"] }),
  ], unsupportedBoundaries: ["No company-specific mapping is inferred.", "Cut-over apply remains CLI-only."] }),
  workflow({ id: "privacy-governance", capabilityId: "privacy", title: "GDPR discovery and export", intendedOutcome: "Discover and export data-subject records through audited, confirmed operations.", steps: [
    write("discover", mcp("gdpr_discover"), "Create audited discovery evidence.", { canonicalRecords: ["GDPR audit events"] }),
    write("export", mcp("gdpr_export"), "Create the confirmed subject export.", { dependsOn: ["discover"], canonicalRecords: ["GDPR export audit"] }),
    read("audit", mcp("gdpr_audit_log"), "Read back privacy evidence.", { dependsOn: ["export"] }),
  ], unsupportedBoundaries: ["Erasure/forget uses dedicated CLI contracts."] }),
  workflow({ id: "asset-register-depreciate", capabilityId: "fixed-assets", title: "Fixed asset lifecycle", intendedOutcome: "Register an asset and post the next supported depreciation period.", steps: [
    write("register", mcp("asset_register"), "Register the asset and schedule.", { canonicalRecords: ["assets", "depreciation schedule"] }),
    write("depreciate", mcp("asset_depreciate"), "Post the next reviewed depreciation.", { dependsOn: ["register"], boundary: "irreversible", uncertainOutcomeReadBack: mcp("asset_register_report"), canonicalRecords: ["asset depreciation events", "journal entries"] }),
    read("report", mcp("asset_register_report"), "Read back the asset register.", { dependsOn: ["depreciate"] }),
  ] }),
  workflow({ id: "mileage-register-report", capabilityId: "mileage", title: "Mileage registration and reporting", intendedOutcome: "Register documented business mileage and produce the supported report.", steps: [
    write("log", mcp("mileage_log"), "Register one documented trip.", { canonicalRecords: ["mileage log"] }),
    read("list", mcp("mileage_list"), "Read registered trips.", { dependsOn: ["log"] }),
    read("report", mcp("mileage_report"), "Build the mileage report.", { dependsOn: ["list"] }),
  ] }),
  workflow({ id: "planning-accrual-reporting", capabilityId: "planning-reporting", title: "Budget, accrual and tax preparation", intendedOutcome: "Maintain budget/accrual records and prepare reports without external filing.", steps: [
    write("set-budget", mcp("budget_set"), "Set reviewed budget values.", { canonicalRecords: ["budgets"] }),
    read("budget-report", mcp("budget_vs_actual"), "Compare budget with ledger actuals.", { dependsOn: ["set-budget"] }),
    write("register-accrual", mcp("accrual_register"), "Register an accrual schedule.", { canonicalRecords: ["accrual schedules"] }),
    read("tax-prepare", mcp("tax_return_prepare"), "Prepare tax-return material.", { dependsOn: ["budget-report", "register-accrual"], boundary: "review" }),
  ], unsupportedBoundaries: ["Tax/report material is not filed and is not tax advice."] }),
  workflow({ id: "posting-rule-review", capabilityId: "posting-rules", title: "Company-specific posting rule review", intendedOutcome: "Propose, independently approve and explain a reusable audited posting rule.", steps: [
    write("propose", mcp("posting_rule_propose"), "Propose an inert rule.", { expectedIdempotent: true, retryClass: "natural-idempotent", canonicalRecords: ["posting rule proposal"] }),
    write("approve", mcp("posting_rule_approve"), "Approve with reviewer separation.", { dependsOn: ["propose"], boundary: "approval", canonicalRecords: ["approved posting rule"] }),
    read("explain", mcp("posting_rule_explain"), "Explain the active rule and evidence.", { dependsOn: ["approve"] }),
  ] }),
  workflow({ id: "workspace-party-lifecycle", capabilityId: "workspace-parties", title: "Workspace party lifecycle", intendedOutcome: "Create a canonical party, attach only company-scoped roles, and review an explicit duplicate proposal without automatic identity merging.", steps: [
    read("search", mcp("workspace_party_search"), "Search only parties visible through the selected company."),
    write("create", mcp("workspace_party_create"), "Create source-backed identity evidence without a ledger effect.", { dependsOn:["search"], canonicalRecords:["workspace party events", "party identifier assertions"] }),
    write("link-role", mcp("workspace_party_link_role"), "Attach a role and defaults only for the selected company.", { dependsOn:["create"], canonicalRecords:["company party role"] }),
    write("propose-merge", mcp("workspace_party_propose_merge"), "Record an explicit human-reviewed duplicate proposal.", { dependsOn:["link-role"], boundary:"review", canonicalRecords:["party merge proposal"] }),
    write("approve-merge", mcp("workspace_party_approve_merge"), "Approve the exact proposal and append a supersession event.", { dependsOn:["propose-merge"], boundary:"approval", canonicalRecords:["party merge approval", "party supersession"] }),
    read("inspect", mcp("workspace_party_inspect"), "Read the visible canonical history and local roles.", { dependsOn:["link-role|approve-merge"] }),
  ], unsupportedBoundaries:["Name, amount or alias similarity never auto-merges a legal identity.", "Company-local defaults never become workspace posting rules."] }),
  workflow({ id: "corporate-record-lifecycle", capabilityId: "corporate-records", title: "Corporate record lifecycle", intendedOutcome: "Store immutable governance evidence, link it to permitted scope, enrich it append-only and supersede rather than overwrite it.", steps: [
    write("ingest", mcp("corporate_record_ingest"), "Ingest bytes and immutable SHA-256 evidence without ledger, group or filing side effects.", { canonicalRecords:["corporate record original bytes", "corporate record ingest event"] }),
    write("link", mcp("corporate_record_link"), "Attach a typed scope link without changing bytes.", { dependsOn:["ingest"], canonicalRecords:["corporate record scope assertion"] }),
    write("enrich", mcp("corporate_record_enrich"), "Append reviewed metadata/provenance.", { dependsOn:["link"], canonicalRecords:["corporate record enrichment event"] }),
    write("supersede", mcp("corporate_record_supersede"), "Append a correction chain to a replacement record.", { dependsOn:["enrich"], canonicalRecords:["corporate record supersession"] }),
    read("inspect", mcp("corporate_record_inspect"), "Read visible metadata/history."),
    read("download", mcp("corporate_record_download"), "Read verified original bytes only after scope authorization.", { dependsOn:["inspect"] }),
  ], unsupportedBoundaries:["Corporate records are governance evidence, never accounting vouchers or filing actions.", "Original bytes and hashes are never overwritten or deleted."] }),
];

type CapabilityTuple = [string, string, string, string, string[], string[], AgentScope, string[]];
const capabilityTuples: CapabilityTuple[] = [
  ["company-workspace", "Company and workspace setup", "Set up and discover companies without leaking inaccessible state.", "company", ["create company", "switch company", "discover workspace"], ["setup", "workspace", "company profile"], "workspace", ["company-workspace-setup"]],
  ["document-intake", "Document and mail intake", "Store source documents and mail attachments for review.", "documents", ["ingest document", "mail intake", "review invoice extraction"], ["bilag", "imap", "attachment"], "company", ["document-mail-intake"]],
  ["bank-bookkeeping", "Bank reconciliation and bookkeeping batch", "Import activity, review matches and apply a hash-bound batch.", "bank", ["reconcile bank", "match bank transactions", "bookkeeping batch"], ["bank import", "dry run", "plan hash"], "company", ["bank-reconciliation-batch"]],
  ["supplier-purchases", "Supplier expenses and payables", "Book supplier invoices directly or through payable handling.", "purchases", ["book supplier invoice", "pay supplier invoice", "book expense"], ["vendor", "payable", "purchase VAT"], "company", ["supplier-expense-booking", "supplier-payable-handling"]],
  ["customer-invoicing", "Customer invoice lifecycle", "Create customers and handle issue, delivery, payment, reminder and correction.", "sales", ["issue customer invoice", "send invoice", "record payment", "send reminder", "credit note"], ["customer", "invoice", "settlement"], "company", ["customer-invoice-lifecycle"]],
  ["vat", "VAT preparation", "Validate and post supported VAT treatments and prepare evidence.", "vat", ["prepare VAT", "domestic purchase VAT", "reverse charge"], ["moms", "VIES", "input VAT"], "company", ["vat-preparation"]],
  ["exceptions-corrections", "Exceptions and corrections", "Resolve blockers and correct through append-only reversals.", "ledger", ["resolve exception", "reverse posting", "correct bookkeeping"], ["correction", "credit note", "audit"], "company", ["exceptions-corrections"]],
  ["period-management", "Period management", "Inspect, close and explicitly reopen periods.", "period", ["close period", "reopen period", "period readiness"], ["lock", "fiscal period"], "company", ["period-close-reopen"]],
  ["operations-assurance", "Backup, health and audit", "Verify integrity and create, place, verify or restore backups.", "system", ["verify backup", "healthcheck", "verify audit", "restore backup"], ["readiness", "checksum", "placement"], "system", ["backup-health-audit"]],
  ["group-intercompany", "Portfolio, group and intercompany", "Inspect group state, reconcile mappings and derive consolidation views.", "group", ["group overview", "intercompany reconciliation", "consolidated report"], ["portfolio", "elimination", "legal group"], "legal-group", ["group-intercompany"]],
  ["digisense-nemhandel", "DigiSense and NemHandel", "Onboard, send once, read status and receive electronic invoices.", "efaktura", ["send e-invoice", "NemHandel onboarding", "receive e-invoice"], ["Digisense", "Peppol", "OIOUBL"], "company", ["digisense-nemhandel"]],
  ["imports", "Imports including Dinero", "Validate and apply supported cut-over imports.", "imports", ["import from Dinero", "migrate accounting data", "import contacts"], ["archive", "cut-over", "source hash"], "company", ["imports-dinero"]],
  ["privacy", "Privacy governance", "Perform audited GDPR discovery and export.", "privacy", ["GDPR export", "data subject discovery"], ["privacy", "erasure"], "company", ["privacy-governance"]],
  ["fixed-assets", "Fixed assets", "Register assets and post depreciation.", "assets", ["register asset", "depreciate asset"], ["anlæg", "write-off"], "company", ["asset-register-depreciate"]],
  ["mileage", "Mileage", "Register and report documented business mileage.", "mileage", ["log mileage", "mileage report"], ["trip", "kilometres"], "company", ["mileage-register-report"]],
  ["planning-reporting", "Planning and reporting", "Maintain budgets/accruals and prepare tax/reporting material.", "reporting", ["budget versus actual", "register accrual", "prepare tax return", "annual report"], ["forecast", "report", "tax"], "company", ["planning-accrual-reporting"]],
  ["posting-rules", "Posting rules", "Propose, approve and explain reusable posting rules.", "rules", ["create posting rule", "approve bookkeeping rule"], ["automation", "review separation"], "company", ["posting-rule-review"]],
  ["workspace-parties", "Workspace parties", "Maintain canonical counterparties with isolated company roles and reviewed supersession.", "master data", ["create canonical party", "link company party role", "review duplicate party"], ["party", "counterparty", "identity", "vendor role"], "workspace", ["workspace-party-lifecycle"]],
  ["corporate-records", "Corporate records", "Store immutable corporate and governance evidence with typed, access-controlled links.", "governance", ["ingest corporate record", "link governance evidence", "supersede corporate record"], ["corporate record", "governance", "articles", "ownership evidence"], "workspace", ["corporate-record-lifecycle"]],
];

export const AGENT_CAPABILITIES: readonly AgentCapability[] = capabilityTuples.map(([id, title, purpose, domain, outcomes, keywords, scope, workflowIds]) => ({
  id, title, purpose, domain, outcomes, keywords, scope, supportStatus: "supported", maturity: "stable", workflowIds,
  canonicalState: AGENT_WORKFLOWS.filter((item) => workflowIds.includes(item.id)).flatMap((item) => item.steps.flatMap((itemStep) => itemStep.canonicalRecords)),
  unsupportedBoundaries: AGENT_WORKFLOWS.filter((item) => workflowIds.includes(item.id)).flatMap((item) => item.unsupportedBoundaries),
}));

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") { const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`; }
  return JSON.stringify(value);
}

export const AGENT_CATALOGUE_HASH = createHash("sha256").update(canonicalJson({ schemaVersion: AGENT_CATALOGUE_SCHEMA_VERSION, capabilities: AGENT_CAPABILITIES, workflows: AGENT_WORKFLOWS })).digest("hex");

export function catalogueIdentity() {
  let ruleBundleVersion: string | null = null;
  try { ruleBundleVersion = currentRuleBundleVersion(); } catch {}
  return { schemaVersion: AGENT_CATALOGUE_SCHEMA_VERSION, hash: AGENT_CATALOGUE_HASH, entryPoint: AGENT_CATALOGUE_ENTRY_POINT, capabilityCount: AGENT_CAPABILITIES.length, workflowCount: AGENT_WORKFLOWS.length, coverage: coverageIdentity(), build: getBuildIdentity(), provenance: getReleaseProvenance(), ruleBundleVersion };
}

export type LiveTool = { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } };
export type LiveOperationSources = { tools?: readonly LiveTool[]; commands?: readonly DiscoveryCommand[]; routes?: readonly DiscoveryRoute[]; unavailableSurfaces?: Array<"mcp" | "cli" | "http"> };

export function operationId(reference: OperationReference): string { return reference.surface === "mcp" ? `mcp:${reference.name}` : reference.surface === "cli" ? `cli:${reference.key}` : `http:${reference.method} ${reference.pattern}`; }

function resolveOperation(reference: OperationReference, sources: LiveOperationSources) {
  if (reference.surface === "mcp") {
    if (sources.unavailableSurfaces?.includes("mcp")) return { ...reference, id: operationId(reference), resolved: null, reason: "MCP registry is not part of this HTTP transport; resolve with MCP tools/list." };
    const tool = sources.tools?.find((candidate) => candidate.name === reference.name);
    if (!tool) return { ...reference, id: operationId(reference), resolved: false, reason: "Live MCP tool is not registered." };
    if (!tool.annotations || typeof tool.annotations.readOnlyHint !== "boolean") return { ...reference, id: operationId(reference), resolved: false, reason: "Live MCP tool has no safety annotations." };
    return { ...reference, id: operationId(reference), resolved: true, safety: tool.annotations.readOnlyHint ? "read" : tool.annotations.destructiveHint ? "destructive" : "write", idempotent: tool.annotations.idempotentHint === true };
  }
  if (reference.surface === "cli") return sources.commands?.some((candidate) => candidate.key === reference.key) ? { ...reference, id: operationId(reference), resolved: true } : { ...reference, id: operationId(reference), resolved: false, reason: "Canonical CLI command is not registered." };
  const route = sources.routes?.find((candidate) => candidate.method === reference.method && candidate.pattern === reference.pattern);
  return route ? { ...reference, id: operationId(reference), resolved: true, safety: route.effect === "read" ? "read" : route.effect === "destructive" ? "destructive" : "write" } : { ...reference, id: operationId(reference), resolved: false, reason: "HTTP route is not catalogued." };
}

export function searchCapabilities(query: string | undefined, cursor: number, limit: number, sources?: LiveOperationSources) {
  const tokens = (query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = AGENT_CAPABILITIES.filter((item) => { const haystack = [item.id, item.title, item.purpose, item.domain, ...item.outcomes, ...item.keywords].join(" ").toLowerCase(); return tokens.every((token) => haystack.includes(token)); });
  const bindings = sources ? discoverableOperationBindings(sources) : [];
  const items = matching.slice(cursor, cursor + limit).map(({ canonicalState: _canonicalState, keywords: _keywords, ...item }) => ({
    ...item,
    operations: bindings.filter((binding) => binding.capabilityIds.includes(item.id)),
  }));
  return { catalogue: catalogueIdentity(), total: matching.length, count: items.length, cursor, limit, hasMore: cursor + items.length < matching.length, nextCursor: cursor + items.length < matching.length ? cursor + items.length : null, items };
}

export function describeWorkflow(id: string, sources: LiveOperationSources) {
  const item = AGENT_WORKFLOWS.find((candidate) => candidate.id === id);
  if (!item) return null;
  const capability = AGENT_CAPABILITIES.find((candidate) => candidate.id === item.capabilityId)!;
  const steps = item.steps.map((itemStep) => ({ ...itemStep, operation: resolveOperation(itemStep.operation, sources), uncertainOutcomeReadBack: itemStep.uncertainOutcomeReadBack ? resolveOperation(itemStep.uncertainOutcomeReadBack, sources) : undefined }));
  const unresolved = steps.filter((itemStep) => itemStep.operation.resolved === false).map((itemStep) => itemStep.operation.id);
  return { catalogue: catalogueIdentity(), capability, workflow: { ...item, steps, live: unresolved.length === 0, unresolvedOperations: unresolved } };
}

export const AGENT_DISCOVERY_INTERNALS = { canonicalJson, resolveOperation };

export type DiscoveryCommand = {
  key: string;
  mutating?: boolean;
  sideEffecting?: boolean;
  allowedFlags?: readonly string[];
};
export type DiscoveryRoute = {
  method: string;
  pattern: string;
  effect?: string;
};
export type DiscoveryOperationBinding = {
  id: string;
  capabilityIds: string[];
  safety: OperationSafety;
  idempotent: boolean | null;
  requiresActor: boolean;
  requiresConfirmation: boolean;
  retryClass: RetryClass;
};

/** These are the only MCP mutations with a durable caller-key receipt. Keep
 * this list deliberately small: adding an entry is a transaction/audit change,
 * not a metadata-only promise. */
export const KEY_IDEMPOTENT_MCP_OPERATIONS = RETRY_OPERATION_NAMES.keyIdempotent;
/** Explicitly reviewed domain-deduplication contracts.  Do not derive this
 * class from `idempotentHint`: that hint is evidence which this list validates,
 * not a substitute for a retry contract. */
const NATURAL_IDEMPOTENT_MCP_OPERATIONS = RETRY_OPERATION_NAMES.naturalIdempotent;

/** Provider calls may have an accepted remote identity. They must be reconciled
 * with that identity/status before a retry, even where the local action itself
 * has de-duplication. */
const EXTERNAL_PROVIDER_MCP_OPERATIONS = RETRY_OPERATION_NAMES.externalProviderReconciled;
const NATURAL_IDEMPOTENT_CLI_OPERATIONS = RETRY_OPERATION_NAMES.naturalIdempotentCli;

export function retryClassForOperation(id: string, source: { safety: OperationSafety; idempotent: boolean | null; external?: boolean }): RetryClass {
  if (source.safety === "read") return "safe-read";
  if (source.external || (id.startsWith("mcp:") && EXTERNAL_PROVIDER_MCP_OPERATIONS.has(id.slice(4)))) return "external-provider-reconciled";
  if (id.startsWith("mcp:") && KEY_IDEMPOTENT_MCP_OPERATIONS.has(id.slice(4))) return "key-idempotent";
  if ((id.startsWith("mcp:") && NATURAL_IDEMPOTENT_MCP_OPERATIONS.has(id.slice(4))) || (id.startsWith("cli:") && NATURAL_IDEMPOTENT_CLI_OPERATIONS.has(id.slice(4)))) return "natural-idempotent";
  return "unsafe-read-back";
}

type SurfaceName = "mcp" | "cli" | "http";
type SurfaceBaseline = { count: number; hash: string };

/**
 * Reviewed identities of the three public operation registries. The live
 * registries remain authoritative; these compact snapshots make additions and
 * removals require an explicit discovery review without copying hundreds of
 * operation names into a second hand-maintained catalogue.
 */
export const AGENT_SURFACE_BASELINES: Record<SurfaceName, SurfaceBaseline> = {
  mcp: { count: 155, hash: "078b8f8c742482d9007b12778a1d70509089581e13b2b9135e67bcefaf9e8ede" },
  cli: { count: 219, hash: "a63a4f63b83736f9644773dd37cefd98d1c7d4ff954d361412662d2694a454a6" },
  // #573 service-principal lifecycle routes are public runtime operations and
  // therefore deliberately part of the identity-bound discovery surface.
  http: { count: 158, hash: "b0c3b65a32184dc9dd12fd863b2c8609807db5360e6535bab50c47cdd71962c9" },
};

const CAPABILITY_RULES: ReadonlyArray<{ capabilityId: string; pattern: RegExp }> = [
  { capabilityId: "corporate-records", pattern: /(?:corporate[_-]record|corporate-record)/ },
  { capabilityId: "workspace-parties", pattern: /(?:workspace[_-]party|^cli:party )/ },
  { capabilityId: "digisense-nemhandel", pattern: /(?:efaktura|digisense|peppol|send-public)/ },
  { capabilityId: "group-intercompany", pattern: /(?:group|portfolio)/ },
  { capabilityId: "posting-rules", pattern: /(?:posting[_-]rules?|posting_rule|agent-suggestions)/ },
  { capabilityId: "fixed-assets", pattern: /(?:asset|fixed-assets)/ },
  { capabilityId: "mileage", pattern: /mileage/ },
  { capabilityId: "privacy", pattern: /gdpr/ },
  { capabilityId: "period-management", pattern: /(?:period|fiscal-years)/ },
  { capabilityId: "vat", pattern: /(?:vat|moms|oss-report|eu-sales)/ },
  { capabilityId: "bank-bookkeeping", pattern: /(?:bank|reconcile|bookkeeping[_-]batch)/ },
  { capabilityId: "document-intake", pattern: /(?:documents?|mail[_-]intake|imap[_-]intake|bilagsmail)/ },
  { capabilityId: "supplier-purchases", pattern: /(?:expense|payable|vendor|supplier)/ },
  { capabilityId: "customer-invoicing", pattern: /(?:invoice|customer|recurring)/ },
  { capabilityId: "exceptions-corrections", pattern: /(?:exceptions?|journal|accounting-draft|opening-balance)/ },
  { capabilityId: "imports", pattern: /(?:import|archive\/:year)/ },
  { capabilityId: "planning-reporting", pattern: /(?:report|dashboard|budget|cashflow|tax_return|tax\b|annual|accrual|compliance|obligations|multi-year)/ },
  { capabilityId: "operations-assurance", pattern: /(?:system|audit|health|ready|retention|integrity|backup|meta_about|agent[_-]capabilit|agent[_-]workflow|agent run|reg coverage|reg citations|serve|local start)/ },
  { capabilityId: "company-workspace", pattern: /(?:company|companies|workspace|accounts?|cvr|contacts|members|invitations|^cli:init$|^http:get \/api$|^http:get \/api\/health$|^http:get \/api\/rules$|^http:get \/api\/me$)/ },
];

export const AGENT_DISCOVERY_COVERAGE_RULES_HASH = createHash("sha256")
  .update(canonicalJson({
    schemaVersion: "rentemester-agent-discovery-coverage-v1",
    baselines: AGENT_SURFACE_BASELINES,
    rules: CAPABILITY_RULES.map((rule) => ({ capabilityId: rule.capabilityId, pattern: rule.pattern.source })),
  }))
  .digest("hex");

export function coverageIdentity() {
  return {
    schemaVersion: "rentemester-agent-discovery-coverage-v1" as const,
    rulesHash: AGENT_DISCOVERY_COVERAGE_RULES_HASH,
    surfaceBaselines: AGENT_SURFACE_BASELINES,
  };
}

export function capabilityIdsForOperation(id: string): string[] {
  const normalized = id.toLowerCase();
  return [...new Set(CAPABILITY_RULES.filter((rule) => rule.pattern.test(normalized)).map((rule) => rule.capabilityId))];
}

function surfaceHash(ids: readonly string[]): string {
  return createHash("sha256").update([...ids].sort().join("\n")).digest("hex");
}

function sourceOperationIds(input: AgentDiscoveryCoverageInput): Record<SurfaceName, string[]> {
  return {
    mcp: input.tools.map((tool) => tool.name).sort(),
    cli: input.commands.map((command) => command.key).sort(),
    http: input.routes.map((route) => `${route.method} ${route.pattern}`).sort(),
  };
}

function bindingForOperation(id: string, input: AgentDiscoveryCoverageInput): DiscoveryOperationBinding | null {
  const capabilityIds = (input.classifyOperation ?? capabilityIdsForOperation)(id);
  if (capabilityIds.length === 0) return null;
  if (id.startsWith("mcp:")) {
    const tool = input.tools.find((item) => item.name === id.slice(4));
    if (!tool?.annotations || typeof tool.annotations.readOnlyHint !== "boolean") return null;
    const safety = tool.annotations.readOnlyHint ? "read" : tool.annotations.destructiveHint ? "destructive" : "write";
    const idempotent = tool.annotations.idempotentHint === true;
    return { id, capabilityIds, safety, idempotent, requiresActor: safety !== "read", requiresConfirmation: safety !== "read", retryClass: retryClassForOperation(id, { safety, idempotent }) };
  }
  if (id.startsWith("cli:")) {
    const command = input.commands.find((item) => item.key === id.slice(4));
    if (!command) return null;
    const safety: OperationSafety = command.mutating || command.sideEffecting ? "write" : "read";
    const idempotent = safety === "read" ? true : null;
    return { id, capabilityIds, safety, idempotent, requiresActor: command.mutating === true, requiresConfirmation: command.allowedFlags?.includes("--confirm") === true, retryClass: retryClassForOperation(id, { safety, idempotent }) };
  }
  const routeId = id.slice(5);
  const separator = routeId.indexOf(" ");
  const route = input.routes.find((item) => item.method === routeId.slice(0, separator) && item.pattern === routeId.slice(separator + 1));
  if (!route) return null;
  const safety: OperationSafety = route.effect === "read" ? "read" : "write";
  const idempotent = safety === "read" ? true : null;
  return { id, capabilityIds, safety, idempotent, requiresActor: false, requiresConfirmation: false, retryClass: retryClassForOperation(id, { safety, idempotent, external: route.effect === "external" }) };
}

export function discoverableOperationBindings(sources: LiveOperationSources): DiscoveryOperationBinding[] {
  const input: AgentDiscoveryCoverageInput = {
    tools: sources.tools ?? [],
    commands: sources.commands ?? [],
    routes: sources.routes ?? [],
  };
  const ids = sourceOperationIds(input);
  return [
    ...ids.mcp.map((id) => `mcp:${id}`),
    ...ids.cli.map((id) => `cli:${id}`),
    ...ids.http.map((id) => `http:${id}`),
  ]
    .map((id) => bindingForOperation(id, input))
    .filter((binding): binding is DiscoveryOperationBinding => binding !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export type AgentDiscoveryCoverageInput = {
  tools: readonly LiveTool[];
  commands: readonly DiscoveryCommand[];
  routes: readonly DiscoveryRoute[];
  workflows?: readonly AgentWorkflow[];
  capabilities?: readonly AgentCapability[];
  expectedOperationIds?: readonly string[];
  classifyOperation?: (id: string) => string[];
  standaloneOperationIds?: readonly string[];
  imageDigest?: string | null;
};

export type AgentDiscoveryCoverageReport = {
  schemaVersion: "rentemester-agent-discovery-coverage-v1";
  ok: boolean;
  catalogue: ReturnType<typeof catalogueIdentity>;
  coverageHash: string;
  imageDigest: string | null;
  counts: { mcp: number; cli: number; http: number; capabilities: number; workflows: number; bindings: number };
  bindings: DiscoveryOperationBinding[];
  errors: string[];
};

export function validateAgentDiscoveryCoverage(input: AgentDiscoveryCoverageInput): AgentDiscoveryCoverageReport {
  const capabilities = input.capabilities ?? AGENT_CAPABILITIES;
  const workflows = input.workflows ?? AGENT_WORKFLOWS;
  const capabilityIds = new Set(capabilities.map((item) => item.id));
  const workflowIds = new Set(workflows.map((item) => item.id));
  const surfaces = sourceOperationIds(input);
  const liveIds = [...surfaces.mcp.map((id) => `mcp:${id}`), ...surfaces.cli.map((id) => `cli:${id}`), ...surfaces.http.map((id) => `http:${id}`)].sort();
  const errors: string[] = [];

  if (input.expectedOperationIds) {
    const expected = new Set(input.expectedOperationIds);
    const live = new Set(liveIds);
    for (const id of liveIds) if (!expected.has(id)) errors.push(`${id}: new public operation is not in the reviewed discovery baseline; classify it and update the baseline.`);
    for (const id of expected) if (!live.has(id)) errors.push(`${id}: reviewed operation is not live; restore it or remove its discovery classification.`);
  } else {
    for (const surface of ["mcp", "cli", "http"] as const) {
      const actual = { count: surfaces[surface].length, hash: surfaceHash(surfaces[surface]) };
      const expected = AGENT_SURFACE_BASELINES[surface];
      if (actual.count !== expected.count || actual.hash !== expected.hash) {
        errors.push(`${surface}: public surface identity changed (expected ${expected.count}/${expected.hash}, got ${actual.count}/${actual.hash}); review the live registrations, capability mappings and workflows, then update AGENT_SURFACE_BASELINES.`);
      }
    }
  }

  if ((input.standaloneOperationIds?.length ?? 0) > 0) {
    errors.push(`standalone classifications are not accepted: ${input.standaloneOperationIds!.join(", ")}; link every public operation to a named capability.`);
  }

  const bindings: DiscoveryOperationBinding[] = [];
  for (const id of liveIds) {
    const binding = bindingForOperation(id, input);
    if (!binding) {
      errors.push(`${id}: no live, machine-readable capability binding; add an explicit classification rule and reviewed surface identity.`);
      continue;
    }
    for (const capabilityId of binding.capabilityIds) {
      if (!capabilityIds.has(capabilityId)) errors.push(`${id}: capability binding '${capabilityId}' does not exist in AGENT_CAPABILITIES.`);
    }
    bindings.push(binding);
  }

  // A generic annotation cannot silently upgrade a retry guarantee. Every
  // public write has one explicit class, and each stronger claim must agree
  // with its live evidence. This catches both an unreviewed natural hint and
  // stale allow-list entries when a tool changes behaviour.
  for (const tool of input.tools) {
    const id = `mcp:${tool.name}`;
    const binding = bindings.find((item) => item.id === id);
    if (!binding || binding.safety === "read") continue;
    const explicitlyIdempotent = KEY_IDEMPOTENT_MCP_OPERATIONS.has(tool.name) || NATURAL_IDEMPOTENT_MCP_OPERATIONS.has(tool.name) || EXTERNAL_PROVIDER_MCP_OPERATIONS.has(tool.name);
    if (tool.annotations?.idempotentHint === true && !explicitlyIdempotent) errors.push(`${id}: live idempotentHint has no explicit retry classification; add a reviewed natural-idempotent or external-provider-reconciled contract.`);
    if (binding.retryClass === "natural-idempotent" && tool.annotations?.idempotentHint !== true) errors.push(`${id}: natural-idempotent claim lacks live idempotentHint evidence.`);
    if (binding.retryClass === "key-idempotent" && tool.annotations?.idempotentHint === true) errors.push(`${id}: key-idempotent operation must not also claim natural idempotency.`);
  }

  for (const capability of capabilities) {
    if (capability.workflowIds.length === 0) errors.push(`capability:${capability.id}: no canonical workflow is linked.`);
    for (const workflowId of capability.workflowIds) if (!workflowIds.has(workflowId)) errors.push(`capability:${capability.id}: workflow '${workflowId}' does not exist.`);
    if (!bindings.some((binding) => binding.capabilityIds.includes(capability.id))) errors.push(`capability:${capability.id}: no live public operation is discoverable through this capability.`);
  }

  for (const workflow of workflows) {
    if (!capabilityIds.has(workflow.capabilityId)) errors.push(`workflow:${workflow.id}: capability '${workflow.capabilityId}' does not exist.`);
    const capability = capabilities.find((item) => item.id === workflow.capabilityId);
    if (!capability?.workflowIds.includes(workflow.id)) errors.push(`workflow:${workflow.id}: reverse link from capability '${workflow.capabilityId}' is missing.`);
    const stepIds = new Set(workflow.steps.map((item) => item.id));
    for (const workflowStep of workflow.steps) {
      for (const dependencyGroup of workflowStep.dependsOn) {
        for (const dependency of dependencyGroup.split("|")) if (!stepIds.has(dependency)) errors.push(`workflow:${workflow.id}/${workflowStep.id}: dangling dependency '${dependency}'.`);
      }
      const id = operationId(workflowStep.operation);
      const binding = bindings.find((item) => item.id === id);
      if (!binding) {
        errors.push(`workflow:${workflow.id}/${workflowStep.id}: ${id} is not live and capability-bound.`);
        continue;
      }
      const dryRunVariant = workflowStep.operation.surface === "cli" && workflowStep.requiredArguments?.includes("--dry-run");
      const actualSafety = dryRunVariant ? "read" : binding.safety;
      if (actualSafety !== workflowStep.expectedSafety) errors.push(`workflow:${workflow.id}/${workflowStep.id}: ${id} safety claim '${workflowStep.expectedSafety}' contradicts live '${actualSafety}'.`);
      if (workflowStep.operation.surface === "mcp" && binding.idempotent !== workflowStep.expectedIdempotent) errors.push(`workflow:${workflow.id}/${workflowStep.id}: ${id} idempotency claim '${workflowStep.expectedIdempotent}' contradicts live '${binding.idempotent}'.`);
      if (workflowStep.operation.surface !== "http" && binding.requiresActor !== workflowStep.requiresActor) errors.push(`workflow:${workflow.id}/${workflowStep.id}: ${id} actor requirement contradicts the live surface.`);
      if (workflowStep.operation.surface !== "http" && binding.requiresConfirmation !== workflowStep.requiresConfirmation) errors.push(`workflow:${workflow.id}/${workflowStep.id}: ${id} confirmation requirement contradicts the live surface.`);
      if (!dryRunVariant && workflowStep.retryClass !== binding.retryClass) errors.push(`workflow:${workflow.id}/${workflowStep.id}: ${id} retry class '${workflowStep.retryClass}' contradicts live '${binding.retryClass}'. Use the canonical retry contract; do not infer key idempotency from an input field.`);
      if (actualSafety === "read" && workflowStep.retryClass !== "safe-read") errors.push(`workflow:${workflow.id}/${workflowStep.id}: read operation must use safe-read retry semantics.`);
      if (actualSafety === "destructive" && workflowStep.retryClass !== "unsafe-read-back") errors.push(`workflow:${workflow.id}/${workflowStep.id}: destructive operation requires read-back-before-retry semantics.`);
    }
  }

  const sortedBindings = bindings.sort((a, b) => a.id.localeCompare(b.id));
  const coverageHash = createHash("sha256").update(canonicalJson({ catalogueHash: AGENT_CATALOGUE_HASH, baselines: AGENT_SURFACE_BASELINES, bindings: sortedBindings, workflows: workflows.map((item) => item.id) })).digest("hex");
  return {
    schemaVersion: "rentemester-agent-discovery-coverage-v1",
    ok: errors.length === 0,
    catalogue: catalogueIdentity(),
    coverageHash,
    imageDigest: input.imageDigest ?? null,
    counts: { mcp: input.tools.length, cli: input.commands.length, http: input.routes.length, capabilities: capabilities.length, workflows: workflows.length, bindings: sortedBindings.length },
    bindings: sortedBindings,
    errors,
  };
}
