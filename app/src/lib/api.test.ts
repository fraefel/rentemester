import { describe, expect, test } from "bun:test";
import { api, ApiError } from "./api";
import { dashboard, mockFetch, summary } from "../test/fixtures";

describe("api client", () => {
  test("unwraps a successful portfolio response", async () => {
    mockFetch({
      "GET /api/portfolio": {
        portfolio: {
          workspace: "/ws",
          asOf: "2026-05-20",
          companyCount: 1,
          totals: {},
          companies: [summary()],
        },
      },
    });
    const p = await api.portfolio();
    expect(p.companyCount).toBe(1);
    expect(p.companies[0].slug).toBe("acme-aps");
  });

  test("unwraps a dashboard response", async () => {
    mockFetch({ "GET /api/companies/acme-aps/dashboard": { dashboard: dashboard() } });
    const d = await api.dashboard("acme-aps");
    expect(d.company.name).toBe("Acme ApS");
  });

  test("maps the {ok:false} error envelope to a typed ApiError", async () => {
    mockFetch({
      "POST /api/companies": {
        __error: { code: "conflict", message: "findes allerede" },
      },
    });
    await expect(api.createCompany({ name: "Acme ApS" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(api.createCompany({ name: "Acme ApS" })).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  test("createCompany returns the created slug", async () => {
    mockFetch({
      "POST /api/companies": { company: { slug: "gamma-aps", name: "Gamma ApS" } },
    });
    const created = await api.createCompany({ name: "Gamma ApS" });
    expect(created.slug).toBe("gamma-aps");
  });

  test("updateCompany PATCHes and returns the updated entry", async () => {
    mockFetch({
      "PATCH /api/companies/acme-aps": {
        company: { slug: "acme-aps", name: "Renamed", archived: true },
      },
    });
    const updated = await api.updateCompany("acme-aps", { archived: true });
    expect(updated).toMatchObject({ name: "Renamed", archived: true });
  });

  test("resolveException POSTs and returns the resolved exception", async () => {
    mockFetch({
      "POST /api/companies/acme-aps/exceptions/7/resolve": {
        exception: { id: 7, resolved: true },
      },
    });
    const result = await api.resolveException("acme-aps", 7, "Afstemt");
    expect(result).toEqual({ id: 7, resolved: true });
  });

  test("resolveException surfaces a 409 backup-lock conflict as a typed ApiError", async () => {
    mockFetch({
      "POST /api/companies/acme-aps/exceptions/7/resolve": {
        __error: { code: "conflict", message: "Bogføring er låst" },
      },
    });
    await expect(
      api.resolveException("acme-aps", 7),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
