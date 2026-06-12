# Komplet audit af Rentemester

**Dato:** 2026-06-11 · **Commit:** `49c0d5f` (main) · **Karakter:** ekstern audit + efterfølgende fix-runde

Denne rapport samler en fuld gennemgang af Rentemester på tre spor — **det juridiske**, **det kodemæssige** og **brugergrænsefladen** — udført af seks uafhængige auditorer (juridisk/regulatorisk, ledger-kerne, server/MCP/sikkerhed, frontend-kode, virksomhedsejer-UX, agent-interface).

Hvert fund har et ID (JUR-/KODE-/SEC-/UI-/EJER-/AGENT-n), en alvorlighed og fil/kommando-referencer. Fund er verificeret ved kodelæsning og — hvor muligt — empirisk reproduceret mod kørende kode.

> **Status-opdatering (2026-06-12, Bølge 1).** Alle KRITISK- og HØJ-fund er nu rettet, gennemgået med dobbelt review (code review + adversarialt) og gate-bestået (`bun test` 1700+/0, app-vitest 401/0, `bun run smoke` OK). Reviewet afdækkede fire opfølgningshuller, som også er lukket i samme runde: SEC-1-bypass på workspace-ruterne, en 1-øres rubrik-fejlfordeling i momsfilingen (VAT-1), en uafdækket actor-gating (`company set-profile`, AGENT-3) og crash-sikkerhed i kunde-migreringen (EJER-3-MIG). Status pr. fund er markeret med **✅ RETTET (Bølge 1)** nedenfor. MIDDEL- og LAV-fund behandles i Bølge 2/3. Ét fund er bevidst **udskudt**: JUR-2/KODE-2 (indenlandsk reverse-charge i rubrik B) afventer ejer-/revisorbeslutning om datamigrering.
>
> **Status-opdatering (2026-06-12, Bølge 2+3).** Alle resterende MIDDEL- og LAV-fund er nu rettet i seks parallelle agent-bølger (moms/skat, morarente, ledger-samtidighed, sikkerhed/infra, frontend, compliance-features + CLI/UX/sprog), efterfulgt af et nyt dobbelt-review. Reviewet fandt fire opfølgningsfund, som også er lukket: JUR-7-rente segmenteres nu pr. halvårs-satsskifte (krydsede tidligere ét satsskifte med én sats), KODE-6's primo-idempotens er strammet (false-positive), JUR-9-UBL har nu `TaxExemptionReason` for E/AE (EN16931 BR-AE-10/BR-E-10), og JUR-4's agent-rådgivning er gjort år-bevidst. Gate-bestået: `bun test` 1797/0, app-vitest 416/0, `bun run smoke` OK. Mange MIDDEL/LAV-guards er bevidst **warning-only** (delvis fradragsret, EU-varekøb, momsfrist-kadence, kørselssats-loft) for at respektere determinisme/human-in-the-loop. **To kendte opfølgningspunkter** kræver en bevidst beslutning frem for blind kodeændring: (1) JUR-2/KODE-2 (rubrik B, datamigrering — uændret udskudt), og (2) morarente-korrektion (`proposeInterestCorrection`) rekonstruerer en posteret claim med dens ene gemte sats — efter JUR-7 kan en tabel-baseret claim der spænder over flere halvår have brugt flere satser, så korrektionen kan afvige for usædvanligt lange enkelt-claims (edge-case; flaget, ikke ændret).

---

## Sammenfatning (ledelsesresumé)

Fundamentet er solidt: append-only ledger med hash-kæde, øre-eksakt BigInt-pengelag, disciplineret human-in-the-loop, ærlig adskillelse af "leveret" og "roadmap", og blandt de mest selvbeskrivende MCP-overflader man kan finde. Men systemet er **ikke klar til at føre en rigtig virksomheds regnskab endnu**, og tre forhold blokerer tillid mere end resten:

1. **Momsangivelsen dobbelttæller reverse-charge-moms** (JUR-1 / KODE-1) — virksomheden betaler ~25 % af alle EU-ydelseskøb for meget i moms, og en eksisterende test cementerer fejlen.
2. **Systemets standardvisning overser forfaldne fakturaer** (EJER-1) — cockpit, portefølje og CLI giver tre forskellige svar på "har jeg forfaldne fakturaer?", og defaulten siger fejlagtigt "Sund drift".
3. **`gdpr forget` — systemets eneste reelle datasletning — kører uden actor, uden confirm, under overskriften "read-only, ingen sideeffekter"** (AGENT-1 / SEC relateret), mens al dokumentation hævder det modsatte.

Dertil et knippe konsistens-/sandhedsproblemer i UI (forkert årsrapportfrist, "sendt" om noget der ikke blev sendt, betalingsfrist der ændrer sig i det skjulte) og et lag af samtidigheds-/robusthedsproblemer i kernen, der bør lukkes inden flere skriveklienter får adgang til samme database.

### Tælling efter alvorlighed

