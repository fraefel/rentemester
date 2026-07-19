# Bankimport: kanonisk idempotenskontrakt

Denne kontrakt er afledt direkte af `transactionFingerprint` i
[`src/core/bank.ts`](../src/core/bank.ts). Den gælder både CLI `bank import`
og MCP `bank_import`.

## Fingerprint og kontoskop

En importeret række identificeres af SHA-256 over disse normaliserede felter:

- `bank_account_id` — samme bankpost på to forskellige bankkonti er ikke en dublet.
- `transaction_date`
- `booking_date` (`null`, når den mangler)
- trimmet `text`
- afrundet `amount`
- normaliseret `currency`
- `reference` (`null`, når den mangler)
- afrundet `amount_dkk` (`null`, når den mangler)
- `fx_rate_to_dkk`, afrundet til seks decimaler (`null`, når den mangler)
- `occurrence`

`sourceFileHash` hører til importbatchens proveniens/auditspor; det er ikke
den nøgle, der afgør om en bankrække er en dublet.

## Re-importer og ens rækker

`occurrence` er en nulbaseret tæller for tidligere rækker med samme indhold i
**den aktuelle CSV-fil**. Derfor gælder følgende:

- En fuld re-import af samme CSV springer alle allerede importerede rækker over.
- En delvis eller overlappende re-import springer de rækker over, hvis samme
  indhold og occurrence allerede findes; nye rækker importeres.
- To legitimt ens rækker i samme CSV (for eksempel to gebyrer på 50 kr. samme
  dato) får occurrence `0` og `1` og importeres begge. En senere re-import af
  den samme fil springer begge over.

Ændres et fingerprint-felt — også bankkonto, bookingdato, reference,
`amount_dkk` eller FX-kurs — er det en anden række for importens dedup-regel.
Kontrollér derfor bankeksporten før du ændrer data og re-importerer.
