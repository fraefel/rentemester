# Bun 1.4-vurdering og versioneret containerdistribution

Status: vurdering og implementeret runtime/release-kandidatgrundlag,
2026-08-24. Ingen ekstern release eller GHCR-push er udført.

## Beslutning

Rentemester er opgraderet fra Bun 1.3.14 til Bun 1.4.0 som en selvstændig,
reviewbar runtime-release-kandidat. Udgivelse som ny SemVer-release er fortsat
en særskilt, godkendelseskrævende handling. Den eksisterende
containerdistribution på GHCR skal
fortsætte som den autoritative måde at distribuere produktet på:

- hvert produkt får en SemVer-version;
- en release candidate bygges én gang og identificeres ved OCI-digest;
- Digisense tester den præcise digest, ikke et flytbart tag;
- en godkendelse bindes til version, commit, manifest-digest og image-digest;
- de allerede testede bytes promoveres til `vX.Y.Z` uden rebuild;
- drift fastlåser fortsat `repository@sha256:<digest>` og bruger aldrig
  `latest`.

Denne model er allerede implementeret i release-workflows og beskrevet i
`docs/release/README.md` og `docs/versioning.md`. Opgaven er derfor at anvende
og udbygge den, ikke at opfinde et nyt releaseflow.

## Nuværende status

Produktkoden er Bun-native:

- ledgers bruger `bun:sqlite`;
- cockpit-serveren bruger `Bun.serve` og `Bun.file`;
- CLI, MCP-server, scripts og root-tests kører direkte i Bun;
- cockpit-frontend, dev-server og test-runner er cuttet helt over til Bun 1.4;
  Vite og Vitest er ikke længere installerede dependencies;
- Docker-imaget indeholder runtime, CLI, MCP, HTTP API og cockpit som én
  versioneret enhed.

Repositoryets Docker-, CI- og runtime-kontrakter er nu fastlåst til den
officielle Bun 1.4.0-release
(`34cbb9a40`). Den aktuelle `oven/bun:1.4.0-slim` OCI-index havde ved
undersøgelsen digest
`sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6`.
Ved en fremtidig Bun- eller base-imageændring skal digest genverificeres og
pinnes eksplicit ligesom i det nuværende image.

Root og cockpit er samlet som ét Bun-workspace med én `bun.lock`. En enkelt
`bun install --frozen-lockfile` installerer begge pakker. Docker bruger samme
frosne workspace-install til cockpit-builden og et root-filter til den mindre
produktionsruntime.

## Verificeret kompatibilitet og image-reproducerbarhed

Følgende blev kørt mod det eksisterende checkout uden at ændre produktkode
eller lockfiler:

| Kontrol | Resultat |
| --- | --- |
| Root-tests, serielt | 2.417 bestået, 0 fejl, 363 filer og 14.624 assertions efter dependency-, lint- og fresh-volume-containeropdateringen |
| Strikt runtime-typecheck | Bestået for `src/` og `scripts/` |
| Root-tests, `--parallel=16 --timeout=20000` | 2.417 bestået, 0 fejl, 363 filer og 14.624 assertions på 38,09 sekunder |
| Cockpit-tests, `--parallel=16 --timeout=20000` | 464 bestået, 0 fejl, 54 filer og 1.118 assertions på 1,87 sekunder |
| Cockpit produktionsbuild | Bestået |
| Frozen workspace-install | Accepteret |
| Lokal container: opret, readiness, persisted restart, non-root | Bestået |
| To rene OCI-exports med identiske input | Identisk OCI-manifestdigest og identisk OCI-arkiv-SHA-256 |

`container:reproducibility` bruger en digest-pinnet BuildKit, to builds uden
cache, fast `SOURCE_DATE_EPOCH` og OCI-exporterens `rewrite-timestamp=true`.
Den sammenligner både OCI-manifestdigest og hele OCI-arkivets SHA-256.
`container:test` bygger det faktiske Dockerfile og starter imagets faktiske
defaultkommando som uid 1000 på en helt tom volume. Den kræver grøn
`/api/ready` gennem en dynamisk port publiceret på værtens loopback, opretter
første selskab gennem HTTP-API'et og genstarter på samme volume. Den kontrollerer
samtidig, at selskabet og de migrerede data stadig er tilgængelige. Begge er
merge- og release-candidate-gates. Der er fortsat ikke pushed et image.

