// Legacy workspace company lookup. Workspace reads never adopt directories.
//
// A workspace is a directory holding one company subdirectory per `slug`
// (`<workspace>/<slug>/`), indexed by a `workspace.json` manifest. The manifest
// is the cockpit's source of truth for "which companies exist".
//
// But a company directory can land in the workspace WITHOUT being in the
// manifest: an owner who set up a company with the CLI's `--company <path>`
// flow (or copied a finished company directory in) has a fully populated
// `<workspace>/<slug>/data/ledger.sqlite` that the manifest never recorded.
// Before #256 the cockpit then showed "0 virksomheder" and — worse — letting
// the owner "create" that company minted a new, empty ledger over a blank
// slug, hiding the real data behind a blank screen.
//
// `discoverWorkspaceCompanies` closes that gap: before every company-list /
// portfolio read it scans the workspace for present-but-unlisted company
// directories and registers them into the manifest (the same adoption
// `registerCompanyDirIntoWorkspace` performs for `rentemester init`). The
// cockpit then shows the real company with its real data. It is deliberately
// forgiving — a non-company directory, an unreadable entry or a slug clash is
// skipped, never thrown — so a stray directory can never break the cockpit.

import {
  listWorkspaceCompanies,
  workspaceExists,
  type WorkspaceCompanyEntry,
} from "../core/workspace";

/**
 * Kept as a compatibility name for callers introduced before #597. It is a
 * manifest-only read: present-but-unregistered directories remain invisible.
 */
export function discoverWorkspaceCompanies(
  workspaceRoot: string,
): WorkspaceCompanyEntry[] {
  return workspaceExists(workspaceRoot) ? listWorkspaceCompanies(workspaceRoot) : [];
}
