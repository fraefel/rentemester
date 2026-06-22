// Digisense produktions-wiring (#efaktura) — binder secret-laget + state-laget +
// klienten + transmitteren sammen til ÉN konkret PeppolTransmitter, klar til
// transmitPublicEInvoicePeppol.
//
// Dette lag rører rigtig konfiguration (license-key fra config/digisense.json)
// og rigtig state (companyKey fra digisense_companies), men IKKE netværket:
// selve HTTP-kaldene sker først når transmitteren køres. Derfor er det her
// CLI/MCP henter sin transmitter, mens unit-tests injicerer en fake klient
// direkte i createDigisenseTransmitter og aldrig rører denne fil.
//
// Trust-boundary: license-key læses fra secret-filen og gives KUN til klienten;
// den lægges aldrig i ledgeren eller i en envelope. companyKey er ikke-secret
// state og må gerne returneres.

import type { Database } from "bun:sqlite";
import { createDigisenseClient, type DigisenseClient, type KsefEnvironment } from "./digisense-client";
import { createDigisenseTransmitter } from "./digisense-transmitter";
import { defaultDocumentDownloader, type DigisenseDocumentDownloader } from "./digisense-receive";
import { loadDigisenseSecretConfig } from "./digisense-config";
import { listDigisenseCompanies } from "./digisense-state";
import type { PeppolTransmitter, PeppolAccessPointConfig } from "../public-einvoice";

export type ResolveDigisenseTransmitter =
  | { ok: true; transmitter: PeppolTransmitter; companyKey: string }
  | { ok: false; errors: string[] };

/**
 * For Digisense ER access point'et Digisense selv: createDigisenseTransmitter
 * ignorerer accessPoint/receiverEndpointId helt og router på companyKey +
 * license-key. transmitPublicEInvoicePeppol kræver dog en ikke-tom access-point-
 * config (validateAccessPointConfig) OG udleder idempotency-nøglen af den.
 *
 * Hvis brugeren selv skulle opfinde disse felter, ville to afsendelser af SAMME
 * faktura med forskelligt-udfyldte dummy-felter give FORSKELLIGE idempotency-
 * nøgler — så `acknowledged`-fast-path'en ikke matcher og fakturaen leveres to
 * gange. Derfor syntetiserer vi en FAST, deterministisk identitet keyed på
 * companyKey: samme faktura + samme companyKey ⇒ samme idempotency-nøgle ⇒
 * gentaget transmit kollapser på den eksisterende acknowledged-række.
 */
export function digisenseAccessPointIdentity(companyKey: string): PeppolAccessPointConfig {
  const key = companyKey.trim();
  return {
    accessPointId: "digisense",
    endpointUrl: "digisense:access-point",
    senderEndpointId: key,
  };
}

/**
 * Bygger den rigtige Digisense-`PeppolTransmitter` for en virksomhed.
 *
 * companyKey vælges sådan:
 *   - `companyKey` angivet eksplicit ⇒ brug den (entydigt).
 *   - ellers: præcis ÉN registreret virksomhed i digisense_companies ⇒ brug
 *     dens companyKey.
 *   - ellers (nul, eller flere uden valg) ⇒ en tydelig fejl, så afsenderen
 *     aldrig leverer til en tilfældig companyKey.
 *
 * Returnerer et Result (ingen throw) så CLI/MCP kan vise en pæn fejl-envelope.
 */
export function resolveDigisenseTransmitter(
  db: Database,
  companyRoot: string,
  options: { companyKey?: string; ksefEnvironment?: KsefEnvironment } = {},
): ResolveDigisenseTransmitter {
  const secret = loadDigisenseSecretConfig(companyRoot);
  if (!secret) {
    return { ok: false, errors: [digisenseNotConfiguredError("sendes")] };
  }

  const companyKey = resolveCompanyKey(db, options.companyKey);
  if (!companyKey.ok) return { ok: false, errors: companyKey.errors };

  const client = createDigisenseClient({
    apiLicenseKey: secret.apiLicenseKey,
    environment: secret.environment,
  });

  // ksefEnvironment defaulter til miljøet fra secret-config'en (PRODUCTION/TEST)
  // hvis ikke eksplicit sat — så test-credentials aldrig rammer prod-routing.
  const ksefEnvironment =
    options.ksefEnvironment ?? (secret.environment === "production" ? "PRODUCTION" : "TEST");

  const transmitter = createDigisenseTransmitter(client, {
    companyKey: companyKey.value,
    ksefEnvironment,
  });
  return { ok: true, transmitter, companyKey: companyKey.value };
}

