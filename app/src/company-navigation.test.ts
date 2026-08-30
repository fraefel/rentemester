import { describe, expect, test } from "bun:test";
import {
  COMPANY_ROUTE_DEFINITIONS,
  COMPANY_TASK_AREAS,
  assertCompanyRouteCoverage,
  companyRouteForPath,
} from "./company-navigation";

describe("company navigation catalogue", () => {
  test("classifies each registered company route once in all six task areas", () => {
    expect(COMPANY_TASK_AREAS).toHaveLength(6);
    expect(new Set(COMPANY_ROUTE_DEFINITIONS.map((route) => route.id)).size)
      .toBe(COMPANY_ROUTE_DEFINITIONS.length);
    expect(new Set(COMPANY_ROUTE_DEFINITIONS.map((route) => route.segment)).size)
      .toBe(COMPANY_ROUTE_DEFINITIONS.length);
    assertCompanyRouteCoverage(COMPANY_ROUTE_DEFINITIONS.map((route) => route.id));
  });

  test("fails closed when a registered route is missing or duplicated", () => {
    const ids = COMPANY_ROUTE_DEFINITIONS.map((route) => route.id);
    expect(() => assertCompanyRouteCoverage(ids.slice(1))).toThrow("missing=dashboard");
    expect(() => assertCompanyRouteCoverage([...ids, ids[0]])).toThrow("duplicates=");
  });

  test("resolves deep links without considering their query string", () => {
    expect(companyRouteForPath("/companies/acme-aps/bank")?.id).toBe("bank");
    expect(companyRouteForPath("/companies/acme-aps")?.id).toBe("dashboard");
  });

  test("does not treat the company creation route as a company dashboard", () => {
    expect(companyRouteForPath("/companies/new")).toBeUndefined();
  });

  test("fails review when App registers a raw company route outside the catalogue", async () => {
    const appSource = await Bun.file(new URL("./App.tsx", import.meta.url)).text();
    expect(appSource).not.toMatch(/path\s*=\s*["'`]\/companies\/:slug/);
  });
});
