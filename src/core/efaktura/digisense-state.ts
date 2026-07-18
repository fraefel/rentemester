// Digisense state-lag (#efaktura) — companyKey↔virksomhed + participant-state.
//
// Dette er IKKE secret-data (license-key bor i config/digisense.json, se
// digisense-config.ts). companyKey'en scoper næsten alle API-kald og er
// almindelig registrerings-state, så den bor i ledger-DB'en.
//
// Modsat de append-only audit-tabeller (peppol_submissions m.fl.) er
// registrerings-state MUTABEL: en participant kan af-/genregistreres og
// webhook-status kan ændre sig, så tabellerne har INGEN append-only triggers
// (samme valg som companies/customers). Skemaet defineres i schema.sql og
// sikres idempotent i migrate() (src/core/db.ts).

import type { Database } from "bun:sqlite";
import type {
  DigisenseCompanyType,
  DigisenseNetwork,
  ParticipantDirection,
  ParticipantType,
} from "./digisense-client";

// ============================================================================
// companyKey ↔ virksomhed
// ============================================================================

export type DigisenseCompanyState = {
  companyKey: string;
  companyType: DigisenseCompanyType["type"];
  participantId: string;
  companyName: string;
  registeredAt: string;
};

type DigisenseCompanyRow = {
  company_key: string;
  company_type: string;
  participant_id: string;
  company_name: string;
  registered_at: string;
};

/**
 * Gemmer (eller opdaterer) companyKey↔virksomhed efter register-company.
 * Keyed på participant-id (ét CVR/NIP per virksomhed) så en genregistrering
 * opdaterer companyKey'en i stedet for at duplikere rækken.
 */
export function saveDigisenseCompany(
  db: Database,
  input: {
    companyKey: string;
    companyType: DigisenseCompanyType;
    companyName: string;
  },
): void {
  if (!input.companyKey?.trim()) {
    throw new Error("digisense state: companyKey is required");
  }
  db.run(
    `INSERT INTO digisense_companies (company_key, company_type, participant_id, company_name)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(participant_id) DO UPDATE SET
       company_key = excluded.company_key,
       company_type = excluded.company_type,
       company_name = excluded.company_name`,
    [input.companyKey.trim(), input.companyType.type, input.companyType.id, input.companyName],
  );
}

export function getDigisenseCompanyByParticipantId(
  db: Database,
  participantId: string,
): DigisenseCompanyState | null {
  const row = db
    .query(
      `SELECT company_key, company_type, participant_id, company_name, registered_at
       FROM digisense_companies WHERE participant_id = ? LIMIT 1`,
    )
    .get(participantId) as DigisenseCompanyRow | null;
  return row ? rowToCompanyState(row) : null;
}

export function listDigisenseCompanies(db: Database): DigisenseCompanyState[] {
  const rows = db
    .query(
      `SELECT company_key, company_type, participant_id, company_name, registered_at
       FROM digisense_companies ORDER BY id`,
    )
    .all() as DigisenseCompanyRow[];
  return rows.map(rowToCompanyState);
}

function rowToCompanyState(row: DigisenseCompanyRow): DigisenseCompanyState {
  return {
    companyKey: row.company_key,
    companyType: row.company_type as DigisenseCompanyType["type"],
    participantId: row.participant_id,
    companyName: row.company_name,
    registeredAt: row.registered_at,
  };
}

// ============================================================================
// Participant-state (direction × network pr. companyKey)
// ============================================================================

export type DigisenseParticipantState = {
  companyKey: string;
  network: DigisenseNetwork;
  direction: ParticipantDirection;
  participantType: ParticipantType;
  participantId: string;
  webhookUrl: string | null;
  registeredOnNetwork: boolean;
  webhookRegistered: boolean;
  registeredAt: string;
};

type DigisenseParticipantRow = {
  company_key: string;
  network: string;
  direction: string;
  participant_type: string;
  participant_id: string;
  webhook_url: string | null;
  registered_on_network: number;
  webhook_registered: number;
  registered_at: string;
};

/**
 * Gemmer (eller opdaterer) en participant-registrering efter
 * register-participant/{network}. Keyed på (companyKey, network, direction):
 * for BÅDE send og modtag registreres et CVR som outbound OG inbound, så de to
 * retninger er separate rækker.
 */
export function saveDigisenseParticipant(
  db: Database,
  input: {
    companyKey: string;
    network: DigisenseNetwork;
    direction: ParticipantDirection;
    participantType: ParticipantType;
    participantId: string;
    webhookUrl: string | null;
    registeredOnNetwork: boolean;
    webhookRegistered: boolean;
  },
): void {
  if (!input.companyKey?.trim()) {
    throw new Error("digisense state: companyKey is required");
  }
  db.run(
    `INSERT INTO digisense_participants
       (company_key, network, direction, participant_type, participant_id,
        webhook_url, registered_on_network, webhook_registered)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(company_key, network, direction) DO UPDATE SET
       participant_type = excluded.participant_type,
       participant_id = excluded.participant_id,
       webhook_url = excluded.webhook_url,
       registered_on_network = excluded.registered_on_network,
       webhook_registered = excluded.webhook_registered`,
    [
      input.companyKey.trim(),
      input.network,
      input.direction,
      input.participantType,
      input.participantId,
      input.webhookUrl,
      input.registeredOnNetwork ? 1 : 0,
      input.webhookRegistered ? 1 : 0,
    ],
  );
}

export function listDigisenseParticipants(
  db: Database,
  companyKey: string,
): DigisenseParticipantState[] {
  const rows = db
    .query(
      `SELECT company_key, network, direction, participant_type, participant_id,
              webhook_url, registered_on_network, webhook_registered, registered_at
       FROM digisense_participants WHERE company_key = ? ORDER BY id`,
    )
    .all(companyKey) as DigisenseParticipantRow[];
  return rows.map(rowToParticipantState);
}

function rowToParticipantState(
  row: DigisenseParticipantRow,
): DigisenseParticipantState {
  return {
    companyKey: row.company_key,
    network: row.network as DigisenseNetwork,
    direction: row.direction as ParticipantDirection,
    participantType: row.participant_type as ParticipantType,
    participantId: row.participant_id,
    webhookUrl: row.webhook_url,
    registeredOnNetwork: row.registered_on_network === 1,
    webhookRegistered: row.webhook_registered === 1,
    registeredAt: row.registered_at,
  };
}