| Spor | Kritisk | Høj | Middel | Lav |
| --- | --- | --- | --- | --- |
| Juridisk (JUR) | 1 | 2 | 7 | 5 |
| Ledger-kerne (KODE) | 1 | 2 | 7 | 4 |
| Sikkerhed (SEC) | 0 | 1 | 5 | 8 |
| Frontend (UI) | 0 | 2 | 7 | 11 |
| Ejer-UX (EJER) | 1 | 4 | 11 | 4 |
| Agent-interface (AGENT) | 1 | 4 | 7 | 5 |

### Testtilstand
- **Backend:** `bun test` → 1639 pass / **1 fail** (`vat_eu_sales_list` MCP-test). Fejlen er **flaky test-isolation**: testen passerer isoleret (3 pass), men fejler i fuld suite (`structuredContent` blev `undefined`). Bør stabiliseres — ellers maskerer den reelle regressioner. Se TEST-1.
- **Frontend:** `bun run test` (vitest) → **398/398 pass**. Men `bun test` (Buns egen runner) fra `app/` fejler 381/398 pga. forkert runner — fælde for agenter/CI (UI-14).

---

## De tre øverste prioriteter (gør disse først)

| # | Fund | Hvorfor | Indsats |
| --- | --- | --- | --- |
| 1 | **JUR-1 / KODE-1** Reverse-charge-moms dobbelttælles | Direkte momsoverbetaling ved hver periode med EU-ydelseskøb; test låser fejlen fast | Lille kodefix i filing-laget + ret test |
| 2 | **EJER-1** Forfaldne fakturaer overses i defaultvisning | Kernefunktion fejler; tre flader uenige; "Sund drift" er usand | Ret "i dag"-datologik i overdue + propagér til alle flader |
| 3 | **AGENT-1** `gdpr forget` uden actor/confirm, fejlmærket read-only | Datadestruktion uden governance; modsiger al dokumentation | Tilføj til `MUTATING_COMMANDS`, ret hjælpe-gruppe, regressionstest |

---

# Spor 1 — Juridisk / regulatorisk

> Krydstjek af `rules/dk/*.yaml` mod implementeringen i `src/core/`, 2026-satser verificeret mod offentlige kilder.

## Kritisk

### JUR-1 · Momsangivelsen dobbelttæller omvendt betalingspligt-moms
**Filer:** `src/core/vat-filing.ts:136-153`, `src/core/vat.ts:162,318`; test der låser fejlen: `tests/unit/vat-filing.test.ts:101-141`
`postEuServiceReverseChargePurchase` krediterer reverse-charge-udgående moms på konto 1200, og `buildVatReport.outputVat` (kontobaseret) tæller den med i `salgsmoms`. Derefter beregner `buildVatFiling` `momsAfYdelseskobUdland = 25 % af basen` **igen** og summerer begge i `momstilsvar`. For et rent EU-ydelseskøb (netto 1.000) giver systemet `momstilsvar = 250`; det lovlige tilsvar er **0** (udgående og indgående moms udligner hinanden, momsloven § 46 jf. § 37). Det underliggende `netVatPayable` (`vat.ts:378`) er korrekt — fejlen er isoleret til filing-laget.
**Handling:** Træk reverse-charge-output ud af salgsmoms-feltet, ret testforventningerne, tilføj regressionstest for tilsvar = 0. Krydstjek `momstilsvar` mod `netVatPayable` som invariant.

## Høj

### JUR-2 · Indenlandsk omvendt betalingspligt-salg havner i rubrik B (EU-salg)
**Filer:** `src/core/invoice-booking.ts:21-27`, `credit-notes.ts:132`, `vat.ts:323`, `vat-filing.ts:158`
`domestic_reverse_charge` og `foreign_reverse_charge` deler vat-kode `REVERSE_CHARGE_EXEMPT` → begge mapper til rubrik B. Indenlandske § 46-salg (mobiler/metalskrot) skal i rubrik C, ikke B, og må ikke i EU-salgslisten. SKAT krydstjekker rubrik B mod VIES — differencen udløser kontrol. (Formildende: VIES-listen filtrerer korrekt på `foreign_reverse_charge` og forurenes ikke.) Kendt åbent issue, nu bekræftet.
**Handling:** Separat vat-kode for indenlandsk omvendt betalingspligt (kræver datamigrering — revisorbeslutning), eller blokér stien indtil afklaret.

### JUR-3 · Skattemæssig regulering for repræsentation er forkert
**Fil:** `src/core/tax-return.ts:182-203`
Systemet tilbagefører kun ikke-fradragsberettiget repræsentationsmoms (~18,75 % af basen), men ligningsloven § 8, stk. 4 giver kun **25 % fradrag** — der skal tilbageføres 75 % af hele udgiften (~89 % af basen). Skattepligtig indkomst og selskabsskat beregnes for lavt for enhver virksomhed med repræsentation.
**Handling:** Ret til 75 % af (base + ikke-fradragsberettiget moms), eller degradér til needs-review.