Den tidligere femsekunders-timeout under parallel belastning er lukket ved at
give hver test en eksplicit 20-sekunders grænse. Det ændrer ikke assertions eller
genforsøger fejl. Med 16 workers bestod den komplette suite på 38,09 sekunder.
`bun run verify:local` bruger `--parallel` uden et fast antal og udnytter derfor
automatisk alle kerner på den maskine, som udfører releasekontrollen.

Bun 1.4's aktuelle SQLite-kontrakt kræver `db.transaction(fn).immediate()` og
et samlet bindings-array til dynamiske `db.run`-kald. Koden er migreret til den
første form og bruger en lille, typed `runSql`-adapter til den anden. En særskilt
`bun run typecheck:runtime`-gate kører TypeScript strict over produktionskoden;
den er både en merge-gate og en pre-release-gate.

En søgning efter relevante Bun 1.4-adfærdsændringer fandt ingen produktionsbrug
af blandt andet body-cloning efter read, `bodyUsed`-antagelser, recursive
`fs.rmdir`, `Temporal`, interpolerede shell-globs eller Bun-cron. Den beståede
fulde suite dækker desuden de omfattende `Bun.$`, `Bun.spawn`, fetch,
`Bun.serve` og SQLite-flader.

## Funktioner vi bør udnytte

### 1. Runtime-, HTTP- og TLS-forbedringer

Bun 1.4 forbedrer server, fetch, streams, backpressure, TLS-kontrol,
forbindelsesgenbrug, memory behavior og Node-kompatibilitet. Rentemester får
disse forbedringer direkte på cockpit-serveren, DigiSense-kaldene, CVR/VIES,
IMAP-relaterede flows og remote-provider-kald uden et API-skifte.

Det er hovedargumentet for selve runtime-opgraderingen. Eksperimentel HTTP/3
skal ikke aktiveres som del af ændringen.

### 2. Parallel lokal test

`bun test --parallel` er nu den autoritative lokale releasegate. Bun fordeler
isolerede testfiler over alle CPU-kerner, mens `--timeout=20000` giver de tunge
CLI- og concurrency-filer realistisk headroom uden retries. Root og cockpit har
hver sin parallelle kommando, og `bun run verify:local` samler dem med build,
smoke, audit, licenser og containerkontroller.

GitHub gentager bevidst ikke de tusindvis af tests. Almindelig push-CI udfører
hurtig typecheck/lint/supply-chain, cockpit-build og den lille Windows-specifikke
filsystemskontrol. Den krævede smoke-kontekst bygger og verificerer Docker-
imaget. Kandidatworkflowet bygger, starter, reproducerbarhedsverificerer,
attesterer og publicerer den præcise commit.

### 3. `bun audit` og package-governance

`bun audit` auditerer i Bun 1.4 hele den låste workspace-graf. Den godkendte,
reviewede opdatering af `@hono/node-server`, `body-parser`, `fast-uri`, `hono`,
`ip-address` og React Router 7.18.2 har fjernet alle fund; den afsluttende
`bun audit --audit-level=low` returnerer ingen advisories.

Audit kører read-only og blocking i CI. `bun audit fix` kører aldrig
automatisk: dependency- og lockfileændringer skal fortsat ske i en reviewet
ændring med fulde tests. Den dependency-frie `supply-chain:licenses`-gate
kører `bun pm licenses --prod --json` fail-closed mod en eksplicit allowlist
og har verificeret 121 produktionspakker under MIT, Apache-2.0, BSD-2-Clause,
BSD-3-Clause eller ISC. Release-candidate-flowet genererer desuden
deterministisk audit-/licensevidens bundet til SHA-256 af den eksakte
`bun.lock`; promotion verificerer evidenshashen mod release-manifestet.

### 4. `Bun.XML` til indgående OIOUBL

DigiSense-inbound udtrækker i dag udvalgte UBL-felter med regulære udtryk og
er eksplicit ikke en fuld XML-parser. `Bun.XML.parse` kan give en klar
forbedring:

- malformed XML afvises fail-closed;
- interne entities har ekspansionsgrænser;
- eksterne DTD'er/entities hentes ikke, så der åbnes ikke en klassisk XXE-
  flade;
- namespaces og gentagne elementer kan behandles struktureret;
- originale XML-bytes kan fortsat bevares og hashes uændret.

Parseren er ikke en XSD- eller Schematron-validator og opløser ikke namespaces
semantisk. Den må derfor kun erstatte metadataudtrækket. DigiSense-
valideringen og de eksisterende bogførings-/transportgates skal bevares.

