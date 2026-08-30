/**
 * The HTTP route capability vocabulary is intentionally core-owned so both
 * server dispatch and workspace authorization can depend on it without a
 * core-to-server import cycle.
 */
export const ROUTE_PERMISSIONS = [
  "public.read",
  "public.invitation.claim",
  "workspace.read",
  "workspace.group.read",
  "workspace.manage",
  "workspace.members.read",
  "workspace.members.manage",
  "company.read",
  "company.documents.read",
  "company.documents.upload",
  "company.master-data",
  "company.draft.write",
  "company.ledger.post",
  "company.review",
  "company.period.force-close",
  "company.export",
  "company.external-lookup",
  "company.external-send",
  "company.admin",
  "company.knowledge.read",
  "company.knowledge.manage",
] as const;

export type RoutePermission = typeof ROUTE_PERMISSIONS[number];