## Middel
- **JUR-4** Straksafskrivningsgrænse er 2024-sats (`assets.ts:41` = 33.100); 2026 er **36.000 kr.** Konservativ effekt (afviser i stedet for at fejlbogføre), men skaber unødige eskalationer. Gør årstalsbaseret.
- **JUR-5** EU-varekøb (erhvervelsesmoms, momsloven § 11) er hardcodet 0 (`vat-filing.ts:145`) og har ingen vat-kode → kan kun fejlbogføres. Rubrik A/B mangler varer/ydelser-split. Tilføj guard/hard-stop.
- **JUR-6** Delvis fradragsret (§§ 37-38) håndteres ikke; alle købskoder antager 100 % fradrag, selvom momsfri omsætning understøttes. Mindst en warning når `exemptSalesBase > 0` + fuldt fradrag i samme periode.
- **JUR-7** Morarente-referencesats er ren brugerinput uden satstabel/validering; fast 365-dages divisor (skudårsfejl). Indbyg kildebelagt halvårstabel + sanity-bound. (Se også EJER-8.)
- **JUR-8** GDPR-indsigtseksport (`gdpr.ts`) mangler `journal_entries.text`/`journal_lines.text`/`audit_log.message` — felter med persondata, som hash-kæden også gør usletbare efter retention-udløb. Medtag i eksport + design overlay-redaktion (tombstone).
- **JUR-9** Peppol BIS 3.0-handoff (`public-einvoice.ts:224-289`) mangler obligatorisk `BuyerReference`/`OrderReference` (PEPPOL-EN16931-R003) → afvises af accesspoint; hardcodet TaxCategory "S", unitCode H87, unormaliseret 0184-EndpointID. Tilføj buyerReference + schematron-validering i test.
- **JUR-10** Årsrapport/iXBRL mangler sammenligningstal (ÅRL § 24), medarbejdernote, og bruger lokalt namespace (ikke Erhvervsstyrelsens taksonomi → kan ikke indberettes digitalt); § 138-frist overvåges ikke. (Dokumenteret begrænsning; se EJER-2 for forkert frist.)

## Lav
- **JUR-11** `REGULATORY_COVERAGE.md` er forældet (genereret 21/5, regler ændret 9/6). Kør `reg coverage` igen; overvej CI-gate mod drift.
- **JUR-12** Momsfrist forskyder ikke til bankdag og understøtter kun kvartal (bør hard-fejle ved anden afregningsperiode).
- **JUR-13** Kørselsgodtgørelse har ingen 2026-satser og ingen loft-validering (3,94/2,28 kr./km; 20.000 km-tærskel). Bevidst human-in-the-loop, men tilbyd warning-only satstabel.
- **JUR-14** Acontoskat (20/3, 20/11) surfaces ikke som frist.
- **JUR-15** Offentlige købere uden CVR i payload afvises for kompensationsbeløb, selvom renteloven § 9a omfatter dem. Acceptér EAN som alternativt bevis.

## Materialitetsvurdering af regulatorisk dækning (57/498 in-scope)
Reel risiko: § 11 erhvervelsesmoms (ingen bogføringsvej), §§ 37-38 delvis fradrag (ingen guard), § 34 EU-varesalg (uunderstøttet). Lav/dækket: bogføringslovens systemkrav (korrekt valgt ikke-registreret-spor), B2C-morarente (samme motor), de 22 uciterede regler (bevidste workflow-guardrails). Dækningsmetrikken er ærligt deklareret som selv-attestation.

## Solidt (juridisk)
Balancerede posteringer + append-only hash-kæde; 5-års opbevaring korrekt beregnet uden auto-sletning; backup-regime forbilledligt mod bek. 2024-205 (menneskeligt attesteret destination, Ed25519); morarente-motoren (efter fix) inkrementel/dato-bevidst med korrektionsflow; § 58-fuldfaktura + § 66 forenklet faktura (3.000 kr.); bad-debt-relief (80 %, § 27 stk. 6); rykkergebyr (100 kr., max 3) og kompensationsbeløb (310 kr.) korrekte for 2026.

---

# Spor 2 — Kode: ledger-kerne

> Korrekthedsaudit af `src/core/`. KODE-1 og KODE-3 er empirisk reproduceret.

## Kritisk

### KODE-1 · Momstilsvar overdrives med 25 % af alle EU-ydelseskøb
Samme defekt som JUR-1, set fra koden. Empirisk: `netVatPayable = 0` (korrekt) men `buildVatFiling.momstilsvar = 250` for et 1.000-kr. EU-ydelseskøb. `vat-filing.test.ts:101-141` asserterer det forkerte tal. **Højeste prioritet før første rigtige momsangivelse.**

## Høj

### KODE-2 · Indenlandsk reverse-charge i rubrik B
Samme som JUR-2, kodeverificeret. EU-salgslisten forurenes ikke (filtrerer på `foreign_reverse_charge`).

