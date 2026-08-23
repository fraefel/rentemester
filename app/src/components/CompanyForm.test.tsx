import { describe, expect, test, vi } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompanyForm } from "./CompanyForm";
import { mockFetch } from "../test/fixtures";
import { stubGlobal } from "../test/globals";

describe("CompanyForm", () => {
  test("POSTs the entered company and reports the created slug", async () => {
    mockFetch({
      "POST /api/companies": { company: { slug: "gamma-aps", name: "Gamma ApS" } },
    });
    const onCreated = vi.fn();
    render(<CompanyForm onCreated={onCreated} />);

    await userEvent.type(screen.getByLabelText(/Virksomhedsnavn/i), "Gamma ApS");
    await userEvent.click(screen.getByRole("button", { name: /Opret virksomhed/i }));

    expect(onCreated).toHaveBeenCalledWith("gamma-aps");
  });

  test("blocks submit on an empty name", async () => {
    const onCreated = vi.fn();
    render(<CompanyForm onCreated={onCreated} />);
    await userEvent.click(screen.getByRole("button", { name: /Opret virksomhed/i }));
    expect(onCreated).not.toHaveBeenCalled();
  });

  test("renders a backend conflict error inline", async () => {
    mockFetch({
      "POST /api/companies": {
        __error: { code: "conflict", message: "findes allerede" },
      },
    });
    render(<CompanyForm onCreated={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/Virksomhedsnavn/i), "Acme ApS");
    await userEvent.click(screen.getByRole("button", { name: /Opret virksomhed/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/findes allerede/i);
  });

  // #284 — bank/payment details can be captured at company creation so the
  // very first invoice already carries payment instructions.
  test("offers bank fields and POSTs them as a payment block", async () => {
    const fetchSpy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            ok: true,
            company: { slug: "gamma-aps", name: "Gamma ApS" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    stubGlobal("fetch", fetchSpy);

    render(<CompanyForm onCreated={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/Virksomhedsnavn/i), "Gamma ApS");
    await userEvent.type(
      screen.getByLabelText(/Registreringsnummer/i),
      "1234",
    );
    await userEvent.type(
      screen.getByLabelText(/Kontonummer/i),
      "0001234567",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Opret virksomhed/i }),
    );

    expect(fetchSpy).toHaveBeenCalled();
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1]?.body ?? "{}") as string,
    );
    expect(body.payment.registrationNo).toBe("1234");
    expect(body.payment.accountNo).toBe("0001234567");
  });
});
