#!/usr/bin/env bun
/** Deterministic #585 gate over the actual runtime registries. */
import { MUTATING_COMMANDS } from "./cli-actor";
import { COMMAND_SPECS, SIDE_EFFECTING_COMMANDS } from "./cli-meta";
import { registerAllTools } from "./mcp/registry";
import { ROUTE_CATALOG } from "./server/router";
import {
  validateAgentDiscoveryCoverage,
  type LiveTool,
} from "./agent-discovery-catalog";

const tools: LiveTool[] = [];
const recorder = {
  registerTool(name: string, config: { annotations?: LiveTool["annotations"] }) {
    tools.push({ name, annotations: config.annotations });
  },
};
registerAllTools(recorder as never);

const report = validateAgentDiscoveryCoverage({
  tools,
  commands: COMMAND_SPECS.map((command) => ({
    key: command.key,
    allowedFlags: command.allowedFlags,
    mutating: MUTATING_COMMANDS.has(command.key),
    sideEffecting: SIDE_EFFECTING_COMMANDS.has(command.key),
  })),
  routes: ROUTE_CATALOG,
  imageDigest: process.env.RENTEMESTER_AGENT_DISCOVERY_IMAGE_DIGEST ?? null,
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) {
  for (const error of report.errors) console.error(`agent-discovery coverage: ${error}`);
  process.exit(1);
}