export type ResolveDigisenseReceiver =
  | { ok: true; client: DigisenseClient; downloader: DigisenseDocumentDownloader; companyKey: string }
  | { ok: false; errors: string[] };

/**
 * Bygger den rigtige Digisense-klient + XML-downloader til MODTAG-stien for en
 * virksomhed. Samme companyKey-valg som transmitteren: eksplicit angivet, eller
 * præcis ÉN registreret virksomhed, ellers en tydelig fejl.
 *
 * Rører rigtig config (license-key) + rigtig state (companyKey) men IKKE
 * netværket: HTTP-kald sker først når pollen kører. Unit-tests injicerer en fake
 * klient + downloader direkte i pollDigisenseReceived og rører aldrig denne fil.
 */
export function resolveDigisenseReceiver(
  db: Database,
  companyRoot: string,
  options: { companyKey?: string } = {},
): ResolveDigisenseReceiver {
  const secret = loadDigisenseSecretConfig(companyRoot);
  if (!secret) {
    return { ok: false, errors: [digisenseNotConfiguredError("modtages")] };
  }

  const companyKey = resolveCompanyKey(db, options.companyKey);
  if (!companyKey.ok) return { ok: false, errors: companyKey.errors };

  const client = createDigisenseClient({
    apiLicenseKey: secret.apiLicenseKey,
    environment: secret.environment,
  });
  return {
    ok: true,
    client,
    downloader: defaultDocumentDownloader(),
    companyKey: companyKey.value,
  };
}

export type ResolveDigisenseRegistrar =
  | { ok: true; client: DigisenseClient }
  | { ok: false; errors: string[] };

/**
 * Bygger den rigtige Digisense-klient til REGISTRÉR-stien for en virksomhed.
 *
 * Modsat send/modtag kræver registrering INGEN eksisterende companyKey — den
 * SKABER en — så her behøves kun secret-laget (license-key). companyKey'en
 * gemmes af registreringen selv (registerDigisenseCompany).
 *
 * Rører rigtig config (license-key) men IKKE netværket: HTTP-kald sker først når
 * registreringen kører. Unit-tests injicerer en fake klient direkte i
 * registerDigisenseCompany og rører aldrig denne fil.
 */
export function resolveDigisenseRegistrar(
  companyRoot: string,
): ResolveDigisenseRegistrar {
  const secret = loadDigisenseSecretConfig(companyRoot);
  if (!secret) {
    return { ok: false, errors: [digisenseNotConfiguredError("registreres en virksomhed til e-faktura")] };
  }
  const client = createDigisenseClient({
    apiLicenseKey: secret.apiLicenseKey,
    environment: secret.environment,
  });
  return { ok: true, client };
}

/**
 * Den fælles "ikke konfigureret"-fejl. Peger på den KONKRETE opskrift en agent
 * skal følge (kommandoen `efaktura konfigurer` / MCP-tool'et `efaktura_konfigurer`,
 * der skriver config/digisense.json med 0600), i stedet for den interne frase
 * "via secret-laget" — så konfigurations-precondition'en er opnåelig via
 * interfacet alene.
 */
function digisenseNotConfiguredError(action: string): string {
  return (
    `Digisense er ikke konfigureret: gem en API license-key først med ` +
    `\`rentemester efaktura konfigurer --company <path> --api-license-key <secret> ` +
    `--environment test|production\` (eller MCP-tool'et efaktura_konfigurer). Det skriver ` +
    `config/digisense.json (0600) før der kan ${action} e-fakturaer.`
  );
}

function resolveCompanyKey(
  db: Database,
  explicit: string | undefined,
): { ok: true; value: string } | { ok: false; errors: string[] } {
  const trimmed = explicit?.trim();
  if (trimmed) return { ok: true, value: trimmed };

  const companies = listDigisenseCompanies(db);
  if (companies.length === 1) {
    return { ok: true, value: companies[0]!.companyKey };
  }
  if (companies.length === 0) {
    return {
      ok: false,
      errors: [
        "Ingen Digisense-virksomhed er registreret (digisense_companies er tom). " +
          "Registrér virksomheden hos Digisense (register-company) før der sendes.",
      ],
    };
  }
  return {
    ok: false,
    errors: [
      `Flere Digisense-virksomheder er registreret (${companies.length}). ` +
        "Angiv hvilken companyKey der skal sendes fra med --digisense-company-key.",
    ],
  };
}
