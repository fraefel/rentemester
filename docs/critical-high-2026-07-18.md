# Critical/high acceptance evidence — 2026-07-18

This integration is local-only. It does not use credentials, contact remote
providers, mutate production data, or perform a production migration.

| Issue | Focused regression / deterministic acceptance evidence |
|---|---|
| #323 | `tests/unit/windows-filesystem-safety.test.ts` exercises close-before-delete and bounded Windows retry behavior. |
| #508 | `tests/unit/system-restore-target-guard.test.ts` and `windows-filesystem-safety.test.ts` cover drive, UNC, separator, traversal and symlink-safe restore containment. |
| #515 | `bun run --cwd app test` and `bun run --cwd app build` enforce the strict cockpit type-check and production build. |
| #529 | `document-ingest.test.ts` proves that a US supplier without an EU ID can be ingested and deduplicated from country/name/invoice evidence, including both directions of later home-registration-ID enrichment. `expense-booking.test.ts` blocks foreign/local tax from the Danish `standard`, `representation`, payable, and identity-less cash-receipt deduction paths while keeping explicit gross-cost `non_deductible` available. Automatic non-EU reverse-charge input-VAT deduction remains fail-closed until the invoice contains a home-country registration number, the buyer VAT ID exactly matches the configured company CVR, and reverse-charge wording is confirmed; the test then verifies non-EU VAT report/rubric semantics. `authority-export.test.ts`, `saft-export.test.ts`, `mcp-server.test.ts`, server tests, and Cockpit tests prove the provenance survives every read/export boundary. |
| #530 | `purchase-vat-lines.test.ts` covers the scoped Danish taxable/exempt split for the exact 975/243.75 + 670/0 invoice through payable booking, authority/SAF-T export, fail-closed comparison with the canonical document total/VAT columns, and both signs of one-øre FX residual. It also proves reverse-charge/representation paths cannot silently ignore a structured split. `expense-booking.test.ts` verifies a signed outgoing EUR bank row (`amount=-100`, `amount_dkk=-746`) becomes a positive 746 DKK journal valuation. `document-cli.test.ts`, `mcp-server.test.ts`, server tests, and `DocumentIngestModal.test.tsx` prove the split round-trips through every public surface. |
| #531 | `tests/unit/fx-persistence-regression.test.ts` reopens the database and verifies original currency, original amount, FX rate, and DKK amount in stored data and authority JSON/CSV export. |
| #533 | `tests/unit/vat-critical-high-regression.test.ts` covers the shared rubric projection and reverse-charge parity. |
| #540 | `tests/unit/import-archive-integrity.test.ts` covers complete ZIP listing/extraction/hash/count verification before mutation. |
| #541 | `tests/unit/import-archive-integrity.test.ts` and import framework tests assert nonzero opening-balance/VAT-group differences fail closed. |
| #544 | `tests/unit/account-roles.test.ts` covers versioned, audited confirmed/proposed mappings and fail-closed resolver behavior. |
| #545 | `tests/unit/vat-critical-high-regression.test.ts` and `journal-post.test.ts` cover trusted import provenance and manual-journal VAT blocking. |
| #546 | `tests/unit/vat-critical-high-regression.test.ts`, `vat-period-type.test.ts`, and `db-customers-migration.test.ts` cover cadence bounds, deadlines, idempotency, and conflict failure. |
| #547 | `tests/unit/backup-remote-provider.test.ts` covers mock remote success, mismatch, stale metadata, revoked access, and provider errors. |

## Rehearsed local migration gates

The migration suite runs `migrate()` repeatedly against local temporary SQLite
ledgers, including legacy VAT-period conversion. It preserves identifiers,
lifecycle history, triggers, and indexes; conflicting already-filed periods
fail closed rather than choosing a winner.

The following require human confirmation and are intentionally not automated:

- ambiguous imported account-role proposals;
- conflicting filed VAT periods;
- real cloud-provider credentials and remote evidence;
- legal residency attestations;
- ambiguous supplier identity;
- any production migration.
