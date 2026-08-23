import type { CommandSpec } from "./_shared";

export const workspaceSnapshotSpecs: CommandSpec[] = [
  {
    key: "workspace snapshot",
    usage: "workspace snapshot --workspace <dir> --out <snapshot.tar> --confirm yes --actor <id> [--at <ISO-8601>]",
    description: "Opretter én credential-fri, checksummet snapshotfil med alle selskaber og en adgangsgenoprettelsesplan.",
    allowedFlags: ["--workspace", "--out", "--confirm", "--at"],
    inputNotes: [
      "Password-hashes, sessions, MFA/recovery-data samt DigiSense-, SMTP- og IMAP-credentials udelades altid.",
      "Actor skal være tilladt i hvert registreret selskab; --confirm yes kræves før nogen ledger ændres.",
    ],
  },
  {
    key: "workspace restore",
    usage: "workspace restore --snapshot <snapshot.tar> --target-workspace <dir> --confirm yes --actor <id>",
    description: "Verificerer og gendanner en credential-fri workspace-snapshot atomisk til en ny eller tom mappe.",
    allowedFlags: ["--snapshot", "--target-workspace", "--confirm"],
    inputNotes: [
      "Målet må ikke indeholde data. En eksisterende workspace eller ledger overskrives aldrig.",
      "Efter restore skal én ejer bootstrappes, og de øvrige brugere inviteres igen ud fra den private genoprettelsesplan.",
    ],
  },
];
