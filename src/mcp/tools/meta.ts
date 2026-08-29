/**
 * MCP-tool: `meta_about` (read).
 *
 * Server-wide identification + contract-doc pointers. An agent that
 * connects to the MCP server at runtime cannot otherwise discover:
 *   - the server name + version,
 *   - the live registered tool count (the docs may have drifted),
 *   - the current rules-bundle version (matters for posting outputs),
 *   - the canonical contract-doc URIs (so the agent can fetch them).
 *
 * Calling this tool costs nothing — no ledger access, no company arg.
 *
 * Klassifikation: `read` — ingen state-bivirkninger. Ingen `confirm`
 * og ingen `company`-parameter.
 *
 * (Round-2 review, Batch F-2.)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PRODUCT_VERSION } from "../../core/build-identity";
import { currentRuleBundleVersion } from "../../core/rules-metadata";
import { envelopeShape, successEnvelope } from "../envelope";
import { envelopeToCallResult } from "../envelope";
import { getBuildIdentity } from "../../core/build-identity";
import { getReleaseProvenance } from "../../core/release-provenance";
import { catalogueIdentity, type LiveTool } from "../../agent-discovery-catalog";

const CONTRACT_DOCS = [
  "docs/mcp-agent-contract.md",
  "docs/mcp-tool-surface.md",
  "docs/confirm-contract.md",
  "docs/cli-contract.md",
] as const;

// Do not import these from ../server: registry -> meta -> server -> registry
// makes the stdio entrypoint register tools while this module is still in its
// temporal dead zone. Keeping the immutable identity beside its consumer
// breaks that initialization cycle.
const MCP_SERVER_NAME = "rentemester-mcp";
const MCP_SERVER_VERSION = PRODUCT_VERSION;

export function registerMetaTools(server: McpServer, liveTools: () => readonly LiveTool[]): void {
  server.registerTool(
    "meta_about",
    {
      title: "Server identification and contract pointers",
      description:
        "Returnerer server-navn, server-version, antallet af registrerede MCP-tools " +
        "i denne kørende proces, den aktuelle rules-bundle-version, og repo-relative " +
        "stier til kontrakt-dokumenterne. Bruges af en agent der lige har connectet " +
        "til serveren og vil verificere identitet/version før den begynder at kalde " +
        "andre tools. Read-only, idempotent, ingen `company`-parameter.\n\n" +
        "envelope.data: { serverName, serverVersion, toolCount, ruleBundleVersion, " +
        "contractDocs: string[] }. Brug `contractDocs`-stierne til at fetche de fulde " +
        "kontrakt-dokumenter via det filesystem-aware adapter agenten kører i.",
      inputSchema: {},
      outputSchema: envelopeShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const toolCount = liveTools().length;
      const ruleBundleVersion = (() => {
        try {
          return currentRuleBundleVersion();
        } catch {
          return null;
        }
      })();
      const envelope = successEnvelope({
        serverName: MCP_SERVER_NAME,
        serverVersion: MCP_SERVER_VERSION,
        build: getBuildIdentity(),
        provenance: getReleaseProvenance(),
        toolCount,
        ruleBundleVersion,
        contractDocs: Array.from(CONTRACT_DOCS),
        catalogue: catalogueIdentity(),
      });
      return envelopeToCallResult(envelope);
    },
  );
}
