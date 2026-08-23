import { useState } from "react";
import { authClient } from "../lib/auth-client";
import { useAuth } from "../lib/auth-context";

type ListedSession = {
  id: string;
  token: string;
  createdAt: string | Date;
  userAgent?: string | null;
};

function workspaceRoleLabel(role: "workspace_owner" | "member" | undefined): string {
  return role === "workspace_owner" ? "Workspace-ejer" : "Medlem";
}

function deviceHint(userAgent: string | null | undefined): string {
  if (!userAgent) return "Ukendt browser";
  if (/firefox/i.test(userAgent)) return "Firefox";
  if (/edg/i.test(userAgent)) return "Edge";
  if (/chrome|chromium/i.test(userAgent)) return "Chrome";
  if (/safari/i.test(userAgent)) return "Safari";
  return "Anden browser";
}

function createdLabel(value: string | Date): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Tidspunkt ukendt" : `Oprettet ${date.toLocaleString("da-DK")}`;
}

export function AccountMenu() {
  const { session, currentSessionId, context, clear, refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ListedSession[] | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  if (!session) return null;
  const signOut = async () => {
    setBusy(true); setError(null);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("sign out failed");
      clear();
    } catch { setError("Kunne ikke logge ud. Prøv igen."); }
    finally { setBusy(false); }
  };
  const revokeAll = async () => {
    if (!window.confirm("Log ud på alle enheder? Du skal logge ind igen.")) return;
    setBusy(true); setError(null);
    try {
      const result = await authClient.revokeSessions();
      if (result.error) throw new Error("revoke failed");
      clear();
    } catch { setError("Kunne ikke logge ud på alle enheder. Din nuværende session er stadig aktiv."); }
    finally { setBusy(false); }
  };
  const showSessions = async () => {
    if (sessions) { setSessions(null); return; }
    setBusy(true); setError(null);
    try {
      const result = await authClient.listSessions();
      if (result.error || !Array.isArray(result.data)) throw new Error("list failed");
      setSessions(result.data.flatMap((entry) =>
        typeof entry.id === "string" && typeof entry.token === "string"
          ? [{ id: entry.id, token: entry.token, createdAt: entry.createdAt, userAgent: entry.userAgent }]
          : []));
    } catch { setError("Kunne ikke hente aktive sessioner."); }
    finally { setBusy(false); }
  };
  const revokeOne = async (listed: ListedSession) => {
    if (!window.confirm("Afslut denne session? Enheden skal logge ind igen.")) return;
    setBusy(true); setError(null);
    try {
      const result = await authClient.revokeSession({ token: listed.token });
      if (result.error) throw new Error("revoke failed");
      setSessions((current) => current?.filter((entry) => entry.id !== listed.id) ?? null);
    } catch { setError("Kunne ikke afslutte sessionen."); }
    finally { setBusy(false); }
  };
  const changePassword = async () => {
    setError(null); setMessage(null);
    if (newPassword.length < 12 || newPassword !== confirmPassword) {
      setError("Den nye adgangskode skal være mindst 12 tegn, og gentagelsen skal være ens.");
      return;
    }
    setBusy(true);
    try {
      const result = await authClient.changePassword({
        currentPassword, newPassword, revokeOtherSessions: true,
      });
      if (result.error) throw new Error("password change failed");
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      setShowPassword(false);
      await refresh();
      setMessage("Adgangskoden er ændret, og alle tidligere sessioner er afsluttet.");
    } catch {
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      setError("Adgangskoden kunne ikke ændres. Log ind igen og prøv på ny.");
    } finally { setBusy(false); }
  };
  return <div className="account-menu" role="group" aria-label="Konto">
    <span className="account-identity"><span className="account-email">{session.email}</span><span className="account-role">{workspaceRoleLabel(context?.workspaceRole)}</span></span>
    <button className="btn secondary" type="button" onClick={() => void signOut()} disabled={busy}>Log ud</button>
    <button className="account-revoke" type="button" onClick={() => void showSessions()} disabled={busy}>{sessions ? "Skjul sessioner" : "Sessioner"}</button>
    <button className="account-revoke" type="button" onClick={() => setShowPassword((shown) => !shown)} disabled={busy}>{showPassword ? "Luk" : "Skift adgangskode"}</button>
    {sessions && <section className="session-panel" aria-label="Aktive sessioner">
      <h2>Aktive sessioner</h2>
      {sessions.length === 0 && <p>Ingen aktive sessioner.</p>}
      <ul>{sessions.map((listed) => <li key={listed.id}>
        <span><strong>{listed.id === currentSessionId ? "Denne enhed" : deviceHint(listed.userAgent)}</strong><small>{createdLabel(listed.createdAt)}</small></span>
        {listed.id !== currentSessionId && <button type="button" className="account-revoke" disabled={busy} onClick={() => void revokeOne(listed)}>Afslut</button>}
      </li>)}</ul>
      <button className="account-revoke" type="button" onClick={() => void revokeAll()} disabled={busy}>Log ud på alle enheder</button>
    </section>}
    {showPassword && <section className="session-panel" aria-label="Skift adgangskode">
      <h2>Skift adgangskode</h2>
      <label>Nuværende adgangskode<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} disabled={busy} /></label>
      <label>Ny adgangskode<input type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} disabled={busy} /></label>
      <label>Gentag ny adgangskode<input type="password" autoComplete="new-password" minLength={12} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} disabled={busy} /></label>
      <button className="btn" type="button" onClick={() => void changePassword()} disabled={busy || !currentPassword || !newPassword || !confirmPassword}>Skift adgangskode</button>
    </section>}
    {message && <span role="status" className="account-message">{message}</span>}
    {error && <span role="alert" className="account-error">{error}</span>}
  </div>;
}
