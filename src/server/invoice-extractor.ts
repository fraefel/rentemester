/**
 * Explicit, bounded invoice extraction provider boundary.  No provider is
 * selected by default: production operators must opt in and document their
 * processor before PDF bytes leave Rentemester.
 */
import type { InvoiceExtractor, InvoiceExtractorInput, InvoiceExtractorOutput } from "../core/invoice-extraction";

export const INVOICE_EXTRACTION_ENV = {
  provider: "RENTEMESTER_INVOICE_EXTRACTION_PROVIDER",
  url: "RENTEMESTER_INVOICE_EXTRACTION_URL",
  bearerToken: "RENTEMESTER_INVOICE_EXTRACTION_BEARER_TOKEN",
  timeoutMs: "RENTEMESTER_INVOICE_EXTRACTION_TIMEOUT_MS",
} as const;

export type HttpJsonV1InvoiceExtractorConfig = { provider: "http-json-v1"; url: string; bearerToken: string; timeoutMs: number };

export function resolveConfiguredInvoiceExtractor(env: Record<string, string | undefined> = process.env): InvoiceExtractor | null {
  const provider = (env[INVOICE_EXTRACTION_ENV.provider] ?? "disabled").trim().toLowerCase();
  if (provider === "disabled" || provider === "") return null;
  if (provider !== "http-json-v1") throw new Error(`${INVOICE_EXTRACTION_ENV.provider} must be 'http-json-v1' or 'disabled'`);
  const token = env[INVOICE_EXTRACTION_ENV.bearerToken]?.trim() ?? "";
  const rawUrl = env[INVOICE_EXTRACTION_ENV.url]?.trim() ?? "";
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error(`${INVOICE_EXTRACTION_ENV.url} must be an absolute HTTPS URL`); }
  if (url.protocol !== "https:" || !token) throw new Error("invoice extraction provider requires HTTPS URL and bearer token");
  const timeoutMs = Number(env[INVOICE_EXTRACTION_ENV.timeoutMs] ?? 15_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error(`${INVOICE_EXTRACTION_ENV.timeoutMs} must be an integer between 100 and 120000`);
  return createHttpJsonV1InvoiceExtractor({ provider: "http-json-v1", url: url.toString(), bearerToken: token, timeoutMs });
}

export function createHttpJsonV1InvoiceExtractor(config: HttpJsonV1InvoiceExtractorConfig): InvoiceExtractor {
  return {
    id: "http-json-v1", version: "1",
    supports: () => true,
    async extract(input: InvoiceExtractorInput): Promise<InvoiceExtractorOutput> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetch(config.url, { method: "POST", signal: controller.signal, headers: { authorization: `Bearer ${config.bearerToken}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ sha256: input.sha256, pdfBytesBase64: input.pdfBytes.toString("base64") }) });
        if (!response.ok) throw new Error("provider rejected extraction request");
        const body = await response.json() as { fields?: unknown };
        if (!body || !Array.isArray(body.fields)) throw new Error("provider returned invalid extraction response");
        return { fields: body.fields as InvoiceExtractorOutput["fields"] };
      } finally { clearTimeout(timer); controller.abort(); }
    },
  };
}
