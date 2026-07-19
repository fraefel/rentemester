# Første virksomhed: fra ren clone til verificeret postering

Dette er den kanoniske onboarding-vej for Rentemester. Den er bevidst delt i
fem forskellige situationer: udvikling, drift, en helt ny virksomhed, migration
fra et eksisterende system og den første rigtige postering. Kør ikke en
produktionsvirksomhed som eneste kilde til sandhed endnu; se forbeholdet i
[README](../README.md#vigtigt-forbehold).

Alle eksempler bruger kun lokale stier og ikke-hemmelige identiteter. Skriv
aldrig adgangskoder, API-nøgler, tokens eller bank-login i kommandoer,
skalhistorik eller repository-filer. Brug i stedet den relevante klient eller
operativsystemets secret store, når en integration kræver en hemmelighed.

## 1. Udviklerinstallation

Forudsætning: [Bun](https://bun.sh) 1.2 eller nyere. En ren clone kræver både
rodprojektets afhængigheder (CLI/MCP) og cockpit-appens afhængigheder:

```bash
git clone https://github.com/mikkelkrogsholm/rentemester.git
cd rentemester
bun install
(cd app && bun install)
bun link
rentemester --version
command -v rentemester
command -v rentemester-mcp
```

`bun link` installerer pakkens to stabile wrappers: `rentemester` starter
`src/cli.ts`, og `rentemester-mcp` starter `src/mcp/server.ts`. Den sidste er
en stdio-server og må derfor ikke bruges som en interaktiv `--help`-kommando;
dens ende-til-ende-kontrol er MCP-smoken nedenfor.

De mindste grønne gates for en udviklerclone er:

```bash
bun test
(cd app && bun test && bun run build)
bun run smoke
bun run smoke-mcp
```

Root-testene dækker den delte kerne, cockpit-test/build dækker UI'en, `smoke`
går CLI-flowet igennem, og `smoke-mcp` opretter en midlertidig virksomhed,
gennemfører MCP-handshake, confirm-gating, fakturalivscyklus og audit-kontrol.
Ingen af dem bruger produktionsdata.

## 2. Produktionsoperatørinstallation

En operatør skal bruge en fastlåst release og et separat, vedvarende
virksomhedsvolume — ikke en udviklerclone med en vilkårlig commit. Følg den
fastlåste containervej i [README's Docker-afsnit](../README.md#fastlåst-docker-distribution)
og versions-/godkendelsesflowet i [release-guiden](release/README.md).

Før en release får adgang til rigtige data, verificér den mod en ny tom
virksomhed eller en verificeret datakopi, aldrig den eneste live-ledger. Hold
cockpit på den lokale bind-adresse i compose-eksemplet; det er ikke en offentlig
login-løsning. Ved lokal binær drift gælder shim-kontrollerne fra afsnit 1
stadig, og MCP-klienten skal pege på `rentemester-mcp`, ikke interne
`src/*.ts`-filer.

## 3. Opret den første virksomhed og actor

Vælg først den menneskelige eller automatiske identitet, som skal have ansvar
for efterfølgende writes. `init` seeder den valgte actor i virksomhedens
`config/policy.yaml`, så den er klar **før** første muterende smoke eller
bogføring. Actor er sporbar identitet, ikke en hemmelighed.

```bash
COMPANY="$HOME/rentemester-data/acme-aps"
ACTOR="user:acme-owner"

rentemester init \
  --company "$COMPANY" \
  --name "Acme ApS" \
  --cvr DK12345678 \
  --vat-period quarter \
  --actor "$ACTOR"

rentemester system healthcheck --company "$COMPANY"
rentemester accounts roles-status --company "$COMPANY"
```

Er virksomheden ikke momsregistreret, vælg `--no-vat` (eller
`--vat-period none`) i stedet for `--vat-period quarter`. Før en anden person
eller agent kan skrive, tilføjer en ansvarlig operatør dens kanoniske
`user:…`, `agent:…` eller `system:…`-identitet til virksomhedens
`config/policy.yaml`. Den fulde actor- og exit-kode-kontrakt står i
[CLI-kontrakten](cli-contract.md).

Alle senere muterende CLI-kommandoer skal have `--actor "$ACTOR"` (eller en
anden allowlistet actor). Exit `2` betyder at kaldet/politikken skal rettes;
exit `1` betyder at det formelt gyldige kald blev afvist af forretnings- eller
ledgerreglerne.

## 4. Bankkonto og konto-mapping

Hvis betalingsoplysninger blev angivet ved `init`, oprettes den primære
bankkonto med sluggen `primaer`. I en ren clone uden betalingsoplysninger skal
den oprettes eksplicit, før den kan opdateres. Se den først, opret den om
nødvendigt, og sæt derefter dens finansielle mapping før nogen bankimporter:

```bash
rentemester bank-account list --company "$COMPANY"
rentemester bank-account add \
  --company "$COMPANY" \
  --name "Primær driftskonto" \
  --slug primaer \
  --currency DKK \
  --actor "$ACTOR"
rentemester bank-account update \
  --company "$COMPANY" \
  --account primaer \
  --ledger-account 2000 \
  --actor "$ACTOR"
rentemester bank-account list --company "$COMPANY"
```

Hvis `primaer` allerede fandtes efter `init`, springes `bank-account add` over.
Angiv kun `--account primaer` på
`bank import`, når CSV-rækkerne faktisk hører til den konto.

`bank-account update` auditerer ændringer i betalingsprofil og aktiv-status.
Den afviser en ændring af `--ledger-account`, når kontoen allerede har
transaktioner, fordi historiske bankrækker ikke må få ny regnskabsmæssig
betydning. Opret i det tilfælde en ny bankkonto i stedet for at remappe den
gamle.

## 5. Ny virksomhed eller migration — vælg én vej

**Helt ny virksomhed.** Start med den reelle, gennemgåede dokumentation og en
dry-run; fortsæt til afsnit 6. Det fulde daglige eksempel er
[bogførings-playbooken](../examples/agent-demo/README.md): den viser bilag,
bankimport, forslag, exceptions, moms og audit uden nøgler eller netværk.

**Eksisterende virksomhed.** Eksportér først fra det gamle system og behold
den oprindelige eksport som dokumentation. Undersøg understøttede parsere og
valider derefter en kopi af eksporten:

```bash
rentemester import systems
rentemester import run \
  --company "$COMPANY" \
  --file /sikker/lokal/sti/til/eksport.csv \
  --system synthetic-csv \
  --dry-run \
  --actor "$ACTOR"
```

Er eksporten accepteret, fjernes `--dry-run` først efter gennemgang. Importen
er idempotent og bogfører én balanceret primobalance; den erstatter ikke en
ukontrolleret historisk dataoverførsel. Brug `import systems` til at vælge en
faktisk tilgængelig parser — `synthetic-csv` er kun det indbyggede eksempel.
Hvis du selv har en balanceret, revisor-godkendt primobalance, er det separate
flow `rentemester opening-balance post --help`.

## 6. Første verificerede postering

Lav først en gennemgået JSON-payload fra et rigtigt bilag og en korrekt
konto-/moms-vurdering. Kør samme payload som dry-run, post den kun når
resultatet er korrekt, og verificér derefter audit-kæden:

```bash
rentemester journal dry-run \
  --company "$COMPANY" \
  --input ./første-postering.json

rentemester journal post \
  --company "$COMPANY" \
  --input ./første-postering.json \
  --actor "$ACTOR"

rentemester audit verify --company "$COMPANY"
rentemester journal list --company "$COMPANY"
```

Gem ikke hemmeligheder i `første-postering.json`; den skal kun indeholde den
bogføringspayload, der er nødvendig for posteringen. Bilag og metadata skal
indlæses og vurderes før deres `documentId` bruges i en journalpost. Ret fejl
med en ny reverseringspostering — slet eller redigér aldrig den bogførte
historik. Se [CLI-kontrakten](cli-contract.md) og
[confirm-kontrakten](confirm-contract.md) for write- og destructive-regler.

## 7. Backup og MCP efter første postering

Sæt backup-destination og menneskelig EU/EØS-/sikkerhedsattestering op før
normal drift. Følg [backup-onboarding](compliance/backup-destinations.md),
som beskriver destination, attestering, placering og kontrol af governance.

Hvis en agent skal arbejde via MCP, følg den MCP-specifikke klientopsætning i
[MCP-installation](mcp-install.md). MCP-write-tools kræver `confirm: true` pr.
kald, også når CLI's daglige writes bruger actor i stedet; den præcise kontrakt
står i [MCP-agentkontrakten](mcp-agent-contract.md).