### KODE-3 · Delvis kreditnota med skæve øre kan ikke bogføres
**Fil:** `src/core/credit-notes.ts:121-124,248`
Hver linje skaleres og afrundes uafhængigt → sum af afrundede linjer ≠ afrunding af sum → `postJournalEntry` afviser hele kreditnotaen. Empirisk: faktura 125,06, delkreditnota 62,53 → `debit 62.54 != credit 62.53`. Dokument/sekvens rulles korrekt tilbage (ingen korruption), men en helt almindelig delkreditering er umulig. `credit-note.test.ts:218` tester kun runde beløb.
**Handling:** Læg afrundingsrest på én linje (som `computeAccrualSchedule` gør).

## Middel — samtidighed og robusthed
- **KODE-4** TOCTOU: `validateJournalEntry` (periodelås m.m.) kører **uden for** skrivetransaktionen (`ledger.ts:436-445`). Med flere processer kan en post committes i en netop lukket periode. Flyt validering ind under BEGIN IMMEDIATE.
- **KODE-5** Multi-proces race i morarente-/gebyr-registrering kan fakturere overlappende rentevinduer (`invoice-interest.ts:298-306`, dokumenteret i koden). Wrap calculate+insert i immediate-transaktion.
- **KODE-6** Primobalance ikke atomisk: journalpost og idempotens-markør committes hver for sig (`opening-balance.ts:146-182`) → crash imellem kan fordoble alle åbningssaldi. Indsæt markør i samme transaktion.
- **KODE-7** "Atomiske" filskrivninger mangler `fsync` (`atomic-file.ts:19-56`) → strømsvigt kan efterlade tomt manifest/signatur/tar. Backup ubrugelig netop når den behøves.
- **KODE-8** Restore `rmSync(target, {recursive})` på mappe uden ledger-db (`system-restore.ts:213-216,487-492`) → sletter rekursivt indhold; TOCTOU-vindue. Nægt at slette ikke-tom mappe; gentag live-check før rmSync.
- **KODE-9** "Reported"-perioder kan effektivt genåbnes via rå `audit_log`-insert (`periods.ts:264-286`): `effectivePeriodState` replayer et `period_reopen`-event efter `period_report`. Behandl `reported` som terminal i replay.
- **KODE-10** Flertal af skriveveje bruger deferred transactions → `SQLITE_BUSY_SNAPSHOT` under samtidighed (fejler, ingen korruption). Standardisér på `{immediate:true}`.

