/** Read-only bridge from approved workspace dispositions to one legal company's
 * liquidity forecast. The workspace lifecycle owns these records; this module
 * neither opens a ledger nor writes a disposition. */
import type { Database } from "bun:sqlite";
import { inspectIntercompanyDisposition } from "./intercompany-dispositions";
import type { ReviewedLiquiditySupplement } from "./liquidity-forecast";
import { isValidIsoDate } from "./dates";

export function reviewedIntercompanyLiquiditySupplements(
  control: Database,
  companySlug: string,
  companyId: number,
  startDate: string,
  endDate: string,
): ReviewedLiquiditySupplement[] {
  const ids = control.query(
    "SELECT disposition_id FROM rm_intercompany_dispositions ORDER BY disposition_id ASC",
  ).all() as Array<{ disposition_id: string }>;
  const out: ReviewedLiquiditySupplement[] = [];
  for (const row of ids) {
    const current = inspectIntercompanyDisposition(control, row.disposition_id);
    if (!current || !["approved", "partly_posted", "posted"].includes(current.status)) continue;
    const disposition = current.disposition;
    const side = disposition.left.companySlug === companySlug
      ? disposition.left
      : disposition.right.companySlug === companySlug
        ? disposition.right
        : null;
    if (!side) continue;
    const dueDate = disposition.settlementDueDate;
    if (!dueDate || !isValidIsoDate(dueDate) || dueDate < startDate || dueDate > endDate) continue;
    out.push({
      kind: "approved_intercompany_disposition",
      companyId,
      dueDate,
      amount: disposition.amount,
      // Preserve the reviewed native currency. The forecast core will surface
      // non-DKK dispositions as excluded until a dated FX source exists.
      currency: disposition.currency,
      direction: side.expectedSide === "receivable" ? "inflow" : "outflow",
      reference: `intercompany-disposition:${disposition.dispositionId}:${current.payloadHash}`,
      approvalReference: `intercompany-approved:${disposition.dispositionId}:${current.payloadHash}`,
    });
  }
  return out;
}
