import { describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BookkeepingBatchView } from "./BookkeepingBatchView";
import { renderAt } from "../test/render";
import { mockFetch } from "../test/fixtures";

const plan = { planHash: "a".repeat(64), items: [{ actionKey: "bank:1", partition: "missingDocument" }] };

describe("BookkeepingBatchView", () => {
  test("keeps plan, persist, approval and apply as four separate requests", async () => {
    mockFetch({
      "GET /api/companies/acme-aps/bookkeeping-workbench": { workbench: { state: "zero", counts: { ready: 0 }, population: { total: 0, ready: 0, blockers: 0 }, page: { total: 0, nextCursor: null }, completeness: { nextAction: "Ingen åbne poster." }, rows: [], periodClose: { status: "unavailable" } } },
      "GET /api/companies/acme-aps/bookkeeping-batch": { dryRun: true, plan },
      "POST /api/companies/acme-aps/bookkeeping-batch/persist": { ok: true, runId: 7, plan, state: { revisions: [], attempts: [], receipts: [] } },
      "POST /api/companies/acme-aps/bookkeeping-batch/approve": { ok: true, state: { revisions: [{}], attempts: [], receipts: [] } },
      "POST /api/companies/acme-aps/bookkeeping-batch/apply": { ok: true, runId: 7, results: [], checks: [] },
    });
    renderAt(<BookkeepingBatchView />, { route: "/companies/acme-aps/batchbogfoering", path: "/companies/:slug/batchbogfoering" });
    await userEvent.type(screen.getByLabelText("Fra dato"), "2026-01-01");
    await userEvent.type(screen.getByLabelText("Til dato"), "2026-01-31");
    await userEvent.click(screen.getByRole("button", { name: "Vis arbejdsko" }));
    await screen.findByText("Plan-hash:");
    expect(screen.getByRole("button", { name: "Gem plan" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Anvend" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Gem plan" }));
    await userEvent.click(screen.getByRole("button", { name: "Godkend" }));
    await userEvent.click(screen.getByRole("button", { name: "Anvend" }));
    await waitFor(() => expect(screen.getByText("Kørselsresultat")).toBeInTheDocument());
    const calls = (globalThis.fetch as any).mock.calls.map((x: any[]) => String(x[0]).replace(/^https?:\/\/[^/]+/, "").split("?")[0]);
    expect(calls.filter((path: string) => path.endsWith("/approve"))).toHaveLength(1);
    expect(calls.filter((path: string) => path.endsWith("/apply"))).toHaveLength(1);
  });
});