## Lav
- **KODE-11** "I dag" i UTC, ikke dansk tid (`dates.ts:13-17`) → mellem midnat og 01/02 er "i dag" gårsdagen. (Grundårsag til EJER-1's symptom.)
- **KODE-12** Sekvens-floor via GLOB antager fast cifferbredde → falsk "entries missing" over 99.999 posteringer/år; komment-rot i `issued-invoices.ts:123-127`.
- **KODE-13** Generisk CSV-import kun UTF-8, ingen multi-linje citerede felter (`bank.ts:762`). Fejler højt (ingen korruption).
- **KODE-14** `audit_log` er append-only men ikke manipulationsevident (ingen hash-kæde, modsat journalen). Defence-in-depth; samvirker med KODE-9.

## Solidt (kerne)
`money.ts` eksemplarisk (BigInt, half-up via streng, én-gangs renteafrunding); ingen UPDATE/DELETE på journal/postings; udtømmende triggers gen-etableres ved hver migrate; hash-kæde binder row-id + linjeorden; `verifyAuditChain` dækker kæde/balance/FK/orphans/dokument-evidens/tail-truncation; FX-realiseret gevinst/tab (telescoping til præcis nul); backup/restore staged+valideret før atomisk swap; periodisering øre-eksakt med årsskifte-klampning.

---

# Spor 2 — Kode: server, MCP, CLI, sikkerhed

> Kontekst: byggefase, ingen produktionsdata, lokal single-user — alvorlighed kalibreret derefter.

## Høj

### SEC-1 · CSRF / DNS-rebinding mod localhost-skrive-API
**Filer:** `server/mutations.ts:80,120`, `server/auth.ts:44`
Phase 1 er "localhost-trusted": auth slået fra, eneste skrive-gate er at `Host` er loopback — men browseren sætter selv den header. Ingen Origin-tjek, ingen CSRF-token, og `readMutationBody` validerer ikke Content-Type → et ondsindet website kan sende "simple request" (text/plain + JSON) uden preflight og bogføre med `confirm:true` sat af angriberen.
**Handling:** Validér `Origin`/`Sec-Fetch-Site` på writes og/eller kræv `Content-Type: application/json`. Overvej at fremrykke Phase 2-auth.

## Middel
- **SEC-2** Aktør-allowlist håndhæves **kun** i CLI, ikke i MCP eller HTTP (`cli-actor.ts:199` vs. `tool-runtime.ts`, `mutations.ts`). Agent over MCP kan udføre enhver bekræftet write uanset allowlist. Flyt gaten til et delt lag.
- **SEC-3** Tom/manglende `policy.yaml` → `enforceMutationActorPolicy` returnerer tidligt = enhver aktør (inkl. `user:`) accepteres (`cli-actor.ts:261-267`). Agent kan udgive sig for menneske. Fail-closed.
- **SEC-5** Ingen timeout på eksterne fetch (CVR/VIES/EAN/SMTP) → hængende remote blokerer agent-kørsel/HTTP-request uendeligt. Tilføj `AbortSignal.timeout`.
- **SEC-6** CVR sender Basic-auth over cleartext **HTTP** (`cvr.ts:18`) → credentials aflyttelige. Default til HTTPS.

## Lav
- **SEC-4** MCP-aktøridentitet fuldt klientstyret (handshake-navn kan spoofes). Dokumentér som rådgivende, ikke sikkerhedshegn.
- **SEC-7** Docker kører som root (ingen `USER`). Hærd.
- **SEC-8** Prompt-injection-flade: rå afsender/emne/filnavn fra mail flyder ind i exception-tekster en agent handler på. Markér som untrusted.
- **SEC-9** Ingen afsendervalidering på mail-intake (spam/forgiftning af kø). Allowlist/kvote.
- **SEC-10** IMAP-literal uden størrelsescap + rekursiv MIME uden dybde-grænse. Cap begge.
- **SEC-11** chmod-vindue + tavst svigt på `imap.json` (`bilagsmail.ts:64-70`): skrives 0644 først, chmod 0600 i fejl-slugende try/catch. Skriv atomisk med `{mode:0o600}`.
- **SEC-12** `.gitignore` dækker kun `.env` → `imap.json`, `*.key`, `*.pem`, `policy.yaml` kan committes hvis workspace ligger i repo-træet. Tilføj mønstre.
- **SEC-13** Ingen auth-default + ingen rate limiting (bevidst Phase 1). Dokumentér single-user-antagelsen.
- **SEC-14** Agent-loop bogfører autonomt uden per-postering-bekræftelse for eksakt-match. `confirm:true` beviser ikke menneske. Overvej beløbsgrænse.

## Solidt (sikkerhed)
Prepared statements konsekvent (ingen injection-flade fundet); fejl-redaction ved kanten (generisk "intern serverfejl", path-redaction i MCP); path traversal afværget (`resolveSafe`, `basename`, `..`-afvisning); confirm-gating stram på CLI+MCP+HTTP; hemmeligheder aldrig i ledger; meget slank dependency-graf (kun `@modelcontextprotocol/sdk` + `zod`); upload-DoS-værn (maxBodyBytes, 25 MB mail-cap); localhost-default bind.

---

# Spor 3 — Brugergrænseflade: frontend-kode

> React-cockpit i `app/` (~35 views) + Astro-site i `www/`. `bun run test` grøn (398/398).

## Høj
- **UI-1** `.modal-backdrop` er aldrig defineret i CSS → 6 modaler (Luk/Genåbn periode, Registrér/Afskriv anlæg, Bankkonto, Kørsel) renderes uden overlay, ucentreret, baggrund interaktiv trods `aria-modal`. Omdøb til `.modal-overlay`.
- **UI-2** "Send som e-faktura"-dialog lover "Sendes nu", men serveren kun **registrerer** (status `prepared`) — AS4-transport ikke wiret ind (`InvoicesView.tsx:206-244`, `write-handlers/invoice.ts:576-610`). Likviditetsrelevant misinformation. Omformulér til "Forbered/registrér". (Se EJER-2/EJER-11 for samme mønster.)

## Middel
- **UI-3** Dødt link `/docs/cvr-opsaetning` i cockpit (404) — eneste anviste vej til at fikse manglende CVR-login.
- **UI-4** CompanyNav threader hele querystrengen → Bank-filter (`q/from/to`) lækker til Posteringer og omvendt. Whitelist kun `year`.
- **UI-5** Inkonsistent dansk talinput: Budget accepterer komma, fakturamodal/kørsel bruger rå `Number()` → "1.234" tolkes som 1,234 kr. (1000×-fejl). Delt `parseDanishAmount`.
- **UI-6** PeriodsViews `ClosePeriodModal` mangler #301-værnet (fremtidsdato-acknowledgement) som VatView har. (Se EJER-6.)
- **UI-7** `docs/confirm-contract.md` stale ift. faktiske cockpit-mutationer ("Send rykker", "Genåbn periode" findes nu i cockpit men står N/A).
- **UI-8** Datoer vises som rå ISO i hele cockpittet — ingen `formatDateDa`, mens beløb er pinligt korrekt danske. Beslut/dokumentér. (Se EJER-19.)
- **UI-9** API-barrel afhænger af spread-rækkefølge for at skygge legacy-versioner uden `confirm` (`api.ts:84-112`). Skrøbeligt. Slet legacy-versionerne.

## Lav
- **UI-10** TastSelv-kopiformat duplikeret/divergent (`VatView` heltal vs. `ObligationsView` toFixed). Flyt til `lib/format.ts`.
- **UI-11** 4 chart-komponenter duplikerer identiske Intl-formattere der afviger fra #314-kontrakten.
- **UI-12** ConfirmDialog mangler fokus-fælde/-retur; flere modaler mangler Escape/autofokus.
- **UI-13** Tabel-a11y: næsten ingen `scope`/`<caption>`; sorterbare kolonner mangler `aria-sort`.
- **UI-14** `bun test` i `app/` rammer forkert runner → fejler 381/398 (`bun run test` er grøn). Fælde for CI/agent. Guard eller dokumentér.
- **UI-15** Google Fonts CDN i cockpit (`app/index.html:8-13`) — eksternt kald/IP-læk i et lokal-først, GDPR-profileret produkt. Self-host.
- **UI-16** Hardcodet rykkergebyr "100,00 kr" i UI-tekst (`InvoicesView.tsx:348,357`). Lad serveren levere beløbet.
- **UI-17** "Arkivér virksomhed" ét klik uden bekræftelse, navigerer straks væk. Tilføj ConfirmDialog/undo.
- **UI-18** Arkiveret Bank-view tilbyder afstemnings-statusfilter uden afstemningskolonne.
- **UI-19** Stale kommentarer ("the fourteen views" → 30 faner; HelpView-test hævder manglende `index.astro`).
- **UI-20** www: udeståender fra audit 2026-05-21 fortsat åbne (delt ArticleLayout, 8 tynde sider). Positivt: ingen døde interne links nu; compliance-claims fortsat disciplinerede.

## Solidt (frontend)
Beløbsformatering forbilledlig (kanonisk `formatKronerDa`, byte-identisk med server, testet); datahentning disciplineret (`useAsync` annullerer ved navigation, ingen optimistic updates — altid `reload()` mod server); confirm-gating matcher kontrakten; ensartet fejl-envelope; tests reelle (ikke smoke), låser issue-numre fast; a11y-grundlag (`lang="da"`, landmarks, `:focus-visible`); www-claims konservative.

---

# Spor 3 — Brugergrænseflade: virksomhedsejer (UX)

> Fuld måned kørt igennem som ikke-teknisk ApS-ejer.

## Kritisk
- **EJER-1** Forfaldne fakturaer overses af systemet selv. Cockpit viser "Ingen forfaldne fakturaer" og portefølje "Sund drift", mens faktura 2026-0001 forfaldt 09/6. `invoice overdue` uden flag = 0, men `--as-of 2026-06-11` (dags dato!) finder den. Tre flader, tre svar. **Grundårsag relateret til KODE-11 (UTC-"i dag").** Ret datologik + propagér til portefølje, Overblik, Fakturaer-fane, agentrapport.

## Høj
- **EJER-2** Forkert årsrapportfrist vist som autoritativ: "2027-05-01" for regnskabsår 2026. Klasse B-frist er 6 mdr. efter regnskabsårsudløb (slut juni 2027), aldrig 1. maj. Ingen kildehenvisning. Ret + vis lovhjemmel ("ÅRL § 138") som momsfristen gør. (Jf. JUR-10.)
- **EJER-3** Betalingsfrist ændrer sig i det skjulte: profil siger 14 dage, men kartotekskunde uden egen frist fik +30 dage uden besked. Koster likviditet. Lad kunder arve virksomhedens frist; varsl afvigelse.
- **EJER-4** "Løst" exception kan gemme ubogført indtægt — og periodelåsen cementerer fejlen. Note-løst indbetaling (2.500 kr.) forsvandt fra alle radarer; momsangivelse byggedes med 500 kr. for lidt salgsmoms; senere bogføring afvist (lukket periode). Skeln "løst ved bogføring" fra "noteret"; uafstemte bankposter bør blokere/advare ved `period close`.
- **EJER-5** `serve` leverer forældet cockpit (port 4319) — mangler Hjælp, Lovgrundlag, Undtagelser, Budget, Anlæg, Kørsel, Periodelås, Årsrapport, PDF/Send/Kreditér på fakturaer — vs. dev-udgaven (5319). Intet varsler det. Lad `serve` levere aktuel UI (genbyg `app/dist`) eller advar.

## Middel
- **EJER-6** Kan låse uafsluttet regnskabsår uden advarsel, derefter udstede faktura i lukket periode der aldrig kan bogføres. (Jf. UI-6.)
- **EJER-7** Bankmatch modsiger sig selv: `bank suggest-matches` siger "Ingen sikre forslag", exceptions-køen siger "passer til bilag DOC-... bogfør". Del match-motor eller forklar hvorfor.
- **EJER-8** Morarente kræver at ejeren selv kender Nationalbankens referencesats (påkrævet flag). Indbyg versioneret halvårssats. (Jf. JUR-7.)
- **EJER-9** Engelsk siver ind, især i fejl ("customer 1 does not exist", "falls in closed period"), profilvisning, og hele **Lovgrundlag**-siden (80 regler på engelsk — paradoksalt for dansk regelforankring).
- **EJER-10** Manglende æ/ø/å i officielle skabeloner: ledelsespåtegning ("arsrapporten", "regnskabsaaret", "indsaetter"), skatterapport ("skattemaessige"). Ender foran revisor/Erhvervsstyrelsen.
- **EJER-11** "Rykker sendt" — men intet blev sendt (SMTP i test-tilstand). Skriv "registreret" indtil faktisk afsendelse. (Jf. UI-2.)
- **EJER-12** "Faktisk banksaldo — intet kontoudtog importeret" er usand (kontoudtog ER importeret, manglede saldo-kolonne). Brug Bank-fanens præcise formulering.
- **EJER-13** Faktura-afstemning kræver "Bankreference" i fritekst uden liste over uafstemte indbetalinger. Vis kandidaterne.
- **EJER-14** Revisor-eksport er rå JSON-filer (revisor bruger Excel); README.txt-tidsstempel "2026-12-31T23:59:59" et halvt år ude i fremtiden. Læg CSV i pakken + ærligt tidsstempel.
- **EJER-15** Fakturaens egen PDF optræder som "ubehandlet bilag" → falsk dårlig samvittighed i tælleren. Skjul interne artefakter.
- **EJER-16** CVR-opslag kræver miljøvariabler + eget CVR-login uden vejledning.

## Lav
- **EJER-17** Succesbeskeder er kommandobeskrivelser, ikke bekræftelser ("✔ Indlæser og validerer et bilag" efter det ER indlæst).
- **EJER-18** Tom graf på Overblik (kan være renderingsmiljø — tjek).
- **EJER-19** Småjargon: "exceptions-kø" vs. "Undtagelser" (vælg ét), "OVERFORFALDNE", ISO-datoer hvor dansk forventer 10.05.2026.
- **EJER-20** Ærligt deklareret manglende: e-mail i test-tilstand, ingen bankfeed, PEPPOL kun forberedt, ingen løn, 12 % regulatorisk dækning.

## Det fungerer (ejer)
Moms er stærkest (klar dansk, 1:1 TastSelv-mapping, korrekt forklaret frist, PDF klar); exceptions-tekster forbilledlige (hvad/hvorfor/hvad-gør-jeg, auto-luk ved bogføring); værnene virker (debet=kredit, lukket periode blokerer, "Sådan kommer du videre"-blokke); faktura-flow guider; sporbarhed (audit verify, backup-/retention-status, compliance-rapport til revisor); bankimport tilgivende (danske kolonner, idempotent); det nye cockpit bredt/pænt/dansk.

**Samlet ejer-dom:** *Ikke endnu.* Fundamentet er rigtigt, men kan ikke betros et rigtigt regnskab så længe standardvisningen overser forfaldne fakturaer (EJER-1), viser forkert lovfrist (EJER-2) og lader ubogført indtægt forsvinde i lukket periode (EJER-4).

---

# Spor 3 (forlænget) — Agent-interface og kontrakter

> Review fra en autonom agent der kun bruger CLI + MCP. Adfærd verificeret empirisk.

## Kritisk
- **AGENT-1** `gdpr forget` er ikke actor-gated og fejlmærket read-only. Kørte igennem med renset actor-miljø (`ok:true`, exit 0), mens legacy-alias `gdpr erase` korrekt afvises — kun `"gdpr erase"` står i `MUTATING_COMMANDS` (`cli-actor.ts:77`). Hjælpen lister `gdpr forget` under "read-only — ingen sideeffekter"; sletning sker uden audit-attribution. Tilføj til `MUTATING_COMMANDS`, ret hjælpe-gruppe, regressionstest på alias=kanonisk governance.

## Høj
- **AGENT-2** `company sync-cvr` listet som read-only men muterer stamdata (uden actor); MCP-pendant er confirm-gated → CLI løsere end MCP, udokumenteret. Actor-gate eller dokumentér.
- **AGENT-3** `cli-contract.md` §4 (output-paritet) falsk for read-kommandoer: `journal list --json` = bart array, snake_case, ingen envelope; MCP = `{ok,data:{entries}}` camelCase. `accounts list` → `rows/account_no` vs. `accounts/accountNo`. En agent der bygger parser efter §4 fejler på første kald. Harmonisér eller omskriv §4.
- **AGENT-8** `invoice_settle_bank` ved ukendt `invoiceNumber` → "invoiceDocumentId must be a positive integer" (navngiver felt agenten ikke sendte). Lad nummer-opløsning fejle med "no issued invoice has invoice number …" først.
- **AGENT-10** `confirm-contract.md` refererer MCP-tool `gdpr_erase_contact` som **ikke findes** (ingen `gdpr_*` blandt 101 tools). Agent kalder ikke-eksisterende tool. Ret til N/A.

## Middel
- **AGENT-4** CLI write-output fladt (`{ok,entryId,...}`), MCP `data`-indpakket → genbrugt MCP-parser får `undefined`. Specificér i §4.
- **AGENT-5** Actor-politikkens omfang kun læsbart i kildekode; hjælpe-grupperne forkerte (AGENT-1/2). Generér gruppe fra `MUTATING_COMMANDS`.
- **AGENT-7** CLI/MCP-mapping komplet pr. fil, ikke pr. kommando → `company list`, `gdpr discover`, `system export-saft`, nøglerotation m.fl. usynlige for MCP-først-agent. Udvid til kommando-niveau.
- **AGENT-9** Slug-opløsningsfejl modsiger kontrakt: slug uden workspace → "company path does not exist" (nævner ikke slug/workspace/env-var). Separat fejltekst.
- **AGENT-11** Envelope-`code` kun en tredjedel dokumenteret: `CONFIRM_REQUIRED`/`CONFIRMTEXT_MISMATCH`/`BACKUP_LOCKED` findes live, men docs lister kun `BACKUP_LOCKED` og anbefaler skrøbelig streng-matching. Dokumentér alle tre.
- **AGENT-12** `mcp-tool-surface.md` stale for `journal_list`/`bank_list` paginering (input `{company}` vs. faktisk `{from,to,status,limit,offset}`; data mangler `total/hasMore/nextOffset`, default 500/cap 5000). Agent kan stiltiende miste poster. Opdatér.
- **AGENT-16** `code` mangler i forretningsfejl hvor den ville nytte mest (lukket periode, forudsætningsfejl) → kun fritekst-matching. Udvid `code` til PERIOD_CLOSED/PRECONDITION_MISSING/NOT_FOUND.

## Lav
- **AGENT-6** Per-kommando `--help` dækker ikke exit-koder (kontrakten påstår det).
- **AGENT-13** Stale tool-tællinger i `mcp-tool-surface.md` (46+11+41 vs. faktisk 47/11/42=101).
- **AGENT-14** Idempotens-listen ufuldstændig (`bank_import`, `peppol_submit_public_invoice` har også `idempotentHint`).
- **AGENT-15** `initialize`-instructions udelader slug-formen.
- **AGENT-17** `confirm-contract.md` mest stale dokument: nævner ikke-eksisterende `journal post --reverse-of` (det er `journal reverse`), "alle 95 tools" (faktisk 101/54 confirm-gatede).

## Godt beskrevet (agent kan stole på)
Exit-koder 0/1/2 (verificeret); actor-politik (pånær AGENT-1/2-huller); confirm-gating på MCP; `-32602`-kontrakt usædvanligt grundig; `confirmText` schema-valgfri; tool-beskrivelser i særklasse (enheder "i KRONER ikke øre", forudsætninger, bivirkninger, dedup-nøgler); invoice-livscyklus (#374) med stabilt forudsætnings-mønster; idempotens-advarsel prominent; `outputSchema` på alle 101 tools; `period reopen` CLI-only-eskalering eksplicit.

---

# Tværgående temaer

1. **Reverse-charge-moms** (JUR-1/JUR-2 = KODE-1/KODE-2): den ene reelle pengefejl i systemet, plus et kendt rubrik-issue. Test låser den forkerte adfærd fast.
2. **"Sandhed på tværs af flader"** (EJER-1/2/11/12, UI-2): cockpit/CLI/dashboard/agent er uenige om forfaldne fakturaer, frister, "sendt", banksaldo. Undergraver tillid bredt. Grundårsag delvis KODE-11 (UTC-"i dag").
3. **Samtidighed** (KODE-4/5/6/10, SEC-2): mange skriveveje er ikke transaktions-/allowlist-sikre på tværs af CLI+server+MCP. Acceptabelt i single-writer i dag, men skal lukkes før flere agenter/klienter deler database.
4. **Dokument-drift** (AGENT-3/10/11/12/17, UI-7): de "autoritative" markdown-kontrakter er bagud ift. live-overfladen; `confirm-contract.md` er mest stale. En regelret agent handler på forkerte påstande.
5. **GDPR-governance** (AGENT-1, JUR-8): den eneste datasletning er dårligst gated, og indsigtseksporten er ufuldstændig.
6. **Dansk sprog/lokalisering** (EJER-9/10/19, UI-8): produktet er stærkt dansk når alt går godt, engelsk når det går galt — og mangler æ/ø/å i officielle dokumenter + dansk datoformat.

## TEST-1 · Flaky test
`tests/unit/vat-eu-sales-oss-mcp.test.ts` fejler i fuld suite (`structuredContent` undefined) men passerer isoleret (3/3). Test-isolation/delt-tilstand-problem. Stabilisér — ellers maskerer den reelle regressioner.

---

*Rapporten er en uafhængig audit; ingen kode er ændret. Anbefalet rækkefølge: (1) JUR-1/KODE-1, EJER-1, AGENT-1 — derefter sandhed-på-tværs-af-flader (EJER-2/3/4, UI-2), så samtidighed (KODE-4/5/6/10) og dokument-synk inden flere klienter/produktionsdata.*
