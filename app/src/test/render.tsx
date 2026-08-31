// A render helper that wraps a component in a MemoryRouter so route-aware
// components (links, useNavigate, useParams) work under test.

import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactElement } from "react";
import { CompanyNavigationShell } from "../components/CompanyNav";
import {
  COMPANY_ROUTE_REGISTRY,
  COMPANY_TASK_AREAS,
} from "../company-route-registry";

const COMPANY_NAVIGATION = {
  routes: COMPANY_ROUTE_REGISTRY,
  areas: COMPANY_TASK_AREAS,
};

export function renderAt(
  ui: ReactElement,
  { route = "/", path = "*" }: { route?: string; path?: string } = {},
) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <CompanyNavigationShell navigation={COMPANY_NAVIGATION}>
        <Routes>
          <Route path={path} element={ui} />
          <Route path="*" element={<div />} />
        </Routes>
      </CompanyNavigationShell>
    </MemoryRouter>,
  );
}
