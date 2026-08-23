import { FormEvent, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Banner, ErrorState, Loading } from "../components/Feedback";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth-context";
import { useAsync } from "../lib/useAsync";
import type { WorkspaceInvitationInput, WorkspaceMember } from "../lib/types";

const roleLabels = {
  owner: "Ejer", bookkeeper: "Bogholder", reviewer: "Reviewer", reader: "Læseadgang",
} as const;

type PendingChange =
  | { kind: "workspace-role"; userId: string; role: WorkspaceMember["workspaceRole"] }
  | { kind: "disable"; userId: string }
  | { kind: "company-role"; userId: string; companySlug: string; role: WorkspaceInvitationInput["companyRole"] }
  | { kind: "company-revoke"; userId: string; companySlug: string };

export function WorkspaceAccessView() {
  const { context } = useAuth();
  const invitationState = useAsync(() => api.workspaceInvitations(), []);
  const memberState = useAsync(() => api.workspaceMembers(), []);
  const ownedCompanies = context?.companies.filter((company) => !company.archived && company.role === "owner") ?? [];
  const firstCompany = ownedCompanies[0]?.slug ?? "";
  const [input, setInput] = useState<WorkspaceInvitationInput>({
    email: "", workspaceRole: "member", companySlug: firstCompany, companyRole: "bookkeeper",
  });
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedCompanySlug, setSelectedCompanySlug] = useState(firstCompany);
  const [workspaceRole, setWorkspaceRole] = useState<WorkspaceMember["workspaceRole"]>("member");
  const [companyRole, setCompanyRole] = useState<WorkspaceInvitationInput["companyRole"]>("bookkeeper");
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (invitationState.loading || memberState.loading) return <Loading label="Henter adgang…" />;
  if (invitationState.error || memberState.error) {
    return <ErrorState message="Adgangen kunne ikke hentes." onRetry={() => {
      invitationState.reload(); memberState.reload();
    }} />;
  }

  const members = memberState.data!;
  const selectedMember = members.find((member) => member.userId === selectedUserId) ?? null;
  const reload = () => { invitationState.reload(); memberState.reload(); };

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null); setMessage(null);
    try {
      await api.createWorkspaceInvitation(input);
      setInput((current) => ({ ...current, email: "" }));
      setMessage("Invitationen er sendt."); reload();
    } catch { setError("Invitationen kunne ikke sendes."); }
    finally { setBusy(false); }
  }

  async function cancel(invitationId: string) {
    setBusy(true); setError(null); setMessage(null);
    try {
      await api.cancelWorkspaceInvitation(invitationId);
      setMessage("Invitationen er annulleret."); reload();
    } catch { setError("Invitationen kunne ikke annulleres."); }
    finally { setBusy(false); }
  }

  async function applyPending() {
    if (!pending) return;
    if (pending.kind === "workspace-role") {
      await api.updateWorkspaceMemberAccess({
        action: "set-role", userId: pending.userId, workspaceRole: pending.role,
      });
    } else if (pending.kind === "disable") {
      await api.updateWorkspaceMemberAccess({ action: "disable", userId: pending.userId });
    } else if (pending.kind === "company-role") {
      await api.updateWorkspaceMemberCompany({
        action: "grant", userId: pending.userId,
        companySlug: pending.companySlug, role: pending.role,
      });
    } else {
      await api.updateWorkspaceMemberCompany({
        action: "revoke", userId: pending.userId, companySlug: pending.companySlug,
      });
    }
    setMessage("Adgangen er opdateret."); setError(null); reload();
  }

  return <section>
    <div className="page-head"><div><h2>Brugere og adgang</h2><p className="muted">Invitér og administrér kun de virksomheder, hvor du selv er ejer. Adgang kræver verificeret e-mail og MFA.</p></div></div>
    {message && <Banner kind="success">{message}</Banner>}
    {error && <Banner kind="error">{error}</Banner>}
    <section className="card">
      <h3>Aktive brugere</h3>
      {members.length === 0 ? <p className="muted">Ingen aktive brugere.</p> : <div className="table-wrap"><table><thead><tr><th>Bruger</th><th>Workspace</th><th>Virksomhedsadgang</th><th>Sikkerhed</th></tr></thead><tbody>{members.map((member) => <tr key={member.userId}><td>{member.name}<br /><span className="muted">{member.email}</span></td><td>{member.workspaceRole === "workspace_owner" ? "Ejer" : "Medlem"}</td><td>{member.memberships.length === 0 ? "—" : member.memberships.map((membership) => `${membership.companyName}: ${roleLabels[membership.role]}`).join(", ")}</td><td>{member.accessReady ? "Klar" : "Afventer e-mail/MFA"}</td></tr>)}</tbody></table></div>}
    </section>
    <section className="card">
      <h3>Ændr adgang</h3>
      <p className="muted">Vælg én bruger og én ændring ad gangen. Sidste aktive ejer kan ikke fjernes.</p>
      <label>Bruger<select value={selectedUserId} onChange={(event) => {
        const userId = event.target.value; setSelectedUserId(userId);
        const member = members.find((candidate) => candidate.userId === userId);
        if (member) setWorkspaceRole(member.workspaceRole);
      }}><option value="">Vælg bruger</option>{members.map((member) => <option key={member.userId} value={member.userId}>{member.name} — {member.email}</option>)}</select></label>
      {selectedMember && <>
        <label>Workspace-rolle<select value={workspaceRole} onChange={(event) => setWorkspaceRole(event.target.value as WorkspaceMember["workspaceRole"])}><option value="member">Medlem</option><option value="workspace_owner">Ejer</option></select></label>
        <div className="modal-actions"><button type="button" className="btn secondary" onClick={() => setPending({ kind: "workspace-role", userId: selectedMember.userId, role: workspaceRole })}>Gem workspace-rolle</button><button type="button" className="btn danger" onClick={() => setPending({ kind: "disable", userId: selectedMember.userId })}>Deaktivér bruger</button></div>
        {ownedCompanies.length > 0 && <>
          <label>Virksomhed<select value={selectedCompanySlug} onChange={(event) => setSelectedCompanySlug(event.target.value)}>{ownedCompanies.map((company) => <option key={company.slug} value={company.slug}>{company.name}</option>)}</select></label>
          <label>Virksomhedsrolle<select value={companyRole} onChange={(event) => setCompanyRole(event.target.value as WorkspaceInvitationInput["companyRole"])}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <div className="modal-actions"><button type="button" className="btn secondary" onClick={() => setPending({ kind: "company-role", userId: selectedMember.userId, companySlug: selectedCompanySlug, role: companyRole })}>Gem virksomhedsrolle</button><button type="button" className="btn danger" onClick={() => setPending({ kind: "company-revoke", userId: selectedMember.userId, companySlug: selectedCompanySlug })}>Fjern virksomhedsadgang</button></div>
        </>}
      </>}
    </section>
    <section className="card">
      <h3>Ny invitation</h3>
      <form onSubmit={submit}>
        <label>E-mail<input type="email" autoComplete="email" value={input.email} onChange={(event) => setInput({ ...input, email: event.target.value })} required /></label>
        <label>Virksomhed<select value={input.companySlug} onChange={(event) => setInput({ ...input, companySlug: event.target.value })} required>{ownedCompanies.map((company) => <option key={company.slug} value={company.slug}>{company.name}</option>)}</select></label>
        <label>Rolle<select value={input.companyRole} onChange={(event) => {
          const selectedRole = event.target.value as WorkspaceInvitationInput["companyRole"];
          setInput({ ...input, companyRole: selectedRole, workspaceRole: selectedRole === "owner" ? "workspace_owner" : "member" });
        }}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button className="btn" type="submit" disabled={busy || !input.companySlug}>Send invitation</button>
      </form>
    </section>
    <section className="card">
      <h3>Invitationer</h3>
      {invitationState.data!.length === 0 ? <p className="muted">Ingen invitationer endnu.</p> : <div className="table-wrap"><table><thead><tr><th>E-mail</th><th>Virksomhed</th><th>Rolle</th><th>Udløber</th><th>Status</th><th></th></tr></thead><tbody>{invitationState.data!.map((invitation) => <tr key={invitation.invitationId}><td>{invitation.email}</td><td>{invitation.companySlug}</td><td>{roleLabels[invitation.companyRole]}</td><td>{new Date(invitation.expiresAt).toLocaleDateString("da-DK")}</td><td>{invitation.status}</td><td>{(invitation.status === "issued" || invitation.status === "delivery_confirmed") && <button className="btn secondary" type="button" disabled={busy} onClick={() => void cancel(invitation.invitationId)}>Annullér</button>}</td></tr>)}</tbody></table></div>}
    </section>
    {pending && <ConfirmDialog
      title="Bekræft adgangsændring"
      body={<p>Ændringen registreres i det append-only revisionsspor og træder i kraft med det samme.</p>}
      confirmLabel="Gennemfør ændring"
      confirmKind={pending.kind === "disable" || pending.kind === "company-revoke" ? "danger" : "primary"}
      onConfirm={applyPending}
      onClose={() => setPending(null)}
    />}
  </section>;
}
