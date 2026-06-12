// #UI-4 — the sub-navigation must thread ONLY the fiscal year between views, so
// per-view filters (Bank's q/from/to/status, a posting account=…) never leak
// onto sibling tabs.

import { describe, expect, test } from "vitest";
import { screen } from "@testing-library/react";
import { CompanyNav } from "./CompanyNav";
import { renderAt } from "../test/render";

function renderNav(route: string) {
  return renderAt(
    <CompanyNav
      slug="acme-aps"
      years={[
        { label: "2026", start: "2026-01-01", end: "2026-12-31", source: "live" },
      ]}
      selectedYear="2026"
      onYearChange={() => {}}
    />,
    { route, path: "*" },
  );
}

describe("CompanyNav query-string whitelist (#UI-4)", () => {
  test("threads ?year= onto every tab link", () => {
    renderNav("/companies/acme-aps/bank?year=2025");
    const overblik = screen.getByRole("link", { name: "Overblik" });
    expect(overblik.getAttribute("href")).toBe("/companies/acme-aps?year=2025");
    const moms = screen.getByRole("link", { name: "Moms" });
    expect(moms.getAttribute("href")).toBe(
      "/companies/acme-aps/moms?year=2025",
    );
  });

  test("does NOT leak per-view filters (q/from/to/status/account) to sibling tabs", () => {
    renderNav(
      "/companies/acme-aps/bank?year=2025&q=netto&from=2025-01-01&to=2025-03-31&status=unmatched",
    );
    const postings = screen.getByRole("link", { name: "Posteringer" });
    const href = postings.getAttribute("href") ?? "";
    expect(href).toBe("/companies/acme-aps/posteringer?year=2025");
    expect(href).not.toMatch(/q=/);
    expect(href).not.toMatch(/from=/);
    expect(href).not.toMatch(/status=/);
  });

  test("omits the query string entirely when no year is set", () => {
    renderNav("/companies/acme-aps/bank?q=netto");
    const overblik = screen.getByRole("link", { name: "Overblik" });
    expect(overblik.getAttribute("href")).toBe("/companies/acme-aps");
  });
});
