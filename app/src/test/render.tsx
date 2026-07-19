// A render helper that wraps a component in a MemoryRouter so route-aware
// components (links, useNavigate, useParams) work under test.

import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactElement } from "react";

export function renderAt(
  ui: ReactElement,
  { route = "/", path = "*" }: { route?: string; path?: string } = {},
) {
  return render(
    <MemoryRouter
      initialEntries={[route]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path={path} element={ui} />
        <Route path="*" element={<div />} />
      </Routes>
    </MemoryRouter>,
  );
}