En migration kræver syntetiske tests for Invoice og CreditNote,
namespace-varianter, gentagne elementer, malformed XML, DTD/entity-angreb,
ufuldstændige dokumenter og identisk udtræk fra det eksisterende acceptkorpus.

### 5. Profilering og lette servermetrics

Bun 1.4 kan producere CPU- og heap-profiler som Markdown og har servercounters
for aktive requests. Det egner sig til en dokumenteret diagnosticeringsvej og
kan supplere eksisterende health/readiness og strukturerede logs.

Profiler må ikke aktiveres permanent eller gemmes ukontrolleret i produktion,
da de kan indeholde drifts- eller datarelateret kontekst. De bør være en
eksplicit, tidsbegrænset operatørhandling.

### 6. Password og CSRF i auth-løsningen

`Bun.password` leverer asynkron Argon2id med automatisk salt og et portabelt
PHC-format. `Bun.CSRF` kan levere tidsbegrænsede HMAC-tokens, når de bindes til
den konkrete session og en stabil delt secret.

De er kryptografiske primitiver, ikke en fuld autentifikationsløsning. Hosted
Rentemester bruger nu Better Auth til credentials, sessioner, MFA/TOTP og
recovery, mens Rentemester ejer medlemskab/RBAC og workspace-audit. Bun-
primitiverne skal derfor ikke indføres som en parallel auth-vej.

### 7. Cron som udskiftelig scheduler-adapter

Den eksisterende recurring-invoice-runner har allerede den rigtige grænse: den
ejer ikke ur eller credentials, bruger en eksplicit `asOfDate`, kan catch-up,
begrænser arbejdet pr. kørsel og beskytter mod dobbeltsend.

`Bun.cron` kan eventuelt kalde denne runner i en lokal eller enkel installation,
men må ikke blive sandhedskilden for forfald:

- in-process cron overlever ikke processtop;
- OS-cron ændrer privat driftskonfiguration;
- tidszonen default'er til værtsmaskinens lokale zone;
- en mistet kørsel skal stadig indhentes fra databasehistorikken.

Hvis adapteren tilføjes, skal tidszonen være eksplicit, og produktion skal
fortsat kunne bruge en ekstern scheduler uden produktkodeændring.

## Funktioner vi ikke bør migrere til nu

- **Bun.Archive:** Rentemesters egen USTAR-kode garanterer byteidentiske,
  signerbare backups. Den må kun erstattes efter dokumenteret byte-, mode-,
  traversal-, restore- og cross-platform-paritet.
- **Buns mappe-servering:** den nuværende static-server har SPA-fallback,
  traversal-kontrol, content types og build-status. `Bun.file` bruges allerede
  og får runtimeforbedringerne automatisk.
- **React Compiler:** Buns native bundler er nu i brug, men en compiler-plugin
  er et andet valg og tilføjes ikke uden et konkret behov.
- **Bun.secrets:** API'et er eksperimentelt og primært til lokale desktop-/CLI-
  miljøer. Det er ikke en produktions-secret-store til en headless container.
- **Bun.sql som ledger-erstatning:** den synkrone `bun:sqlite`-model passer til
  den eksisterende transaktions- og append-only-kontrakt. Et skifte har ingen
  aktuel gevinst.
- **S3, WebView, Image, FFI, HTTP/3, QUIC og post-quantum crypto:** ingen af dem
  løser et aktuelt produktkrav, og eksperimentelle protokoller skal ikke ind i
  compliance-imaget uden en særskilt begrundelse.

## Versionerede GHCR-images og Digisense-compliance

Den ønskede distributionsmodel findes allerede:

```text
SemVer + main-commit
        |
        v
unik candidate-tag -> OCI digest -> tests/smoke/provenance
                                |
                                v
                     Digisense tester digest
                                |
                                v
                digest-bundet approval-JSON
                                |
                                v
                   promotion uden rebuild
                                |
                                v
              GHCR vX.Y.Z + GitHub Release
```

Release-manifestet binder allerede:

- produktversion;
- fuldt Git-commit;
- reproducerbar buildtid;
- OCI repository og digest;
- linux/amd64-platform;
- GitHub workflow-run og attempt;
- schemaidentitet;
- regel- og kildeidentitet.

