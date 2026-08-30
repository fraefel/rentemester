// Likviditet / pengestrøm — the per-company cash-flow view (cockpit-redesign
// Runde 2, iteration 8).
//
// Renders `/api/companies/:slug/cashflow?year=`: actual money in and out of the
// bank for the year, read straight from the imported bank transactions (NOT
// the accrual ledger). A summary strip carries primo-saldo · ind · ud ·
// ultimo-saldo; a combined Chart.js graph shows the monthly indbetalinger /
// udbetalinger as bars and the real bank-balance trajectory as a line. When the
// company has no bank transactions a clean empty state is shown instead. All
// money fields are kroner — `formatKroner` is used throughout.

import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { formatKroner } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import type { CompanyCashflow } from "../lib/types";
import { ErrorState, Loading } from "../components/Feedback";
import { CashflowChart } from "../components/CashflowChart";
import { CompanyNav, useCompanyYear } from "../components/CompanyNav";

/**
 * The bank balance at the end of each of the twelve calendar months: the last
 * statement point dated in or before that month. Months before the first
 * statement point are `null` so the trajectory line starts where the data
 * does. Returns `[]` when no statement carries a running balance.
 */
function monthlyBalances(cf: CompanyCashflow): Array<number | null> {
  if (cf.balanceSeries.length === 0) return [];
  const result: Array<number | null> = new Array(12).fill(null);
  let pointer = 0;
  let last: number | null = null;
  for (let month = 1; month <= 12; month += 1) {
    while (
      pointer < cf.balanceSeries.length &&
      parseInt(cf.balanceSeries[pointer]!.date.slice(5, 7), 10) <= month
    ) {
      last = cf.balanceSeries[pointer]!.balance;
      pointer += 1;
    }
    result[month - 1] = last;
  }
  return result;
}

