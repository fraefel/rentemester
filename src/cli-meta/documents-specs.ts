import type { CommandSpec } from "./_shared";

export const documentsSpecs: CommandSpec[] = [
  { key: "documents ingest", usage: "documents ingest --company <path> --file <path> --metadata <file.json> [--vendor-id <n>] [--force]", description: "Indlæser og validerer et bilag med metadata.", allowedFlags: ["--company", "--file", "--metadata", "--vendor-id", "--force"], examplePath: "examples/vendor-invoice.metadata.json", exampleNote: "Eksemplet er KUN --metadata-payloaden, ikke et komplet kald: gem det til en fil og send den med --metadata sammen med --company og --file." },
  { key: "documents list", usage: "documents list --company <path>", description: "Lister gemte bilag.", allowedFlags: ["--company"] },
  { key: "documents extract-invoice", usage: "documents extract-invoice --company <path> --document-id <n>", description: "Udtrækker citerbar fakturaevidens fra et gemt PDF-bilag.", allowedFlags: ["--company", "--document-id"] },
  { key: "documents invoice-extraction", usage: "documents invoice-extraction --company <path> --document-id <n>", description: "Viser fakturaudtræk og undtagelsesstatus uden filsti.", allowedFlags: ["--company", "--document-id"] },
];
