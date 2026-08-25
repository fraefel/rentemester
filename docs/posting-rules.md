# Posteringsregler

Posteringsregler er selskabslokale, versionerede forslag. De er ikke Lovgrundlag: Lovgrundlag viser juridiske kilder, mens denne funktion viser den konkrete, auditérbare automatisering i én virksomheds ledger.

Alle overflader bruger `src/core/posting-rules.ts`:

- CLI: `posting-rules propose|approve|disable|supersede|explain|test`.
- MCP: `posting_rule_propose|approve|disable|supersede|explain|test`.
- Cockpit API: `/api/companies/:slug/posting-rules` samt `/explain` og lifecycle-actions.

Skrivende operationer kræver en autoriseret actor og eksplicit bekræftelse på MCP/HTTP. Godkendelse er bundet til regelversionens SHA-256 payload-hash, og skaberen kan ikke godkende sin egen regel. `explain` og `test` er read-only dry-runs og returnerer præcise årsager for eksakt match, ikke-match og evidensafvigelser.
