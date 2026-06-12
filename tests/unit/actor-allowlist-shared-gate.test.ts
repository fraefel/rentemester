/**
 * Audit 2026-06-11 SEC-2 + SEC-3: the actor allowlist must be a SHARED gate.
 *
 * SEC-2: enforcement lived only in the CLI (`enforceMutationActorPolicy`).
 *        The extracted, transport-agnostic core `checkActorAllowlist` is what
 *        the MCP write path now calls too, so a confirmed MCP write is held
 *        to the same allowlist as a CLI write.
 *
 * SEC-3: an EMPTY allowlist (no `config/policy.yaml`) used to accept ANY
 *        actor — including an explicit `user:<human>`. That is fail-OPEN.
 *        We now fail CLOSED: a `user:` actor against an absent policy is
 *        rejected. Onboarding (`init` / `company add`) seeds the allowlist,
 *        so a real single-user is unaffected.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkActorAllowlist } from "../../src/cli-actor";
import { companyPaths, ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { registerCustomerTools } from "../../src/mcp/tools/customer";

async function withTempRoot(run: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rentemester-shared-gate-"));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function seedPolicy(root: string, body: string): void {
  const configDir = companyPaths(root).config;
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "policy.yaml"), body, "utf8");
}

const POLICY_WITH = (actor: string) =>
  `actor_allowlist:\n  users:\n    - ${actor}\n  agents:\n    - agent:rentemester-bookkeeper\n  systems:\n    - system:rentemester\n`;

describe("SEC-2: checkActorAllowlist is the shared core gate", () => {
  test("an allowlisted actor is allowed", async () => {
    await withTempRoot((root) => {
      seedPolicy(root, POLICY_WITH("user:mikkel"));
      expect(checkActorAllowlist(root, "user:mikkel")).toEqual({ allowed: true });
    });
  });

  test("an allowlisted MCP agent id is allowed", async () => {
    await withTempRoot((root) => {
      seedPolicy(root, POLICY_WITH("user:mikkel"));
      expect(checkActorAllowlist(root, "agent:rentemester-bookkeeper").allowed).toBe(true);
    });
  });

  test("a non-allowlisted actor is rejected with a hint", async () => {
    await withTempRoot((root) => {
      seedPolicy(root, POLICY_WITH("user:mikkel"));
      const result = checkActorAllowlist(root, "agent:claude-code/9.9.9");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("actor_allowlist");
    });
  });
});

describe("SEC-2: MCP confirmed write passes the shared allowlist gate", () => {
  function initCompany(root: string): void {
    const paths = ensureCompanyDirs(root);
    const db = openDb(paths.db);
    migrate(db);
    db.close();
  }

  /** Builds an MCP server with a simulated client handshake. */
  function harness(root: string, clientName: string, clientVersion: string) {
    const server = new McpServer({ name: "gate-test", version: "0.0.0" });
    (server.server as any)._clientVersion = { name: clientName, version: clientVersion };
    registerCustomerTools(server);
    const tools = (server as any)._registeredTools as Record<
      string,
      { handler: (a: unknown, e: unknown) => Promise<{ structuredContent: unknown }> }
    >;
    return async (name: string, args: unknown) => {
      const res = await tools[name]!.handler(args, { signal: new AbortController().signal });
      return res.structuredContent as { ok: boolean; errors?: any[] };
    };
  }

  test("a non-allowlisted MCP agent is rejected on a confirmed write", async () => {
    await withTempRoot(async (root) => {
      initCompany(root);
      // Policy allows a DIFFERENT agent, so claude-code/9.9.9 is not allowed.
      seedPolicy(root, POLICY_WITH("user:mikkel"));
      const call = harness(root, "claude-code", "9.9.9");
      const env = await call("customer_create", {
        company: root,
        input: { name: "ACME" },
        confirm: true,
      });
      expect(env.ok).toBe(false);
      expect(JSON.stringify(env.errors ?? [])).toContain("actor_allowlist");
    });
  });

  test("an allowlisted MCP agent passes the gate and performs the write", async () => {
    await withTempRoot(async (root) => {
      initCompany(root);
      seedPolicy(
        root,
        `actor_allowlist:\n  users:\n    - user:mikkel\n  agents:\n    - agent:claude-code/9.9.9\n  systems:\n    - system:rentemester\n`,
      );
      const call = harness(root, "claude-code", "9.9.9");
      const env = await call("customer_create", {
        company: root,
        input: { name: "ACME" },
        confirm: true,
      });
      expect(env.ok).toBe(true);
    });
  });
});

describe("SEC-3: empty allowlist fails closed for user: actors", () => {
  test("an explicit user: actor against an absent policy is rejected", async () => {
    await withTempRoot((root) => {
      const result = checkActorAllowlist(root, "user:eve");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("policy.yaml");
    });
  });

  test("agent:/system: actors pass an absent policy (bootstrap), user: does not", async () => {
    await withTempRoot((root) => {
      // Machine identities are allowed through an empty allowlist so the
      // build-phase MCP transport and onboarding bootstrap still work; only
      // human (`user:`) authorship is fail-closed against a policy-less company.
      expect(checkActorAllowlist(root, "agent:some-agent").allowed).toBe(true);
      expect(checkActorAllowlist(root, "system:foo").allowed).toBe(true);
      expect(checkActorAllowlist(root, "user:eve").allowed).toBe(false);
    });
  });
});
