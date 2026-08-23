import type { CommandSpec } from "./_shared";

export const workspaceAccessSpecs: CommandSpec[] = [{
  key: "workspace-access bootstrap-first",
  usage: "workspace-access bootstrap-first --workspace <dir> --company <slug> --name <text> --email <mail> --password-file <path> --confirm yes --actor <id>",
  description: "Opretter den første private hosted-bruger for et workspace. Offentlig signup findes ikke.",
  allowedFlags: ["--workspace", "--company", "--name", "--email", "--password-file", "--confirm"],
  inputNotes: [
    "Kræver hosted Better Auth- og http-json-v1-konfiguration samt en actor godkendt i den valgte virksomheds policy.",
    "Password læses kun fra en almindelig fil med præcis 0600-rettigheder; filsti og indhold vises aldrig i output.",
    "--confirm yes kræves før password-filen eller databasen læses.",
  ],
}];
