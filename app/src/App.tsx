// App shell + routing for the cockpit SPA (#171).
//
// Routes:
//   /                                   portfolio overview (→ onboarding)
//   /companies/new                      add a company
//   /companies/:slug                    Overblik (per-company dashboard)
//   /companies/:slug/resultatopgorelse  Resultatopgørelse (income statement)
//   /companies/:slug/balance            Balance (balance sheet)
//   /companies/:slug/saldobalance       Saldobalance (trial balance)
//   /companies/:slug/forpligtelser      Forpligtelser (obligations / payables)
//   /companies/:slug/likviditet         Likviditet (cash flow / pengestrøm)
//   /companies/:slug/posteringer        Posteringer (journal + drill-down)
//   /companies/:slug/bank               Bank (transactions + reconciliation)
//   /companies/:slug/moms               Moms (VAT return)
//   /companies/:slug/bilag              Bilag (ingested documents)
//   /companies/:slug/arkiv              Om arkivet (read-only #197 explainer)
//   /companies/:slug/fleraar            Flerårsoversigt (multi-year comparison)
//   /companies/:slug/fakturaer          Fakturaer (issued invoices)
//   /companies/:slug/kontakter          Kontakter (customers + vendors)
//   /companies/:slug/koersel            Kørsel (mileage register, #335)
//   /companies/:slug/anlaeg             Anlæg (fixed assets + depreciation)
//   /companies/:slug/manage             rename / archive
//   /help                                hjælp og support (#421)
//
// The per-company views share a sub-navigation and a fiscal-year selector
// (`CompanyNav`); the chosen year is carried in the URL as `?year=`.