Approval-schemaet kræver, at Digisenses `releaseManifestDigest`, `imageDigest`,
`version` og `gitCommit` matcher kandidaten præcist. Promotion-workflowet
verificerer artefaktets checksum og GitHub build-provenance og sætter derefter
versionstagget på samme digest uden rebuild. Det er den rigtige compliance-
grænse: reviewet gælder bestemte bytes, ikke en gren eller et flytbart tag.

### Det der stadig mangler for en fuldt praktisk distribution

1. **Bun 1.4 er implementeret, men skal udgives som en ny SemVer-release.** En
   runtimeændring ændrer containerens bytes og kræver en ny DigiSense-reviewet
   digest; den må ikke skjules under en eksisterende version.
2. **GHCR package visibility skal besluttes.** Workflows kan publicere imaget,
   men om anonyme brugere kan `docker pull` styres i GitHubs package settings.
   Hvis Rentemester skal kunne downloades uden GitHub-login, skal pakken gøres
   public som en eksplicit ekstern handling.
3. **SBOM følger kandidaten som OCI-attestation.** BuildKit publicerer en
   SPDX-SBOM bundet til kandidatens immutable digest; promotion tagger samme
   digest uden rebuild og bevarer dermed SBOM-scope.
4. **Audit-/licensevidens følger kandidaten.** Evidensen binder den eksakte
   lockfile-hash, Bun-version, tomt blocking auditresultat og den verificerede
   produktionslicensrapport til release-manifestet. Scanningen er read-only,
   fail-closed og reproducerbar.
5. **Runtime-identitet er menneskeligt synlig.** Release-manifest og health
   viser Bun-version og pinned base-image-digest eksplicit; candidate-smoken
   afviser uoverensstemmelse.
6. **Compliance-scope skal følge hver approval.** DigiSense-godkendelsen bør
   klart betyde review af den navngivne containerdigest og den aftalte
   integrations-/sikkerhedsflade, ikke en generel godkendelse af fremtidige
   versioner eller af virksomhedens private drift.

## Foreslået leverancerækkefølge

### Leverance A — Bun 1.4 runtime (implementeret; release afventer)

- Bun 1.4.0, `@types/bun`, Docker og relevante workflows er pinned;
- root og cockpit bruger ét workspace, én frozen installation og én lockfile;
- den verificerede `oven/bun:1.4.0-slim`-digest er pinned;
- parallel root- og cockpit-test, smoke, backup/restore og release-provenance
  er lokale gates; GitHub ejer image-build, readiness og attestering;
- behold linux/amd64, medmindre en særskilt multi-arch-beslutning træffes.

### Leverance B — dependency- og CI-sikkerhed

- de fundne advisories er rettet i reviewede dependency-opdateringer;
- blocking `bun audit` kører for hele workspacet;
- licensallowlist er blocking i almindelig CI og release-candidate-flowet;
- audit- og licensrapporten er lockfile-bundet release-evidens;
- behold den fulde parallelle testgate lokal og GitHub-gaten image-fokuseret;
- SBOM-attestation er digest-bundet.

### Leverance C — Bun 1.4-produktgevinster

- migrér DigiSense inbound metadataudtræk til `Bun.XML`;
- tilføj dokumenteret, tidsbegrænset profilering;
- vurder Bun password/CSRF i auth-implementeringen;
- tilføj kun en cron-adapter, hvis den bevarer den nuværende scheduler-grænse.

### Leverance D — review og promotion

- vælg næste SemVer efter `docs/versioning.md` og opdatér changelog;
- byg én unik GHCR-kandidat fra præcis `main`-commit;
- giv Digisense kandidatens release-manifest og immutable digest;
- indhent digest-bundet approval;
- promotér de samme bytes til `vX.Y.Z` og GitHub Release;
- deploy fortsat med digest fra det godkendte manifest.

## Kilder

- [Bun 1.4 release notes](https://bun.com/blog/bun-v1.4)
- [Bun XML](https://bun.com/docs/runtime/xml)
- [Bun parallel tests](https://bun.com/docs/test/parallel)
- [Bun audit](https://bun.com/docs/pm/cli/audit)
- [Bun password hashing](https://bun.com/docs/runtime/hashing)
- [Bun CSRF](https://bun.com/docs/runtime/csrf)
- [Bun cron](https://bun.com/docs/runtime/cron)
- [Bun secrets](https://bun.com/docs/runtime/secrets)
- [Bun Archive](https://bun.com/docs/runtime/archive)