export function LiquidityView() {
  const { slug = "" } = useParams();
  const { year, setYear } = useCompanyYear();
  const state = useAsync<CompanyCashflow>(
    () => api.cashflow(slug, year),
    [slug, year],
  );
  const commitments = useAsync(
    () => api.supplierCommitments(slug, `${year}-01-01`),
    [slug, year],
  );

  if (state.loading && !state.data)
    return <Loading label="Henter likviditet…" />;
  if (state.error)
    return <ErrorState message={state.error} onRetry={state.reload} />;

  const cf = state.data!;
  const currency = cf.company.currency || "DKK";
  const netto = cf.totalIn - cf.totalOut;

  return (
    <section className="statement">
      <div className="page-head">
        <div>
          <h2>{cf.company.name}</h2>
          <p className="muted">
            {cf.company.cvr ? `CVR ${cf.company.cvr} · ` : ""}
            {cf.company.country} · {currency} · Likviditet
          </p>
        </div>
        <div className="row-actions">
          <Link className="btn secondary" to={`/companies/${slug}/manage`}>
            Administrér
          </Link>
        </div>
      </div>

      <CompanyNav
        slug={slug}
        years={cf.fiscalYears}
        selectedYear={cf.selectedYear}
        onYearChange={setYear}
      />

      {commitments.data && (
        <section className="section">
          <h3>13 ugers likviditetsprognose</h3>
          <p className="muted">Primo {formatKroner(commitments.data.forecast.openingCash, currency)} · laveste punkt {formatKroner(commitments.data.forecast.lowestPoint, currency)}. Antagelser og fremmed valuta fremgår særskilt.</p>
          <div className="card statement-card table-scroll"><table className="data"><thead><tr><th>Uge</th><th className="num">Tilgodehavender</th><th className="num">Kreditorer</th><th className="num">Forpligtelser</th><th className="num">Ultimo</th></tr></thead><tbody>{commitments.data.forecast.periods.map(p=><tr key={p.weekStart}><td>{p.weekStart}</td><td className="num">{formatKroner(p.receivables,currency)}</td><td className="num">{formatKroner(p.payables,currency)}</td><td className="num">{formatKroner(p.commitments,currency)}</td><td className="num">{formatKroner(p.closingCash,currency)}</td></tr>)}</tbody></table></div>
          <h3>Abonnementer og leverandørforpligtelser</h3>
          {commitments.data.commitments.length===0?<p className="muted">Ingen godkendte forpligtelser.</p>:<div className="card statement-card table-scroll"><table className="data"><thead><tr><th>Leverandør</th><th>Formål</th><th className="num">Beløb</th><th>Frekvens</th><th>Næste</th><th>Fornyelse</th><th>Bilag</th></tr></thead><tbody>{commitments.data.commitments.map(c=><tr key={c.commitmentId}><td>{c.vendor}</td><td>{c.purpose}</td><td className="num">{c.amount===null?"—":formatKroner(c.amount,c.currency??currency)}</td><td>{c.frequency}</td><td>{c.nextDate}</td><td>{c.renewalDate??"—"}</td><td>{c.evidenceRefs.length?c.evidenceRefs.join(", "):"Mangler"}</td></tr>)}</tbody></table></div>}
          <p className="muted">Udeladt: {commitments.data.forecast.completeness.excluded.join("; ")}</p>
        </section>
      )}

      {cf.archived ? (
        <ArchivedNotice year={cf.selectedYear} />
      ) : !cf.hasTransactions ? (
        <div className="card archived-notice">
          <h3>Ingen pengestrøm</h3>
          <p className="muted">
            Der er ingen banktransaktioner i regnskabsåret {cf.selectedYear}.
            Når et kontoudtog er importeret, vises penge ind og ud og den
            faktiske bankudvikling her.
          </p>
        </div>
      ) : (
        <>
          <p className="statement-asof muted">
            Faktiske penge ind og ud — regnskabsår {cf.selectedYear}
          </p>

          <div className="status-grid cashflow-summary">
            <div className="card status-card">
              <h3>Primo-saldo</h3>
              <div className="status-figure">
                {cf.openingBalance === null
                  ? "—"
                  : formatKroner(cf.openingBalance, currency)}
              </div>
              <p className="muted status-note">
                Faktisk banksaldo ved årets start
              </p>
            </div>
            <div className="card status-card">
              <h3>Indbetalinger</h3>
              <div className="status-figure status-in">
                {formatKroner(cf.totalIn, currency)}
              </div>
              <p className="muted status-note">Penge ind i året</p>
            </div>
            <div className="card status-card">
              <h3>Udbetalinger</h3>
              <div className="status-figure status-out">
                {formatKroner(cf.totalOut, currency)}
              </div>
              <p className="muted status-note">Penge ud af året</p>
            </div>
            <div className="card status-card">
              <h3>Ultimo-saldo</h3>
              <div className="status-figure">
                {cf.closingBalance === null
                  ? "—"
                  : formatKroner(cf.closingBalance, currency)}
              </div>
              <p className="muted status-note">
                Faktisk banksaldo ved årets slut
              </p>
            </div>
          </div>

          <div className="section">
            <h3>Pengestrøm og banksaldo — {cf.selectedYear}</h3>
            <div className="card chart-card">
              <CashflowChart
                months={cf.months}
                balanceByMonth={monthlyBalances(cf)}
              />
            </div>
          </div>

          <div className="card statement-card table-scroll">
            <table className="data statement-table">
              <thead>
                <tr>
                  <th>Måned</th>
                  <th className="num">Indbetalinger</th>
                  <th className="num">Udbetalinger</th>
                  <th className="num">Netto</th>
                </tr>
              </thead>
              <tbody>
                {cf.months.map((m) => (
                  <tr key={m.month}>
                    <td>{m.label}</td>
                    <td className="num">
                      {formatKroner(m.indbetalinger, currency)}
                    </td>
                    <td className="num">
                      {formatKroner(m.udbetalinger, currency)}
                    </td>
                    <td className="num">
                      {formatKroner(m.netto, currency)}
                    </td>
                  </tr>
                ))}
                <tr
                  className={`statement-result ${
                    netto >= 0 ? "" : "negative"
                  }`}
                >
                  <td>I alt</td>
                  <td className="num">{formatKroner(cf.totalIn, currency)}</td>
                  <td className="num">
                    {formatKroner(cf.totalOut, currency)}
                  </td>
                  <td className="num">{formatKroner(netto, currency)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="statement-check ok">
            Tallene er faktiske pengebevægelser fra kontoudtoget — ikke det
            bogførte resultat. Pengestrømmen kan derfor afvige fra
            resultatopgørelsen.
          </p>
        </>
      )}
    </section>
  );
}

function ArchivedNotice({ year }: { year: string }) {
  return (
    <div className="card archived-notice">
      <h3>Likviditet er ikke tilgængelig for {year}</h3>
      <p className="muted">
        {year} er et arkiveret regnskabsår. Likviditet bygger på de importerede
        banktransaktioner, og der findes ingen kontoudtogsdata for et arkiveret
        år — pengestrømmen vises derfor ikke. Resultatopgørelse, balance,
        saldobalance og posteringer for {year} er tilgængelige.
      </p>
    </div>
  );
}
