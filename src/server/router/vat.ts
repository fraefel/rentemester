// VAT read handler.

import type { ServerConfig } from "../config";
import { buildCompanyVat, resolveAsOfDate, resolveYearParam } from "../data";
import { okResponse } from "./_shared";

export function handleCompanyVat(
  config: ServerConfig,
  slug: string,
  url: URL,
): Response {
  const asOfDate = resolveAsOfDate(url.searchParams.get("asOf"));
  // An explicit snapshot is authoritative: without `year`, its calendar year
  // determines the canonical filing period rather than the server wall clock.
  const year = resolveYearParam(url.searchParams.get("year")) ?? Number(asOfDate.slice(0, 4));
  const data = buildCompanyVat(config.workspaceRoot, slug, year, asOfDate);
  return okResponse({ vat: data });
}
