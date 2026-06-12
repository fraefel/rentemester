import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "./ConfirmDialog";
import { ApiError } from "../lib/api";

function noop() {}

describe("ConfirmDialog", () => {
  test("renders the title, body and confirm label", () => {
    render(
      <ConfirmDialog
        title="Løs opgave"
        body={<p>Markér opgaven som løst.</p>}
        confirmLabel="Løs opgave"
        onConfirm={async () => {}}
        onClose={noop}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Løs opgave" })).toBeInTheDocument();
    expect(screen.getByText("Markér opgaven som løst.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Løs opgave" })).toBeInTheDocument();
  });

  test("passes the note text to onConfirm", async () => {
    const onConfirm = vi.fn(async () => {});
    render(
      <ConfirmDialog
        title="Løs opgave"
        body="x"
        confirmLabel="Løs"
        noteLabel="Note"
        onConfirm={onConfirm}
        onClose={noop}
      />,
    );
    await userEvent.type(screen.getByLabelText("Note"), "Afstemt manuelt");
    await userEvent.click(screen.getByRole("button", { name: "Løs" }));
    expect(onConfirm).toHaveBeenCalledWith("Afstemt manuelt");
  });

  test("closes via onClose after a successful confirm", async () => {
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        title="Løs opgave"
        body="x"
        confirmLabel="Løs"
        onConfirm={async () => {}}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Løs" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  test("Annullér closes without confirming", async () => {
    const onConfirm = vi.fn(async () => {});
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        title="Løs opgave"
        body="x"
        confirmLabel="Løs"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Annullér" }));
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("a 409 conflict is rendered as a kind lock banner, modal stays open", async () => {
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        title="Løs opgave"
        body="x"
        confirmLabel="Løs"
        onConfirm={async () => {
          throw new ApiError("conflict", "Bogføring er låst: backup overskredet.", 409);
        }}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Løs" }));
    expect(await screen.findByText("Bogføringen er låst")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("traps Tab focus inside the dialog (#UI-12)", async () => {
    render(
      <ConfirmDialog
        title="Løs opgave"
        body="x"
        confirmLabel="Løs"
        onConfirm={async () => {}}
        onClose={noop}
      />,
    );
    const confirm = screen.getByRole("button", { name: "Løs" });
    const cancel = screen.getByRole("button", { name: "Annullér" });
    // Focus starts on the confirm button (the last focusable). Tabbing forward
    // from the last element wraps to the first (Annullér), not out to <body>.
    expect(confirm).toHaveFocus();
    await userEvent.tab();
    expect(cancel).toHaveFocus();
    // Shift+Tab from the first wraps back to the last.
    await userEvent.tab({ shift: true });
    expect(confirm).toHaveFocus();
  });

  test("returns focus to the trigger element on close (#UI-12)", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Åbn
          </button>
          {open && (
            <ConfirmDialog
              title="Løs opgave"
              body="x"
              confirmLabel="Løs"
              onConfirm={async () => {}}
              onClose={() => setOpen(false)}
            />
          )}
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Åbn" });
    // Open from the trigger so the dialog captures it as the element to restore.
    await userEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // Closing returns focus to the trigger, not to <body>.
    await userEvent.click(screen.getByRole("button", { name: "Annullér" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  test("a non-conflict error is rendered as an error banner", async () => {
    render(
      <ConfirmDialog
        title="Løs opgave"
        body="x"
        confirmLabel="Løs"
        onConfirm={async () => {
          throw new ApiError("bad_request", "Ugyldig handling.", 400);
        }}
        onClose={noop}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Løs" }));
    expect(await screen.findByText("Ugyldig handling.")).toBeInTheDocument();
  });
});
