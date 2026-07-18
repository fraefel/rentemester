/**
 * MCP tools for GDPR operations (#184, #353, #355).
 *
 * Exposes the deterministic GDPR core to AI agents:
 *  - `gdpr_discover` — find subject records + append an attributed audit event
 *  - `gdpr_export`   — build a DSAR + append an attributed audit event
 *  - `gdpr_audit_log` — read/export the GDPR audit trail, optionally signed
 *
 * Erasure (`gdpr_erase`) is intentionally NOT exposed as an MCP tool.
 * The build-loop contract and the core's design both require an explicit
 * human acknowledgement (`--after-retention-expiry`) before redacting
 * personal data. An AI agent must not run erasure autonomously — the
 * CLI `gdpr forget` command with its mandatory flag is the right path.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findGdprSubject, buildGdprSubjectExport, buildGdprAuditExport } from "../../core/gdpr";
import { envelopeShape, wrapCoreResult } from "../envelope";
import {
  confirmField,
  withCompanyDb,
  withCompanyDbConfirmed,
} from "../tool-runtime";

export function registerGdprTools(server: McpServer): void {
  // ---- gdpr_discover (write-irreversible: appends audit_log) ----
  server.registerTool(
    "gdpr_discover",
    {
      title: "GDPR subject discovery",
      description:
        "Find alle rækker i Rentemester der indeholder persondata om en given " +
        "registreret (kunde, leverandør, banktransaktion). Selve subject-data " +
        "læses kun, men hvert opslag append-only audit-logges med MCP-actor og " +
        "kræver derfor confirm:true. write-irreversible.",
      inputSchema: {
        company: z.string().min(1),
        cvr: z.string().optional().describe("CVR / VAT-nummer for den registrerede"),
        name: z.string().optional().describe("Navn på den registrerede (bruges hvis CVR ikke er kendt)"),
        confirm: confirmField,
      },
      outputSchema: envelopeShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      cvr?: string;
      name?: string;
      confirm?: boolean;
    }>(server, "gdpr_discover", ({ db, actor, args }) =>
      wrapCoreResult(
        findGdprSubject(
          db,
          { cvr: args.cvr, name: args.name },
          {
            createdBy: actor.createdBy,
            createdByProgram: actor.createdByProgram,
          },
        ),
      )),
  );

  // ---- gdpr_export (write-irreversible: appends audit_log) ----
  server.registerTool(
    "gdpr_export",
    {
      title: "GDPR data-subject export",
      description:
        "Byg en komplet indsigtsrapport for en registreret: alle persondata " +
        "Rentemester opbevarer, annoteret med opbevaringsfrister og eventuelle " +
        "tidligere sletninger. Svarer til en data-subject access request (DSAR). " +
        "Eksporten append-only audit-logges med MCP-actor og kræver confirm:true. " +
        "write-irreversible.",
      inputSchema: {
        company: z.string().min(1),
        cvr: z.string().optional().describe("CVR / VAT-nummer for den registrerede"),
        name: z.string().optional().describe("Navn på den registrerede"),
        asOf: z.string().optional().describe("Evalueringsdato (ISO). Default: dags dato"),
        confirm: confirmField,
      },
      outputSchema: envelopeShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      cvr?: string;
      name?: string;
      asOf?: string;
      confirm?: boolean;
    }>(server, "gdpr_export", ({ db, actor, args }) =>
      wrapCoreResult(
        buildGdprSubjectExport(
          db,
          { cvr: args.cvr, name: args.name, asOf: args.asOf },
          {
            createdBy: actor.createdBy,
            createdByProgram: actor.createdByProgram,
          },
        ),
      )),
  );

  // ---- gdpr_audit_log (read-only) ----
  server.registerTool(
    "gdpr_audit_log",
    {
      title: "GDPR audit log export",
      description:
        "Eksportér alle GDPR-relaterede hændelser fra audit-loggen " +
        "(discover, export, erasure). Kan filtreres på datointerval. " +
        "Bruges til dokumentation overfor Datatilsynet.",
      inputSchema: {
        company: z.string().min(1),
        since: z.string().optional().describe("Fra-dato (ISO) — kun hændelser efter denne dato"),
        until: z.string().optional().describe("Til-dato (ISO) — kun hændelser før denne dato"),
        asOf: z.string().optional().describe("Evalueringsdato (ISO). Default: dags dato"),
        signWithEd25519: z
          .boolean()
          .optional()
          .describe("Signér eksporten med virksomhedens eksisterende backup-Ed25519-nøgle."),
      },
      outputSchema: envelopeShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    withCompanyDb<{
      company: string;
      since?: string;
      until?: string;
      asOf?: string;
      signWithEd25519?: boolean;
    }>(server, ({ db, args }) => {
      const result = buildGdprAuditExport(db, {
        since: args.since,
        until: args.until,
        asOf: args.asOf,
        signWithEd25519: args.signWithEd25519,
        companyRoot: args.company,
      });
      return wrapCoreResult(result);
    }),
  );
}
