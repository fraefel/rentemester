// Digisense secret-lag (#efaktura) — API license-key opbevaring.
//
// API license-key er ÉN nøgle for hele Digisense-licensen og er et SECRET: den
// lever ALDRIG i ledger-DB'en (append-only state), kun i en JSON-fil i
// virksomhedens config-mappe (`<companyRoot>/config/digisense.json`) med 0600-
// rettigheder. Samme trust-boundary og fil-mønster som IMAP-credentials i
// bilagsmail.ts og access-point credentials i public-einvoice.ts.
//
// `.gitignore` dækker `**/config/digisense.json`, så nøglen aldrig staged ved
// et uheld (samme SEC-12-beskyttelse som imap.json/policy.yaml).
//
// companyKey↔virksomhed + participant-state er IKKE secret og bor i ledgeren —
// se digisense-state.ts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-file";
import type { DigisenseEnvironment } from "./digisense-client";

export type DigisenseSecretConfig = {
  /** API license-key — én nøgle for hele licensen. Aldrig i ledgeren. */
  apiLicenseKey: string;
  /** prod/test base-URL switch. Default 'test' når udeladt ved skrivning. */
  environment: DigisenseEnvironment;
};

function digisenseConfigPath(companyRoot: string): string {
  return join(companyRoot, "config", "digisense.json");
}

function ensureConfigDir(companyRoot: string): void {
  mkdirSync(join(companyRoot, "config"), { recursive: true });
}

export function loadDigisenseSecretConfig(
  companyRoot: string,
): DigisenseSecretConfig | null {
  const path = digisenseConfigPath(companyRoot);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as DigisenseSecretConfig;
}

export function saveDigisenseSecretConfig(
  companyRoot: string,
  config: DigisenseSecretConfig,
): { path: string } {
  if (!config.apiLicenseKey?.trim()) {
    throw new Error("digisense config: apiLicenseKey is required");
  }
  if (config.environment !== "production" && config.environment !== "test") {
    throw new Error("digisense config: environment must be 'production' or 'test'");
  }
  ensureConfigDir(companyRoot);
  const path = digisenseConfigPath(companyRoot);
  const normalized: DigisenseSecretConfig = {
    apiLicenseKey: config.apiLicenseKey.trim(),
    environment: config.environment,
  };
  // SEC-11/SEC-12: skriv atomisk via en frisk 0600 temp-fil + rename, så
  // license-key'en aldrig rammer en world-readable inode (samme mønster som
  // imap.json og backup-nøglerne).
  writeFileAtomic(path, JSON.stringify(normalized, null, 2));
  return { path };
}

export function deleteDigisenseSecretConfig(companyRoot: string): boolean {
  const path = digisenseConfigPath(companyRoot);
  if (!existsSync(path)) return false;
  // Overskriv først for at obliterere license-key'en før unlink.
  writeFileSync(path, "{}\n");
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    fs.unlinkSync(path);
    return true;
  } catch {
    return true;
  }
}
