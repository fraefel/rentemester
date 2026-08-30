import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";

const statuses = ["ready", "suggestedMatch", "missingDocument", "partyUnresolved", "accountingDecisionRequired", "vatEvidenceRequired", "dimensionEvidenceRequired", "stalePlan", "applyFailed"];

export function BookkeepingBatchView() {
  const { slug = "" } = useParams();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [filters, setFilters] = useState({ status: "", bankAccountId: "", partyId: "", documentQuality: "", account: "", vatTreatment: "", dimension: "", search: "" });
  const [cursor, setCursor] = useState(0);
  const [workbench, setWorkbench] = useState<any>();
  const [plan, setPlan] = useState<any>();
  const [run, setRun] = useState<any>();
  const [result, setResult] = useState<any>();
  const [error, setError] = useState<string>();
  const scope = { companyId: 1, accountingFrom: from, accountingTo: to, bankFrom: from, bankTo: to };
  const setFilter = (name: keyof typeof filters, value: string) => setFilters(current => ({ ...current, [name]: value }));

  const refresh = async (next = cursor) => {
    try {
      const documentQuality = filters.documentQuality === "matched" || filters.documentQuality === "missing" ? filters.documentQuality : undefined;
      setWorkbench(await api.bookkeepingWorkbench(slug, {
        from, to, status: filters.status || undefined, search: filters.search || undefined,
        bankAccountId: filters.bankAccountId ? Number(filters.bankAccountId) : undefined,
        partyId: filters.partyId || undefined, documentQuality,
        account: filters.account || undefined, vatTreatment: filters.vatTreatment || undefined,
        dimension: filters.dimension || undefined, cursor: next, limit: 25,
      }));
      setPlan(await api.bookkeepingBatchPlan(slug, scope));
      setCursor(next);
      setError(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const queue = workbench?.workbench;
  const visible = run?.plan ?? plan?.plan;
  const selection = queue?.selection ?? queue?.population;
  const canPersist = Boolean(plan && queue && queue.state === "available" && queue.population.blockers === 0 && queue.plan?.planHash === plan.plan?.planHash && !run);
  const persist = async () => { try { if (canPersist) setRun(await api.bookkeepingBatchPersist(slug, { ...scope, runKey: `cockpit:${Date.now()}` })); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };
  const approve = async () => { try { if (run) setRun({ ...run, ...await api.bookkeepingBatchApprove(slug, { runId: run.runId, planHash: run.plan.planHash }) }); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };
  const apply = async () => { try { if (run) { setResult(await api.bookkeepingBatchApply(slug, { runId: run.runId, planHash: run.plan.planHash })); await refresh(0); } } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };

  return <section className="statement">
    <h2>Bogføring</h2>
    <p className="muted">Uafstemte bankposter er arbejdskøen. En plan kan først gemmes, når hele periodens canonical state er komplet og uden blokeringer.</p>
    <div className="row-actions">
      <input aria-label="Fra dato" type="date" value={from} onChange={event => setFrom(event.target.value)} />
      <input aria-label="Til dato" type="date" value={to} onChange={event => setTo(event.target.value)} />
      <select aria-label="Status" value={filters.status} onChange={event => setFilter("status", event.target.value)}><option value="">Alle statusser</option>{statuses.map(status => <option key={status}>{status}</option>)}</select>
      <input aria-label="Bankkonto" value={filters.bankAccountId} onChange={event => setFilter("bankAccountId", event.target.value)} placeholder="Bankkonto-id" />
      <input aria-label="Canonical part" value={filters.partyId} onChange={event => setFilter("partyId", event.target.value)} placeholder="Part-id" />
      <select aria-label="Bilagskvalitet" value={filters.documentQuality} onChange={event => setFilter("documentQuality", event.target.value)}><option value="">Alle bilag</option><option value="matched">Matchet</option><option value="missing">Mangler</option></select>
      <input aria-label="Konto" value={filters.account} onChange={event => setFilter("account", event.target.value)} placeholder="Konto" />
      <input aria-label="Moms" value={filters.vatTreatment} onChange={event => setFilter("vatTreatment", event.target.value)} placeholder="Momsbehandling" />
      <input aria-label="Dimension" value={filters.dimension} onChange={event => setFilter("dimension", event.target.value)} placeholder="dimension:medlem" />
      <input aria-label="Søg" value={filters.search} onChange={event => setFilter("search", event.target.value)} placeholder="Tekst, beløb, part eller konto" />
      <button type="button" className="btn secondary" onClick={() => refresh(0)}>Vis arbejdskø</button>
      <button type="button" className="btn secondary" disabled={!canPersist} onClick={persist}>Gem eksakt plan</button>
      <button type="button" className="btn secondary" disabled={!run} onClick={approve}>Godkend</button>
      <button type="button" className="btn" disabled={!run} onClick={apply}>Anvend</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {queue && <>
      <div className="status-grid"><div className="card"><h3>Klar i udvalg</h3><div className="status-figure">{selection.ready}</div></div><div className="card"><h3>Blokeringer i udvalg</h3><div className="status-figure">{selection.blockers}</div></div></div>
      {queue.population.blockers > 0 && <p className="muted">Hele perioden har {queue.population.blockers} blokeringer; en filtrering kan ikke omgå dem.</p>}
      {queue.state === "zero" ? <p>Ingen uafstemte bankposter i perioden.</p> : <>
        <p className="muted">{queue.completeness.nextAction}</p>
        <table><thead><tr><th>Dato</th><th>Banktekst</th><th>Beløb</th><th>Status</th><th>Næste skridt</th></tr></thead><tbody>{queue.rows.map((row: any) => <tr key={row.bankTransactionId}>
          <td>{row.date}</td><td><strong>{row.text}</strong><details><summary>Detaljer og kilder</summary><p>Bilag: {row.document?.id ?? "mangler"} · Part: {row.document?.party?.name ?? row.document?.resolutionState ?? "uafklaret"} · Konto: {row.proposed.account ?? "uafklaret"} · Moms: {row.proposed.vatTreatment ?? "uafklaret"} · Dimensioner: {row.proposed.dimensions.map((dimension: any) => `${dimension.dimensionId}:${dimension.memberId} (${dimension.status})`).join(", ") || "ingen"}</p><p><Link to={`/companies/${slug}/bank?transactionId=${row.bankTransactionId}`}>Bank og afstemning</Link>{row.drilldown.documentId && <> · <Link to={`/companies/${slug}/bilag?documentId=${row.drilldown.documentId}`}>Bilag</Link></>}{row.drilldown.partyId && <> · <Link to={`/companies/${slug}/workspace-register?partyId=${encodeURIComponent(row.drilldown.partyId)}`}>Canonical part</Link></>}{row.drilldown.runId && <> · <Link to={`/companies/${slug}/batchbogfoering?runId=${row.drilldown.runId}`}>Reviewet batch</Link></>}{row.drilldown.journalEntryId && <> · <Link to={`/companies/${slug}/posteringer?journalEntryId=${row.drilldown.journalEntryId}`}>Journal</Link></>}</p></details></td>
          <td>{row.amount} {row.currency}</td><td>{row.status}</td><td>{row.nextAction}</td>
        </tr>)}</tbody></table>
        <div className="row-actions"><button type="button" className="btn secondary" disabled={cursor === 0} onClick={() => refresh(Math.max(0, cursor - 25))}>Forrige</button><button type="button" className="btn secondary" disabled={queue.page.nextCursor === null} onClick={() => refresh(queue.page.nextCursor)}>Næste</button></div>
      </>}
      <p className="muted">Periodestatus: {queue.periodClose?.status}{queue.periodClose?.status === "available" ? ` · ${queue.periodClose.blockers} blokeringer` : ""} · <Link to={`/companies/${slug}/periodelas?from=${from}&to=${to}`}>Åbn periodeluk</Link></p>
    </>}
    {visible && <p>Plan-hash: <code>{visible.planHash}</code></p>}
    {run?.state && <div className="card"><h3>Varig historik</h3><p>Revisioner: {run.state.revisions?.length ?? 0} · Forsøg: {run.state.attempts?.length ?? 0} · Kvitteringer: {run.state.receipts?.length ?? 0}</p></div>}
    {result && <div className="card"><h3>Kørselsresultat</h3><pre>{JSON.stringify({ runId: result.runId, results: result.results, checks: result.checks }, null, 2)}</pre></div>}
  </section>;
}
