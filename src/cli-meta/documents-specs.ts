import type { CommandSpec } from "./_shared";

export const documentsSpecs: CommandSpec[] = [
  { key: "documents ingest", usage: "documents ingest --company <path> --file <path> --metadata <file.json> [--vendor-id <n>] [--force]", description: "Indlæser og validerer et bilag med metadata.", allowedFlags: ["--company", "--file", "--metadata", "--vendor-id", "--force"], examplePath: "examples/vendor-invoice.metadata.json", exampleNote: "Eksemplet er KUN --metadata-payloaden, ikke et komplet kald: gem det til en fil og send den med --metadata sammen med --company og --file." },
  { key: "documents list", usage: "documents list --company <path>", description: "Lister gemte bilag.", allowedFlags: ["--company"] },
  { key: "documents extract-invoice", usage: "documents extract-invoice --company <path> --document-id <n>", description: "Udtrækker citerbar fakturaevidens fra et gemt PDF-bilag.", allowedFlags: ["--company", "--document-id"] },
  { key: "documents invoice-extraction", usage: "documents invoice-extraction --company <path> --document-id <n>", description: "Viser fakturaudtræk og undtagelsesstatus uden filsti.", allowedFlags: ["--company", "--document-id"] },
  { key: "documents parse", usage: "documents parse --company <path> --document-id <n> --confirm yes", description: "Parser et allerede gemt PDF-bilag offline; udfører ingen bogføring.", allowedFlags: ["--company", "--document-id", "--confirm"] },
  { key: "documents parse-pending", usage: "documents parse-pending --company <path> --confirm yes [--limit <n>] [--cursor <n>]", description: "Parser op til 100 gemte PDF-bilag uden en aktuel parse; genoptag med nextCursor som --cursor.", allowedFlags: ["--company", "--confirm", "--limit", "--cursor"] },
  { key: "documents parse-status", usage: "documents parse-status --company <path> --document-id <n>", description: "Viser den seneste PDF-parserstatus uden filsti eller child-stderr.", allowedFlags: ["--company", "--document-id"] },
  { key: "documents parsed-text", usage: "documents parsed-text --company <path> --document-id <n> [--offset <n>] [--limit <n>]", description: "Viser højst 10 parse-sider ad gangen.", allowedFlags: ["--company", "--document-id", "--offset", "--limit"] },
];
