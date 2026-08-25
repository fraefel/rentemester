# Dokumentscanning ved hosted indtag

Lokale installationer og CLI/MCP-indtag kører eksplicit med scanning slået fra.
Det er bevidst: de arbejder med lokale filer og må ikke få en skjult
netværksafhængighed. En hosted Cockpit-installation kan derimod kræve en
scanner for alle `POST /documents/ingest`-uploads.

Sæt kun i hosted drift:

```text
RENTEMESTER_DOCUMENT_SCANNER_POLICY=required
RENTEMESTER_DOCUMENT_SCANNER_PROVIDER=http-json-v1
RENTEMESTER_DOCUMENT_SCANNER_URL=https://scanner.example/scan
RENTEMESTER_DOCUMENT_SCANNER_BEARER_TOKEN=<deployment-secret>
RENTEMESTER_DOCUMENT_SCANNER_TIMEOUT_MS=15000
```

`required` uden komplet, HTTPS-baseret provider-konfiguration stopper opstart
før serveren binder en socket. `off` (standard) må ikke kombineres med
scanner-credentials, så en konfiguration aldrig ignoreres lydløst.

`http-json-v1` sender `sha256`, `mimeType`, `filename` og `bytesBase64` med
Bearer-godkendelse. Et rent svar er `{ "ok": true, "scannerId": "..." }`;
scanner-version og en kort, ikke-hemmelig evidensreference kan tilføjes.
Alt andet — HTTP-fejl, ugyldigt JSON, afvisning eller timeout — afviser
indtaget uden bilag eller audit-række. Secrets, URL og provider-fejl sendes
aldrig til klienten eller de strukturerede request-logs.

Rentemester giver scanneren en privat bytekopi og afbryder den efter den
konfigurerede hårde deadline. Den kan derfor ikke ændre de bytes, der
hashes, MIME-valideres igen og publiceres eksklusivt som originalt bilag.

## Fakturaudtræk

Automatisk fakturaudtræk er kun aktivt, når drift eksplicit konfigurerer en
processor. Det er aldrig en lokal fallback og PDF-indtag kræver ikke, at
brugeren genindtaster synlige felter. Valgfri metadata sammenholdes i stedet
med det citerede udtræk og skaber en exception ved konflikt.

```text
RENTEMESTER_INVOICE_EXTRACTION_PROVIDER=http-json-v1
RENTEMESTER_INVOICE_EXTRACTION_URL=https://processor.example/invoice-extract
RENTEMESTER_INVOICE_EXTRACTION_BEARER_TOKEN=<deployment-secret>
RENTEMESTER_INVOICE_EXTRACTION_TIMEOUT_MS=15000
```

`http-json-v1` modtager kun PDF-bytes og SHA-256 via TLS og returnerer citede
felter (`value`, `confidence`, `page`, `sourceText`, valgfri `box`). Drift skal
have en databehandleraftale, overførselshjemmel og retention-/adgangskontroller
for udbyderen, før den aktiveres. URL'er, tokens, filstier og providerdiagnoser
returneres aldrig af CLI, MCP eller cockpit.
