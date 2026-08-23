import { describe, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import { Onboarding } from "./Onboarding";
import { renderAt } from "../test/render";

describe("Onboarding — first run", () => {
  test("welcomes the owner and shows the create-company form", () => {
    renderAt(<Onboarding onCreated={() => {}} />);
    expect(
      screen.getByText(/Velkommen til Rentemester/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("form", { name: /Opret virksomhed/i }),
    ).toBeInTheDocument();
  });

  test("the scope text reflects the Cockpit's write actions (#255)", () => {
    renderAt(<Onboarding onCreated={() => {}} />);
    // The stale claim that bookkeeping happens only via the CLI must be gone…
    expect(
      screen.queryByText(/sker fortsat via\s+agenten og kommandolinjen/i),
    ).not.toBeInTheDocument();
    // …and the text must say the Cockpit itself can book.
    const scope = screen.getByText(/bogføre direkte i cockpittet/i);
    expect(scope).toBeInTheDocument();
    expect(scope.textContent).toMatch(/fakturaer/i);
    expect(scope.textContent).toMatch(/bankudtog/i);
    expect(scope.textContent).toMatch(/bilag/i);
  });
});
