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
