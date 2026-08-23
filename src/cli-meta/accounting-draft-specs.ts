import type { CommandSpec } from "./_shared";

export const accountingDraftSpecs: CommandSpec[] = [
  { key: "accounting-draft create", usage: "accounting-draft create --company <path> --draft-id <id> --input <file.json>", description: "Opretter en append-only bogføringskladde uden at bogføre.", allowedFlags: ["--company", "--draft-id", "--input"] },
  { key: "accounting-draft revise", usage: "accounting-draft revise --company <path> --draft-id <id> --expected-event-hash <sha256> --input <file.json>", description: "Opretter en ny version af en redigerbar eller afvist kladde.", allowedFlags: ["--company", "--draft-id", "--expected-event-hash", "--input"] },
  { key: "accounting-draft submit", usage: "accounting-draft submit --company <path> --draft-id <id> --expected-event-hash <sha256>", description: "Indsender den præcise kladde-version til uafhængig review.", allowedFlags: ["--company", "--draft-id", "--expected-event-hash"] },
  { key: "accounting-draft reject", usage: "accounting-draft reject --company <path> --draft-id <id> --expected-event-hash <sha256> --reason <text>", description: "Afviser en indsendt kladde med begrundelse; reviewer skal være en anden actor.", allowedFlags: ["--company", "--draft-id", "--expected-event-hash", "--reason"] },
  { key: "accounting-draft approve-and-post", usage: "accounting-draft approve-and-post --company <path> --draft-id <id> --expected-event-hash <sha256> --confirm yes", description: "Godkender og bogfører atomisk den præcise indsendte version.", allowedFlags: ["--company", "--draft-id", "--expected-event-hash", "--confirm"] },
  { key: "accounting-draft show", usage: "accounting-draft show --company <path> --draft-id <id>", description: "Viser seneste append-only tilstand for én bogføringskladde.", allowedFlags: ["--company", "--draft-id"] },
  { key: "accounting-draft list", usage: "accounting-draft list --company <path>", description: "Lister seneste tilstand for alle bogføringskladder.", allowedFlags: ["--company"] },
];
