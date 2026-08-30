import { useState } from "react";
import { api } from "../lib/api";

type Plan = { ok: true; plan: { reconciliationId: string; planHash: string; currentJournalEntryNo: string; replacementJournalEntryNo: string; bankAccountNo: string; bankAmountDkk: number } } | { ok: false; errors: string[] };

/** A deliberate two-step correction: inspect the hash-bound plan before apply. */
export function BankCorrectionModal({ slug, transaction, onApplied, onClose }: {
  slug: string; transaction: { id: number; text: string; journalEntryNo?: string | null }; onApplied: () => void; onClose: () => void;
}) {
  const [replacementJournalEntryId, setReplacementJournalEntryId] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const replacementId = Number(replacementJournalEntryId);

  async function inspect() {
    if (!Number.isInteger(replacementId) || replacementId <= 0) { setError("Angiv et positivt journal-id til erstatningen."); return; }
    setBusy(true); setError(null); setPlan(null);
    try { setPlan(await api.correctionPlan(slug, transaction.id, replacementId) as Plan); }
    catch (cause) { setError(cause instanceof Error ? cause.message.slice(0, 500) : "Planen kunne ikke læses."); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!plan || !plan.ok || !confirmed || !reason.trim() || !idempotencyKey.trim()) return;
    setBusy(true); setError(null);
    try { await api.applyCorrection(slug, { bankTransactionId: transaction.id, replacementJournalEntryId: replacementId, expectedReconciliationId: plan.plan.reconciliationId, planHash: plan.plan.planHash, reason: reason.trim(), idempotencyKey: idempotencyKey.trim() }); onApplied(); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message.slice(0, 500) : "Korrektionen blev afvist."); }
    finally { setBusy(false); }
  }
  return <div className="modal-overlay" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="bank-correction-title">
    <h3 id="bank-correction-title">Ret afstemt bankpost</h3>
    <p className="muted">Bankpost #{transaction.id}: {transaction.text}. Den historiske afstemning ændres ikke; en ny, hash-bundet korrektion supersederer den.</p>
    <label>Erstatningsjournal-id<input aria-label="Erstatningsjournal-id" inputMode="numeric" value={replacementJournalEntryId} onChange={(event) => setReplacementJournalEntryId(event.target.value)} disabled={busy || !!plan} /></label>
    {!plan && <div className="row-actions"><button type="button" className="btn" onClick={inspect} disabled={busy}>Kontrollér plan</button><button type="button" className="btn secondary" onClick={onClose}>Annullér</button></div>}
    {plan && !plan.ok && <p className="error" role="alert">{plan.errors.join("; ").slice(0, 500)}</p>}
    {plan?.ok && <>
      <div className="card"><p><strong>Eksisterende:</strong> {plan.plan.reconciliationId} · {plan.plan.currentJournalEntryNo}</p><p><strong>Erstatning:</strong> {plan.plan.replacementJournalEntryNo} · konto {plan.plan.bankAccountNo} · {plan.plan.bankAmountDkk} DKK</p><p className="muted">Plan-hash: {plan.plan.planHash}</p></div>
      <label>Begrundelse<input aria-label="Begrundelse" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} /></label>
      <label>Idempotensnøgle<input aria-label="Idempotensnøgle" value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} maxLength={128} /></label>
      <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Jeg har gennemgået planen og vil anvende denne korrektion.</label>
      <div className="row-actions"><button type="button" className="btn" onClick={apply} disabled={busy || !confirmed || !reason.trim() || !idempotencyKey.trim()}>Anvend korrektion</button><button type="button" className="btn secondary" onClick={onClose} disabled={busy}>Annullér</button></div>
    </>}
    {error && <p className="error" role="alert">{error}</p>}
  </section></div>;
}
