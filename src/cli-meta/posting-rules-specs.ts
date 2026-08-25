import type { CommandSpec } from "./_shared";

const common = ["--company", "--format"];
export const postingRulesSpecs: CommandSpec[] = [
  { key: "posting-rules propose", usage: "posting-rules propose --company <path> --input <json>", description: "Opretter et hash-bundet forslag til en selskabslokal posteringsregel.", allowedFlags: [...common, "--input", "--actor"] },
  { key: "posting-rules approve", usage: "posting-rules approve --company <path> --rule-id <id> --version <n> --expected-payload-hash <sha256> --rationale <text> --provenance <text> [--effective-at <ISO>]", description: "Godkender en andens præcise foreslåede regelversion.", allowedFlags: [...common, "--rule-id", "--version", "--expected-payload-hash", "--rationale", "--provenance", "--effective-at", "--actor"] },
  { key: "posting-rules disable", usage: "posting-rules disable --company <path> --rule-id <id> --version <n> --expected-payload-hash <sha256> --rationale <text> --provenance <text>", description: "Deaktiverer en godkendt regel med audit-evidens.", allowedFlags: [...common, "--rule-id", "--version", "--expected-payload-hash", "--rationale", "--provenance", "--effective-at", "--actor"] },
  { key: "posting-rules supersede", usage: "posting-rules supersede --company <path> --rule-id <id> --version <n> --expected-payload-hash <sha256> --rationale <text> --provenance <text>", description: "Erstatter en godkendt regelversion med audit-evidens.", allowedFlags: [...common, "--rule-id", "--version", "--expected-payload-hash", "--rationale", "--provenance", "--effective-at", "--actor"] },
  { key: "posting-rules explain", usage: "posting-rules explain --company <path> --context <json> [--at <ISO>]", description: "Forklarer præcist match, ikke-match og evidensafvigelser uden at skrive.", allowedFlags: [...common, "--context", "--at"] },
  { key: "posting-rules test", usage: "posting-rules test --company <path> --context <json> [--at <ISO>]", description: "Dry-run af historisk dokumentkontekst; skriver aldrig og returnerer alle afvigelsesårsager.", allowedFlags: [...common, "--context", "--at"] },
];
