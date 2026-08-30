import { afterEach, describe, expect, test, vi } from "bun:test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fixtures";
import { restoreGlobals, stubGlobal } from "../test/globals";
import { renderAt } from "../test/render";
import { WorkspaceRegistryView } from "./WorkspaceRegistryView";

const parties = { rows: [{ partyId: "party-visible", name: "Visible supplier", kind: "organisation", roles: [{ companySlug: "synthetic-company", role: "vendor" }] }], count: 1, nextCursor: null };
const records = { rows: [{ recordId: "record-visible", filename: "articles.pdf", type: "articles", sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", sensitivity: "normal" }], count: 1, nextCursor: null };
afterEach(() => restoreGlobals());

describe("WorkspaceRegistryView", () => {
  test("shows loading, then the empty registry", async () => {
    mockFetch({ "GET /api/companies/synthetic-company/workspace-parties": { rows: [], count: 0, nextCursor: null }, "GET /api/companies/synthetic-company/corporate-records": { rows: [], count: 0, nextCursor: null }, "GET /api/companies/synthetic-company/knowledge": { context:{assertions:[],conflicts:[]} } });
    renderAt(<WorkspaceRegistryView />, { route: "/virksomheder/synthetic-company/workspace-register", path: "/virksomheder/:slug/workspace-register" });
    expect(screen.getByText("Henter workspace-register…")).toBeInTheDocument();
    expect(await screen.findByText("Ingen synlige parter endnu.")).toBeInTheDocument();
    expect(screen.getByText("Ingen synlige governance-records endnu.")).toBeInTheDocument();
  });

  test("shows a fetch error", async () => {
    mockFetch({ "GET /api/companies/synthetic-company/workspace-parties": { __error: { code: "forbidden", message: "Ingen adgang" } }, "GET /api/companies/synthetic-company/corporate-records": records });
    renderAt(<WorkspaceRegistryView />, { route: "/virksomheder/synthetic-company/workspace-register", path: "/virksomheder/:slug/workspace-register" });
    expect(await screen.findByText("Ingen adgang")).toBeInTheDocument();
  });

  test("lists visible data and refreshes it through the compact action", async () => {
    let calls = 0;
    stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls += 1;
      const path = String(input).split("?")[0];
      const payload = path.endsWith("corporate-records") ? records : calls > 2 ? { ...parties, rows: [{ ...parties.rows[0], name: "Refreshed supplier" }] } : parties;
      return new Response(JSON.stringify({ ok: true, ...payload }), { headers: { "content-type": "application/json" } });
    }));
    renderAt(<WorkspaceRegistryView />, { route: "/virksomheder/synthetic-company/workspace-register", path: "/virksomheder/:slug/workspace-register" });
    expect(await screen.findByText("Visible supplier")).toBeInTheDocument();
    expect(screen.getByText("articles.pdf")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Opdater" }));
    expect(await screen.findByText("Refreshed supplier")).toBeInTheDocument();
  });
});
