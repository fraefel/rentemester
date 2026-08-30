/**
 * Test-only adapter for legacy fixtures that exercise a downstream period
 * effect (posting locks, annual reports, VAT, …).  Product callers must use
 * the explicit readiness -> review -> close workflow.  These older fixtures
 * used the core close function directly, so this adapter makes that workflow
 * explicit without weakening the production contract.
 */
import type { Database } from "bun:sqlite";
import { seedNativeAccountRoles } from "../../src/core/account-roles";
import { computePeriodCloseReadiness, reviewPeriodCloseReadiness } from "../../src/core/period-close-readiness";
import {
  closeAccountingPeriod as closeCore,
  type CloseAccountingPeriodInput,
  type CloseAccountingPeriodResult,
} from "../../src/core/periods";

export function closeAccountingPeriod(
  db: Database,
  input: CloseAccountingPeriodInput,
): CloseAccountingPeriodResult {
  // Direct DB fixtures historically called only seedAccounts. The normal
  // company initialization supplies these role mappings; provide that same
  // synthetic prerequisite before evaluating the close controls.
  seedNativeAccountRoles(db);
  const periodStart = input.periodStart ?? "";
  const periodEnd = input.periodEnd ?? "";
  const actor = input.createdBy?.trim() || "agent:test";
  const packet = computePeriodCloseReadiness(db, {
    periodStart,
    periodEnd,
    companyRoot: input.companyRoot,
  });
  const review = reviewPeriodCloseReadiness(db, {
    packet,
    reviewerActor: actor,
    reviewerPrincipal: { kind: "local-trusted", subjectId: actor },
  });
  return closeCore(db, {
    ...input,
    createdBy: actor,
    readinessPacketHash: packet.hash,
    readinessReviewId: review.id,
    ...(input.force && !input.forceAuthorization
      ? {
          forceAuthorization: {
            principal: { kind: "local-trusted" as const, subjectId: actor },
            permissions: ["company.period.force-close"],
          },
          forceConfirmed: true,
          forceReason: input.forceReason ?? "synthetic test waiver",
        }
      : {}),
  });
}
