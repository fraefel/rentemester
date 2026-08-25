import { request } from "./_shared";

const path = (slug: string, suffix = "") => `/api/companies/${encodeURIComponent(slug)}/posting-rules${suffix}`;
export type PostingRule = { ruleId: string; version: number; payloadHash: string; provenance: string; rationale: string; createdBy: string; createdAt: string };
export const postingRulesApi = {
  postingRules: (slug: string) => request<{ ok: true; postingRules: PostingRule[] }>(path(slug)).then((x) => x.postingRules),
  explainPostingRule: (slug: string, context: Record<string, unknown>) => request<{ ok: true; dryRun: true; evaluation: unknown }>(path(slug, "/explain"), { method: "POST", body: JSON.stringify({ context }) }),
  mutatePostingRule: (slug: string, action: "propose" | "approve" | "disable" | "supersede", body: Record<string, unknown>) => request<{ ok: true; postingRule: unknown }>(path(slug, `/${action}`), { method: "POST", body: JSON.stringify({ ...body, confirm: true }) }),
};
