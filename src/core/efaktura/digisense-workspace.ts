/** Workspace inbound polling: manifest entries are the authority, never caller keys/credentials. */
import { existsSync } from "node:fs";
import { openDb, migrate } from "../db";
import { companyPaths } from "../paths";
import { listWorkspaceCompanies, companyRootForSlug } from "../workspace";
import { resolveDigisenseReceiver } from "./digisense-wiring";
import { pollDigisenseReceived } from "./digisense-receive";

export type WorkspaceDigisensePollResult = {
  ok: true;
  companies: Array<{ slug: string; status: "polled" | "skipped" | "failed"; reason?: string; documentsIngested?: number }>;
};

/** Continues after every company failure; archived and unconfigured companies are skipped. */
export async function pollWorkspaceDigisenseInbound(workspaceRoot: string): Promise<WorkspaceDigisensePollResult> {
  const companies: WorkspaceDigisensePollResult["companies"] = [];
  for (const entry of listWorkspaceCompanies(workspaceRoot)) {
    if (entry.archived) { companies.push({ slug: entry.slug, status: "skipped", reason: "archived" }); continue; }
    const root = companyRootForSlug(workspaceRoot, entry.slug);
    if (!existsSync(companyPaths(root).db)) { companies.push({ slug: entry.slug, status: "skipped", reason: "not initialized" }); continue; }
    const db = openDb(companyPaths(root).db);
    try {
      migrate(db);
      const resolved = resolveDigisenseReceiver(db, root);
      if (!resolved.ok) { companies.push({ slug: entry.slug, status: "skipped", reason: resolved.errors.join(" ") }); continue; }
      const result = await pollDigisenseReceived(db, root, resolved.client, resolved.downloader, { companyKey: resolved.companyKey });
      companies.push(result.ok ? { slug: entry.slug, status: "polled", documentsIngested: result.documentsIngested } : { slug: entry.slug, status: "failed", reason: result.errors.join(" ") });
    } catch (error) { companies.push({ slug: entry.slug, status: "failed", reason: error instanceof Error ? error.message : String(error) }); }
    finally { db.close(); }
  }
  return { ok: true, companies };
}
