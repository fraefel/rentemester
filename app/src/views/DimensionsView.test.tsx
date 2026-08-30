import { afterEach, describe, expect, test, vi } from "bun:test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DimensionsView } from "./DimensionsView";
import { mockFetch } from "../test/fixtures";
import { renderAt } from "../test/render";
import { restoreGlobals } from "../test/globals";

const slug = "synthetic-company";
const definitions = [{ id: 1, dimension_id: "project", name: "Projects", status: "active", event_type: "created", created_at: "2026-01-01" }];
const members = [{ id: 2, dimension_id: "project", member_id: "p-a", name: "Project A", status: "active", event_type: "created", created_at: "2026-01-01" }];

function routes(extra: Record<string, unknown> = {}) {
  return {
    [`GET /api/companies/${slug}/dimensions`]: { definitions },
    [`GET /api/companies/${slug}/dimensions/members`]: { members },
    ...extra,
  };
}

function renderView() {
  return renderAt(<DimensionsView />, { route: `/companies/${slug}/dimensioner`, path: "/companies/:slug/dimensioner" });
}

afterEach(() => restoreGlobals());

describe("DimensionsView", () => {
  test("creates a dimension through the confirmed company-scoped API", async () => {
    mockFetch(routes({ [`POST /api/companies/${slug}/dimensions/define`]: {} }));
    renderView();
    await screen.findByText("Projects");
    await userEvent.type(screen.getByLabelText("Dimensions-id"), "department");
    await userEvent.type(screen.getByLabelText("Dimensionstype"), "department");
    await userEvent.type(screen.getByLabelText("Dimensionsnavn"), "Departments");
    await userEvent.click(screen.getByRole("button", { name: "Opret dimension" }));
    expect(screen.getByRole("dialog", { name: "Opret dimension" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Bekræft ændring" }));
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([url, init]) => String(url) === `/api/companies/${slug}/dimensions/define` && init?.method === "POST");
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ dimensionId: "department", kind: "department", name: "Departments", confirm: true });
  });

  test("renames and deactivates members through separately confirmed lifecycle events", async () => {
    mockFetch(routes({ [`POST /api/companies/${slug}/dimensions/member-lifecycle`]: {} }));
    renderView();
    await screen.findByText("Project A");
    await userEvent.click(screen.getAllByRole("button", { name: "Omdøb" })[1]!);
    await userEvent.clear(screen.getByLabelText("Nyt navn"));
    await userEvent.type(screen.getByLabelText("Nyt navn"), "Project Alpha");
    await userEvent.click(screen.getByRole("button", { name: "Bekræft ændring" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Deaktiver" })[1]!);
    await userEvent.click(screen.getByRole("button", { name: "Bekræft ændring" }));
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url, init]) => String(url) === `/api/companies/${slug}/dimensions/member-lifecycle` && init?.method === "POST");
    expect(calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)))).toEqual([
      { dimensionId: "project", memberId: "p-a", action: "rename", name: "Project Alpha", confirm: true },
      { dimensionId: "project", memberId: "p-a", action: "deactivate", confirm: true },
    ]);
  });
});
