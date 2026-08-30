# Cockpit-redesign — byggeplan & to-do

Arbejds- og to-do-liste for ombygningen af Cockpit-webappen (`app/` + `src/server/`).
Listen loopes: hver iteration bygges af en underagent, og **hver runde slutter med en
visuel inspektion** før næste.

## Mål

Cockpit skal give et menneske et hurtigt, præcist og flot overblik over en
virksomheds regnskab. To krav over alt andet:

1. **Korrekthed.** Alle tal afspejler præcist det bogførte i ledgeren. Ledgeren er
   sandheden — cockpittet beregner og viser, det opfinder ikke.
2. **Informationsparitet med Dinero.** Vi skal som minimum kunne vise det Dinero
   viser (overblik, resultat, balance, moms, bank, posteringer, kontakter).
   Visuelt behøver vi ikke ligne dem — informationsmæssigt skal vi ramme dem.

## Principper

- **Flot** — roligt, professionelt; følger `DESIGN.md`-tokens.
- **Overskueligt** — overblik på fem sekunder; progressiv detalje (drill-down).
- **Responsivt** — fungerer og ser godt ud på både desktop og mobil.
- **Grafer** — nøgletal og udvikling visualiseres (Chart.js).
- **Multi-år** — man kan vælge regnskabsår, se flere år, og sammenligne år.
- **Visuel inspektion hver runde** — screenshot (desktop + mobil), tal verificeret
  mod ground truth, design vurderet, før næste iteration.

## Datagrundlag