import { NavLink, Route, Routes, Link, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth-context";
import { api } from "./lib/api";
import { useAsync } from "./lib/useAsync";
import { ForgotPasswordView, LoginView, ResetPasswordView, VerificationRecoveryView } from "./views/LoginView";
import { MfaEnrollmentView, VerificationRequiredView } from "./views/MfaEnrollmentView";
import { AccountMenu } from "./components/AccountMenu";
import { CompanySwitcher } from "./components/CompanySwitcher";
import packageJson from "../package.json";
import { PortfolioView } from "./views/PortfolioView";
import { AddCompanyView } from "./views/AddCompanyView";
import { DashboardView } from "./views/DashboardView";
import { IncomeStatementView } from "./views/IncomeStatementView";
import { BalanceView } from "./views/BalanceView";
import { TrialBalanceView } from "./views/TrialBalanceView";
import { ObligationsView } from "./views/ObligationsView";
import { LiquidityView } from "./views/LiquidityView";
import { BudgetView } from "./views/BudgetView";
import { JournalView } from "./views/JournalView";
import { BankView } from "./views/BankView";
import { VatView } from "./views/VatView";
import { DocumentsView } from "./views/DocumentsView";
import { ArchiveView } from "./views/ArchiveView";
import { MultiYearView } from "./views/MultiYearView";
import { InvoicesView } from "./views/InvoicesView";
import { PayablesView } from "./views/PayablesView";
import { RecurringInvoicesView } from "./views/RecurringInvoicesView";
import { ContactsView } from "./views/ContactsView";
import { MileageView } from "./views/MileageView";
import { AssetsView } from "./views/AssetsView";
import { SuggestionsView } from "./views/SuggestionsView";
import { ManageCompanyView } from "./views/ManageCompanyView";
import { HelpView } from "./views/HelpView";
import { RulesView } from "./views/RulesView";
import { RetentionView } from "./views/RetentionView";
import { IntegrityView } from "./views/IntegrityView";
import { AccountsView } from "./views/AccountsView";
import { ExceptionsView } from "./views/ExceptionsView";
import { PeriodsView } from "./views/PeriodsView";
import { BankAccountsView } from "./views/BankAccountsView";
import { GdprView } from "./views/GdprView";
import { AccrualsView } from "./views/AccrualsView";
import { AnnualReportView } from "./views/AnnualReportView";
import { BilagsmailView } from "./views/BilagsmailView";
import { GroupOverviewView } from "./views/GroupOverviewView";
import { AccountingDraftsView } from "./views/AccountingDraftsView";
import { InvitationView } from "./views/InvitationView";
import { WorkspaceAccessView } from "./views/WorkspaceAccessView";

export function App() {
  const health = useAsync(() => api.health(), []);
  const profile = health.data?.deploymentProfile;
  if (health.loading) return <div className="state-msg">Starter Rentemester…</div>;
  // This gate deliberately has no fallback. A reverse proxy error or an old
  // server must not accidentally expose a local/trusted cockpit in production.
  if (health.error || (profile !== "local" && profile !== "hosted")) {
    return <div className="state-msg" role="alert">Kunne ikke bekræfte Rentemesters sikkerhedsprofil. Prøv igen senere.</div>;
  }
  return <AuthProvider hosted={profile === "hosted"}><AuthGate /></AuthProvider>;
}

function AuthGate() {
  const { hosted, loading, session, context } = useAuth();
  const location = useLocation();
  if (!hosted) return <CockpitApp />;
  if (loading) return <div className="state-msg">Kontrollerer din session…</div>;
  if (location.pathname === "/invite") return <InvitationView />;
  if (!session) return <AuthRecoveryRoutes />;
  if (!session.emailVerified) return <VerificationRequiredView />;
  if (!session.twoFactorEnabled) return <MfaEnrollmentView />;
  if (!context) return <div className="state-msg">Indlæser din adgang…</div>;
  return <CockpitApp />;
}

function AuthRecoveryRoutes() {
  return <Routes><Route path="/invite" element={<InvitationView />} /><Route path="/forgot-password" element={<ForgotPasswordView />} /><Route path="/reset-password" element={<ResetPasswordView />} /><Route path="/verify-email" element={<VerificationRecoveryView />} /><Route path="*" element={<LoginView />} /></Routes>;
}

function CockpitApp() {
  const { hosted, context } = useAuth();
  const canManageWorkspace = !hosted || context?.workspaceRole === "workspace_owner";
  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>
          Rentemester <span className="brand-dot">Cockpit</span>{" "}
          <span className="build-version" title="Installeret Rentemester-version">
            v{packageJson.version}
          </span>
        </h1>
        <nav>
          <NavLink to="/" end>
            Portefølje
          </NavLink>
          {canManageWorkspace && <NavLink to="/companies/new">Tilføj virksomhed</NavLink>}
          {hosted && canManageWorkspace && <NavLink to="/koncernstruktur">Koncernstruktur</NavLink>}
          {hosted && canManageWorkspace && <NavLink to="/adgang">Brugere</NavLink>}
          <NavLink to="/lovgrundlag">Lovgrundlag</NavLink>
          <NavLink to="/help">Hjælp</NavLink>
        </nav>
        {hosted && <CompanySwitcher />}
        {hosted && <AccountMenu />}
      </header>

      <main>
        <Routes>
          <Route path="/" element={<PortfolioView />} />
          <Route path="/companies/new" element={<AddCompanyView />} />
          {hosted && canManageWorkspace && <Route path="/koncernstruktur" element={<GroupOverviewView />} />}
          {hosted && canManageWorkspace && <Route path="/adgang" element={<WorkspaceAccessView />} />}
          <Route path="/companies/:slug" element={<DashboardView />} />
          <Route
            path="/companies/:slug/resultatopgorelse"
            element={<IncomeStatementView />}
          />
          <Route path="/companies/:slug/balance" element={<BalanceView />} />
          <Route
            path="/companies/:slug/saldobalance"
            element={<TrialBalanceView />}
          />
          <Route
            path="/companies/:slug/forpligtelser"
            element={<ObligationsView />}
          />
          <Route
            path="/companies/:slug/likviditet"
            element={<LiquidityView />}
          />
          <Route
            path="/companies/:slug/budget"
            element={<BudgetView />}
          />
          <Route
            path="/companies/:slug/posteringer"
            element={<JournalView />}
          />
          <Route path="/companies/:slug/kladder" element={<AccountingDraftsView />} />
          <Route path="/companies/:slug/bank" element={<BankView />} />
          <Route path="/companies/:slug/moms" element={<VatView />} />
          <Route path="/companies/:slug/bilag" element={<DocumentsView />} />
          <Route
            path="/companies/:slug/leverandoerfaktura"
            element={<PayablesView />}
          />
          <Route path="/companies/:slug/arkiv" element={<ArchiveView />} />
          <Route
            path="/companies/:slug/fleraar"
            element={<MultiYearView />}
          />
          <Route
            path="/companies/:slug/fakturaer"
            element={<InvoicesView />}
          />
          <Route
            path="/companies/:slug/faktura-skabeloner"
            element={<RecurringInvoicesView />}
          />
          <Route
            path="/companies/:slug/kontakter"
            element={<ContactsView />}
          />
          <Route
            path="/companies/:slug/koersel"
            element={<MileageView />}
          />
          <Route
            path="/companies/:slug/anlaeg"
            element={<AssetsView />}
          />
          <Route
            path="/companies/:slug/agent-forslag"
            element={<SuggestionsView />}
          />
          <Route
            path="/companies/:slug/manage"
            element={<ManageCompanyView />}
          />
          <Route path="/help" element={<HelpView />} />
          <Route path="/lovgrundlag" element={<RulesView />} />
          <Route
            path="/companies/:slug/retention"
            element={<RetentionView />}
          />
          <Route
            path="/companies/:slug/integritet"
            element={<IntegrityView />}
          />
          <Route
            path="/companies/:slug/kontoplan"
            element={<AccountsView />}
          />
          <Route
            path="/companies/:slug/undtagelser"
            element={<ExceptionsView />}
          />
          <Route
            path="/companies/:slug/periodelas"
            element={<PeriodsView />}
          />
          <Route
            path="/companies/:slug/bankkonti"
            element={<BankAccountsView />}
          />
          <Route
            path="/companies/:slug/gdpr"
            element={<GdprView />}
          />
          <Route
            path="/companies/:slug/periodisering"
            element={<AccrualsView />}
          />
          <Route
            path="/companies/:slug/aarsrapport"
            element={<AnnualReportView />}
          />
          <Route
            path="/companies/:slug/bilagsmail"
            element={<BilagsmailView />}
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}

function NotFound() {
  return (
    <section className="state-msg">
      <p>Siden findes ikke.</p>
      <Link className="btn secondary" to="/">
        Til porteføljen
      </Link>
    </section>
  );
}
