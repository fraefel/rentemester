# Koncernstruktur og konsolidering — slice 1–4

Rentemester bevarer altid én uafhængig, immutabel hovedbog per juridisk enhed.
Koncernfunktionen består af en effektivt dateret struktur/status-model og en
read-only mellemregningsafstemning. Ingen af delene migrerer eller skriver i
selskabernes hovedbøger.

En struktur importeres som JSON med `version: 1`, `groups`, `memberships` og
`ownership`. Medlemskaber og ejerandele bruger halvåbne intervaller:
`validFrom` er inklusiv og en eventuel `validToExclusive` er eksklusiv.
Ejerandele er 1–10.000 basispoint og skal bære 1–32 korte, generiske
`evidenceRefs`. Referencerne er sporbarhedsidentifikatorer, ikke konti eller
bogføringssemantik. Alle referenced selskabsslugs skal allerede være
registreret i workspace-manifestet; ejerandele skal være fuldt dækket af aktive
medlemskaber. To direkte rækker for samme ejer/barn må ikke overlappe, de
samlede aktive direkte ejerandele i et barn må ikke overstige 10.000 basispoint,
og en effektiv ejer-graf må aldrig danne en cyklus.

`group validate-manifest` læser og validerer alene. `group apply-manifest`
kræver `--confirm yes`, en actor og en registreret `--policy-company`. Den
gemmer et kanonisk manifest som en append-only SHA-256-hashkæde i det private
workspace-control DB. Den omskriver aldrig en tidligere struktur.

`group overview --as-of YYYY-MM-DD` og
`GET /api/group-overview?asOf=YYYY-MM-DD` kræver altid en eksplicit dato; der
er ingen skjult "i dag"-default. De viser kun aktive halvåbne intervaller på
den dato og svarer altid med
`scope: "structure-status-only"`, `consolidationStatus: "not-available"`,
`consolidatedFigures: null` og `rawCompanySums: null`.

HTTP-ruten kræver `workspace.group.read`. Den afslører kun selskaber som den
aktuelle bruger har et aktivt medlemskab til. Ejerrelationer returneres kun når
begge ender er synlige; skjulte identiteter og antal afsløres ikke. Hvis
mindst ét aktivt koncernselskab eller en ejerrelation er skjult, eller et aktivt
medlem er arkiveret, er gruppens parathed blokeret.

## Mellemregningsmapping og afstemning

`group validate-mapping`, `group propose-mapping`, `group approve-mapping` og
`group revoke-mapping` håndterer eksplicitte kontomappings. Forslag er inerte,
indtil en anden actor godkender den præcise SHA-256-identitet. Begge aktorer
skal være tilladt i begge selskabers policy. Events og workspace-audit er
append-only; en tilbagekaldelse sletter aldrig historik.

En mapping binder to forskellige, aktive koncernselskaber, komplementære
positioner (`receivable`/`payable`), eksakte kontonumre, gyldighedsinterval og
evidence references. Overlappende aktive mappings må ikke genbruge samme konto.
Der udledes aldrig mapping fra kontonavn, CVR, fakturatekst eller modpart.

`group reconcile --as-of YYYY-MM-DD` og
`GET /api/group-reconciliation?asOf=YYYY-MM-DD` åbner hver ledger read-only,
kontrollerer schema og auditkæde og returnerer kildeposteringer samt ledgerens
hash-head. Tilgodehavende normaliseres som debet minus kredit og gæld som kredit
minus debet. Sammenligningen er eksakt i øre og udføres kun, når begge selskaber
har samme funktionsvaluta. Forskellig valuta, manglende/inaktiv konto, arkiveret
selskab, utilgængelig ledger eller integritetsfejl giver `not-comparable`.

Hosted-ruten kræver adgang til begge selskaber. Ved delvis adgang returneres
hverken mapping-id, skjult selskab, konto, saldo eller difference.

## Append-only balanceelimineringer

`group propose-elimination`, `group approve-elimination`,
`group reject-elimination`, `group apply-elimination` og
`group reverse-elimination` udgør et workspace-only lifecycle.
En elimination kan kun foreslås fra en aktiv, godkendt mapping, hvis
afstemningen er eksakt `matched`, begge saldi er positive og ens i øre, og
funktionsvalutaen er identisk. Beløb kan ikke indtastes frit.

Forslaget binder mapping-hash, eksplicit `asOf`, selskaber, konti,
ledger-heads, entry counts og deterministiske source-selection-hashes.
Godkendelse og anvendelse genberegner kildeevidensen; ændrede posteringer gør
forslaget stale og kræver et nyt forslag. Forslagets actor må hverken godkende
eller anvende det. Anvendelse skriver kun et append-only event i
workspace-control; selskabernes hovedbøger forbliver byte-uændrede.

`group eliminations --as-of` og `GET /api/group-eliminations?asOf=...` viser
kun anvendte events. Hosted-brugere uden adgang til begge selskaber får alene
en blocker uden elimination-id, selskabsidentitet eller beløb. Første slice
understøtter kun `intercompany-balance`; indtægts-/omkostningselimineringer og
øvrige manuelle konsolideringsjusteringer er ikke implementeret.

## Rapporteringsprofiler og konsoliderede rapporter

Slice 4 tilføjer et generisk, effektivt dateret rapporteringskontoskema. Det
har ingen indbyggede selskabsnavne, CVR-numre eller standardkonti. Hver profil
binder i stedet eksakte selskabskonti til eksplicitte linjer for aktiver,
forpligtelser, egenkapital, indtægter og omkostninger. Én egenkapitallinje skal
være markeret som periodens resultat. Profilen følger et append-only
forslag/godkendelse/tilbagekaldelse-lifecycle, og forslagsstiller og reviewer
skal være forskellige. CLI-aktøren skal være tilladt i alle koncernens
selskaber.

`group validate-profile`, `group propose-profile`, `group approve-profile` og
`group revoke-profile` styrer profilen. `group consolidated-report --profile-id ...
--from ... --as-of ...` og `GET /api/group-consolidated-report` bygger
rapporten read-only. Første version kræver én rod, 100 % ejerskab af alle børn,
samme funktionsvaluta i alle selskaber, fuld adgang til samtlige aktive
koncernselskaber og mapping af alle konti med ikke-nul saldo. Den udfører ingen
valutakonvertering og beregner ikke minoritetsinteresser.

Rapporten viser rå selskabssummer, anvendte eliminationer, konsoliderede linjer
og kilde-snapshots. Hver anvendt elimination genvalideres mod den aktuelle
mapping, selection-hash, ledger-head, entry count og balance. En baguddateret
postering gør derfor rapporten blokeret, indtil en ny elimination er foreslået,
godkendt og anvendt. Eliminationer filtreres altid til profilens egen koncern.
Hvis aktiver ikke er lig forpligtelser plus egenkapital, returneres ingen
konsoliderede tal. Ved delvis hosted-adgang returneres kun en generisk blocker;
profil-, koncern-, selskabs-, konto- og elimination-identiteter skjules.

Struktur-overviewet forbliver bevidst `structure-status-only` og indeholder
aldrig finansielle tal. Konsoliderede tal findes kun i den særskilte,
profilbundne rapportkontrakt. Indtægts-/omkostningselimineringer, valuta,
minoritetsinteresser, skat og lovpligtig koncernrapportering er fortsat
separate, ikke-implementerede scopes.