- **Live ledger** = indeværende regnskabsår (Helheim: 2026).
- **Arkiv (#197)** = tidligere år (Helheim: 2023, 2024, 2025) — read-only.
- Cockpittet skal læse begge, så alle regnskabsår er tilgængelige i UI'et.

## Ground truth (Helheim ApS, regnskabsår 2026) — målestok for korrekthed

- Omsætning **17.829,02** · Udgifter **4.594,20** · Resultat **13.234,82**
- Moms 1. halvår 2026: **3.371,00** at betale (salgsmoms 4.457, købsmoms 1.148)
- Bogført bankkonto-saldo (konto 55000)
- 5 købsbilag, 0 salgsfakturaer

## Views

| # | View | Formål | Dinero-pendant | Prioritet |
|---|------|--------|----------------|-----------|
| 1 | Portefølje | Virksomhedsliste (workspace) | — | findes, let polish |
| 2 | Overblik | Nøgletal + grafer + statuskort | "Overblik" | **P0** |
| 3 | Resultatopgørelse | Indtægter, udgifter, resultat | — | P1 |
| 4 | Balance | Aktiver, passiver, egenkapital | — | P1 |
| 5 | Saldobalance | Alle konti med saldo | — | P1 |
| 6 | Posteringer | Journal/bilagsliste + drill-down til linjer | "Bilagsoversigt" | P1 |
| 7 | Bank | Banktransaktioner + afstemningsstatus | "Bankafstemning" | P2 |
| 8 | Moms | Momsangivelse for perioden | "Moms" | P2 |
| 9 | Bilag | Dokumenter/kvitteringer + link til posteringer | — | P2 |
| 10 | Arkiv | Tidligere år (2023–25), read-only | — | P2 |
| 11 | Flerårsoversigt | Flere regnskabsår sammenlignet | — | P3 |
| 12 | Fakturaer | Udstedte fakturaer + status | "Salg" | P3 |
| 13 | Kontakter | Kunder + leverandører | "Kontakter" | P3 |

## Backend (API)

Nuværende endpoints: `/api/health`, `/api/portfolio`, `/api/companies`,
`/api/companies/:slug` (PATCH), `/api/companies/:slug/dashboard`.

Nye/udvidede endpoints — alle årsbevidste (`?year=YYYY`), genbruger `src/core/`:

- `/api/companies/:slug/fiscal-years` — tilgængelige år (live + arkiverede)
- `/api/companies/:slug/overview?year=` — Overblik: resultat-sammendrag, bank, moms, undtagelser, seneste posteringer
- `/api/companies/:slug/income-statement?year=`
- `/api/companies/:slug/balance?year=`
- `/api/companies/:slug/trial-balance?year=`
- `/api/companies/:slug/journal?year=` — posteringer/bilag
- `/api/companies/:slug/bank?year=`
- `/api/companies/:slug/vat?year=&period=`
- `/api/companies/:slug/documents`
- `/api/companies/:slug/invoices`
- `/api/companies/:slug/contacts`
- `/api/companies/:slug/archive/:year` — arkiveret år (#197-data)
- `/api/companies/:slug/multi-year` — nøgletal på tværs af år

## Tværgående

- **Regnskabsårs-vælger** — global kontrol; alle views respekterer det valgte år.
- **Chart.js** — tilføjes til `app/`; bruges til P&L-graf og flerårs-trends.
- **Responsivt layout** — desktop + mobil.
- **Designsystem** — tokens i `app/src/styles.css` ud fra `DESIGN.md`.

## Loop-protokol

Hver runde: underagent bygger iterationens opgaver på `feat/cockpit-redesign`
→ jeg screenshotter den kørende app (desktop **og** mobil) → jeg verificerer tal
mod ground truth → vurderer design mod principperne → skriver konkret feedback
→ næste runde. Afkryds opgaver herunder efterhånden som de er inspiceret og godkendt.

## To-do

### Iteration 0 — Diagnose, ledger-fix & fundament

**Diagnose-fund (kritisk):** Helheim-ledgeren er fejlklassificeret. Dinero-importen
(#193) lader eksisterende konti i Rentemesters seedede kontoplan stå urørt — så
Dineros konti, der kolliderer på kontonummer, bliver IKKE anvendt. Konkret:
Dineros `2000 Vareforbrug` (udgift) kolliderer med Rentemesters seedede `2000 Bank`
(aktiv), så 4.113,04 kr vareforbrug er bogført på en aktivkonto. Resultatet bliver
forkert (udgifter 481,16 i stedet for 4.594,20). Et dashboard kan ikke vise de
rigtige tal før ledgeren er korrekt — derfor fixes importen først.

- [x] Opret feature-gren `feat/cockpit-redesign`
- [x] Træk Helheims faktiske tal — bekræftet gap mod ground truth
- [x] Fix `reconcileChartOfAccounts`: kildens kontoplan er nu autoritativ —
      kolliderende konti uden posteringer reklassificeres til kildens værdier.
      #193-tests opdateret.
- [x] Geninporteret Helheim i frisk virksomhed; ledger verificeret:
      Omsætning 17.829,02 · Udgifter 4.594,20 · Resultat 13.234,82 ✓
- [x] Tilføjet Chart.js + react-chartjs-2 i `app/`
- [x] Etableret designsystem-tokens i `app/src/styles.css`
- [x] Backend: `/api/companies/:slug/fiscal-years`
- [x] App kører via preview (backend hoster `app/dist` på :4319)
- [x] Baseline screenshot taget — nuværende dashboard er en flad felt-liste:
      mangler resultat/P&L helt, moms viser 0 (forkert), ingen grafer/årsvalg
- [x] **Visuel inspektion** — baseline dokumenteret, ledger verificeret korrekt

### Iteration 1 — Overblik (P0)
- [x] Backend: `/api/companies/:slug/overview?year=` — P&L (med måneds-
      opdeling), bank, moms, undtagelser, seneste posteringer; årsbevidst
- [x] Frontend: global regnskabsårs-vælger (dropdown, genindlæser ved skift)
- [x] Frontend: Overblik-view — KPI-kort (Omsætning / Udgifter / Resultat)
- [x] Frontend: P&L-graf måned for måned (Chart.js)
- [x] Frontend: statuskort — Bank, Moms, Undtagelser/Opgaver, Seneste posteringer
- [x] Responsivt layout (desktop + mobil)
- [x] **Visuel inspektion** — tal matcher ground truth (Resultat 13.234,82);
      graf + KPI-kort + statuskort verificeret på desktop og mobil

### Iteration 2 — Regnskabsopgørelser (P1)
- [x] Backend: income-statement, balance, trial-balance endpoints (årsbevidste)
- [x] Frontend: Resultatopgørelse-view (med foregående år til sammenligning)
- [x] Frontend: Balance-view
- [x] Frontend: Saldobalance-view
- [x] Per-virksomhed sub-navigation (Overblik · Resultatopgørelse · Balance ·
      Saldobalance); valgt regnskabsår bæres i URL'en (`?year=`) på tværs af views
- [x] **Visuel inspektion** — Resultatopgørelse (resultat 13.234,82), Balance
      (aktiver 42.290,03, balancerer), Saldobalance verificeret desktop + mobil

### Iteration 3 — Ledger-detaljer (P1–P2)
- [x] Backend: journal, bank, vat, documents endpoints (årsbevidste)
- [x] Frontend: Posteringer-view + drill-down til entry-linjer
- [x] Frontend: Bank-view — transaktioner + afstemningsstatus
- [x] Frontend: Moms-view — momsangivelse for perioden
- [x] Frontend: Bilag-view — dokumenter + link til posteringer
- [x] Sub-navigation udvidet til 8 punkter; `?year=` bæres på tværs
- [x] **Visuel inspektion** — Posteringer (10 entries, drill-down), Bank
      (saldo 41.388,03, 19 txn i 2026), Moms (3.371,20 at betale), Bilag
      (5 stk., linket til posteringer); desktop + mobil.

### Iteration 4 — Multi-år (P2–P3)
- [x] Backend: archive endpoints (#197-data 2023–25) + multi-year-endpoint —
      `GET .../archive/:year` (saldobalance + posteringssammendrag) og
      `GET .../multi-year` (omsætning/udgifter/resultat pr. år, ældste→nyeste;
      arkiv-år klassificeret via `accounts.type`)
- [x] Frontend: Arkiv-view — arkiveret års saldobalance, read-only, tydeligt
      mærket "Arkiveret regnskabsår — skrivebeskyttet"
- [x] Frontend: Flerårsoversigt — nøgletals-tabel + Chart.js-trendgraf (2023→26)
- [x] Regnskabsårs-vælger spænder over arkiv + live; CompanyNav udvidet til 10
      punkter; arkiverede år i live-views linker nu til Arkiv-viewet
- [x] **Visuel inspektion** — Flerårsoversigt (4 år 2023–26, trend-graf, tabel),
      Arkiv (2024-saldobalance, skrivebeskyttet); desktop + mobil

### Iteration 5 — Kontakter, fakturaer & finish (P3)
- [x] Backend: invoices, contacts endpoints — `GET .../invoices?year=`
      (udstedte fakturaer med status: bogført/betalt/forfalden m.fl.) og
      `GET .../contacts` (kunder + leverandører som stamdata). Begge giver
      yndefuldt et tomt resultat når virksomheden intet har — Helheims
      forventede tilstand (0 fakturaer, 0 kontakter).
- [x] Frontend: Fakturaer-view — fakturaliste med status, summerings-kort
      (faktureret/udestående/forfaldne), årsbevidst, pæn tom-tilstand
- [x] Frontend: Kontakter-view — kunder + leverandører i hver sin tabel,
      pæn tom-tilstand
- [x] Sidste responsiv- og designpolering: CompanyNav udvidet til 12 punkter
      og omlagt til fire mærkede grupper (Regnskab · Bogføring · Salg ·
      Historik) med hårfine skillelinjer, hover/fokus-tilstande og ryddelig
      mobil-ombrydning; ensartede kort, tabeller og tom-tilstande på tværs
- [x] **Visuel inspektion** — Fakturaer + Kontakter (pæne tom-tilstande, korrekt
      for Helheim), grupperet 12-punkts-nav verificeret desktop + mobil

---

## Status — loop afsluttet

Alle 6 iterationer bygget og visuelt inspiceret. 12 views på plads med
informationsparitet med Dinero. Endelig verifikation på `feat/cockpit-redesign`:
**688 tests grønne · `bun run smoke` grøn**. Tallene matcher ledger-ground-truth
(Resultat 13.234,82 · Balance 42.290,03 · Moms 3.371,20). Multi-år (2023–26) og
regnskabsårs-vælger virker. Responsivt på desktop + mobil.

Åbne polish-punkter (ikke-blokerende, noteret til opfølgning):
- Resultatopgørelsens "foregående år"-kolonne viser 0 for arkiverede år; kunne
  trække arkiv-data ind.

---

## Runde 2 — fra regnskabs-cockpit til drifts-cockpit

En virksomhedsejer-gennemgang viste: cockpittet viser regnskabet godt, men
mangler de drifts-svar en ejer har brug for. Disse iterationer lukker gabet.
Samme loop-protokol: underagent bygger → visuel inspektion → næste.

### Iteration 6 — Bank-sandhed & meningsfulde opgaver
- [x] Backend: bank/overview returnerer FAKTISK banksaldo (seneste
      `balance_after` fra kontoudtoget) + difference mod bogført saldo
- [x] Overblik: Bank-kortet viser faktisk saldo, bogført saldo OG difference
- [x] Bank-view: differencen vist prominent øverst
- [x] Opgaver: de mange "bank unmatched"-undtagelser grupperes til ÉN dansk,
      klikbar linje ("362 banktransaktioner mangler afstemning" → Bank-view)
- [x] **Visuel inspektion** — Bank-kort 23.654,75 (kontoudtog) vs 41.388,03
      (bogført), difference 17.733,28; grupperet opgave; desktop + mobil

### Iteration 7 — Forpligtelser & deadlines
- [x] Backend: forpligtelses-endpoint (moms, selskabsskat, kreditorer, afsat
      revisor m.fl.) med forfaldsdato/-frist hvor den kendes —
      `GET .../obligations?year=`; moms-frist udledt fra halvårsperioden,
      selskabsskat 1. november året efter, kreditorer/revisor uden kendt dato
- [x] Frontend: Forpligtelser-view — "hvad skylder jeg og hvornår", sorteret
      efter frist, beløb højrestillet, pæn tom-tilstand; i CompanyNav (13 pkt.)
- [x] Moms-view + Overblik: indberetnings-/betalingsfrist + dage tilbage
- [x] Overblik: debitor-kort ("hvem skylder mig", åbne tilgodehavender) —
      for Helheim 0, vist som ren nul-tilstand
- [x] **Visuel inspektion** — Forpligtelser 21.672,94 i alt (moms tælles én
      gang efter fix), moms-frist 103 dage, debitor-kort 0 kr.

### Iteration 8 — Likviditet / pengestrøm
- [x] Backend: pengestrøms-endpoint — penge ind/ud + faktisk bank-udvikling
      (`GET .../cashflow?year=`)
- [x] Frontend: Likviditet-view — primo/ind/ud/ultimo-kort, kombineret graf
      (søjler + banksaldo-linje), 12-måneders tabel
- [x] **Visuel inspektion** — primo 30.116,01 + ind 22.286,27 − ud 28.747,53
      = ultimo 23.654,75; verificeret (krævede fix: registrér LineController)

### Iteration 9 — Drill-down, nøgletal & klarhed
- [x] Drill-down: Overblik-KPI/statuskort linker til opgørelserne; konto-rækker
      i Saldobalance/Resultatopgørelse/Balance linker til Posteringer med
      `?account=<kontonr>`-filter (navngiver kontoen, kan ryddes igen)
- [x] "Senest bogført pr. <dato>" tydeligt på Overblik — transaktionsdato for
      seneste bogførte postering (tilføjet til `/overview`-payload)
- [x] Flerårsoversigt: indeværende (live) år mærket "(år til dato)" i både
      tabel og graf
- [x] Bilag-view: viser koblet posterings tekst + beløb (falder tilbage til
      posteringens total når dokumentbeløbet mangler)
- [x] Seneste posteringer (Overblik): læsbar posteringstekst — relayout fra
      afkortet tabel til ombrydende liste (desktop + mobil)
- [x] Nøgletal (bruttomargin, egenkapitalandel) på Overblik
- [x] **Visuel inspektion** — nøgletal (74,2 % / 47,6 %), "Senest bogført pr.
      2026-02-27", konto-drill-down (2000 → 2 posteringer), Flerår
      "(år til dato)", Bilag-posteringstekst, læsbare seneste posteringer

---

## Status — runde 2 afsluttet

Alle fire drifts-iterationer (6–9) bygget og visuelt inspiceret. Cockpittet er
nu et drifts-cockpit: faktisk banksaldo + afstemningsdifference, meningsfulde
opgaver, forpligtelser med forfaldsdato, moms-deadline, likviditet/pengestrøm,
drill-down, nøgletal. Endelig verifikation: **702 tests grønne · smoke grøn**.

---

## Runde 3 — historiske år i de rigtige views

Ejer-feedback: de gode views kan kun ses for det levende år; man vil kunne se
tilbage i tid (arkiv-data) og sammenligne på tværs af år. Dataene findes
allerede — #197 arkiverede fuld saldobalance + alle posteringer pr. tidligere
år. Bank-transaktioner går kun så langt tilbage som kontoudtoget rækker — det
er accepteret; ingen kunstig udfyldning.

### Iteration 10 — Arkiv-bevidste kerne-views
- [x] Backend: income-statement, balance, trial-balance, journal, overview
      regner fra `import_archive_*` når det valgte år er arkiveret
- [x] Frontend: Resultatopgørelse, Balance, Saldobalance, Posteringer, Overblik
      renderer arkiv-data (skrivebeskyttet-banner) i stedet for placeholderen
- [x] Views uden arkiv-data for gamle år (Bank/Moms/Forpligtelser/Likviditet/
      Bilag/Fakturaer/Kontakter) viser en ærlig "ikke tilgængelig for
      arkiverede år"-tilstand — ingen kunstig udfyldning
- [x] **Visuel inspektion** — 2024: Resultatopgørelse/Overblik viser arkiv-data
      (resultat −3.437,22), Posteringer 375 bilag, banner; Bank 2024 ærlig
      "ikke tilgængelig"-tilstand; placeholder-blindvejen væk

### Iteration 11 — Krydsår-overblik & oprydning
- [x] Udvid Flerårsoversigt: `/multi-year` leverer nu balancesum, egenkapital
      og nøgletal (bruttomargin, egenkapitalandel) pr. år — live via
      `buildBalanceSheet`, arkiv-år klassificeret fra `import_archive_balances`.
      Frontend viser P&L-, balance- og nøgletalssektioner med tabel + to
      trendgrafer (P&L + balance), "(år til dato)" bevaret
- [x] Ryd op i Arkiv/vælger-UX — vælgeren virker overalt; Arkiv-fanen er nu en
      kortfattet "Om arkivet"-forklaring (hvilke år, Dinero-import #197,
      skrivebeskyttet) med links ind i de arkiv-bevidste kerne-views i stedet
      for den redundante rå saldobalance
- [x] **Visuel inspektion** — Flerårsoversigt (Resultat/Balance/Nøgletal pr.
      år 2023–26), "Om arkivet"-fane. Fandt + rettede korrektheds-fejl: den
      arkiverede balance medregnede ikke årets resultat i egenkapitalen
      (balancerede ikke; Flerår uenig med Balance-view). Efter fix balancerer
      alle fire år, og egenkapital er konsistent på tværs af views.

---

## Status — runde 3 afsluttet

Historiske år er nu fuldt browsbare: vælg et arkiveret år i regnskabsårs-
vælgeren, og Overblik, Resultatopgørelse, Balance, Saldobalance og Posteringer
viser arkiv-tallene (skrivebeskyttet-banner). Views uden arkiv-data viser en
ærlig "ikke tilgængelig"-tilstand. Flerårsoversigten sammenligner nu resultat,
balance og nøgletal på tværs af alle år. Endelig verifikation: **710 tests
grønne · smoke grøn**; alle fire regnskabsår balancerer.

---

## Runde 4 — porteføljeoversigten

Ejer-feedback: porteføljekortet viser forkerte/forældede tal (`/api/portfolio`
bruger gammel #171-logik — moms beregnes til 0 for Dinero-importerede ledgers,
samme fejl som per-virksomhed blev rettet i runde 1). Og kortet mangler det en
ejer dømmer en virksomhed på: resultat, likviditet, omsætning. For en ejer med
flere virksomheder skal oversigten give pr.-virksomhed-helbred + et tværgående
overblik + hvor man skal handle.

### Iteration 12 — Portefølje med rigtige tal
- [x] Backend: omskriv `buildPortfolioOverview` — hver virksomhed får de rigtige
      tal (resultat, omsætning, faktisk banksaldo, moms via `vatPositionForPeriod`
      + frist, grupperede opgaver) ved at genbruge per-virksomheds-logikken;
      plus en tværgående opsummering (samlet resultat, likviditet, moms-skyld)
- [x] Frontend: redesign virksomhedskortet — overskrifts-helbred (resultat,
      bank, omsætning, moms+frist, opgaver); kort klikbart ind i virksomheden
- [x] Frontend: tværgående opsummerings-stribe øverst på porteføljen
- [x] Frontend: virksomheder der kræver opmærksomhed markeres/sorteres øverst
- [x] **Visuel inspektion** — Helheim-kort viser rigtige tal (resultat 13.234,82,
      bank 23.654,75, omsætning 17.829,02, moms 3.371,20 + frist), opsummerings-
      stribe verificeret desktop + mobil (rettede 2-kolonne-overløb på mobil)

---

## Status — runde 4 afsluttet

Porteføljeoversigten er nu koblet til rigtige data. Hvert virksomhedskort viser
resultat, faktisk banksaldo, omsætning, moms + frist og opgaver; en tværgående
opsummerings-stribe samler tallene på tværs af virksomheder; virksomheder der
kræver opmærksomhed sorteres øverst. Endelig verifikation: **746 tests grønne ·
smoke grøn**.
