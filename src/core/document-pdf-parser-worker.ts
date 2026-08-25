import { createHash } from "node:crypto";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const CONTRACT_VERSION = "document-pdf-text-v1";
const MAX_PAGES = 200, MAX_ITEMS_PAGE = 25_000, MAX_ITEMS = 200_000, MAX_TEXT = 5 * 1024 * 1024;
const round = (value: number) => Math.round(value * 1000) / 1000;
const fail = (code: string, hash: string) => process.stdout.write(JSON.stringify({ contractVersion: CONTRACT_VERSION, inputSha256: hash, status: code === "no_text_layer" ? code : "resource_limit", errorCode: code, pages: [] }) + "\n");

async function main() {
  const bytes = new Uint8Array(await Bun.stdin.arrayBuffer());
  const inputSha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false, useSystemFonts: false, disableFontFace: true, disableRange: true, disableStream: true, disableAutoFetch: true, stopAtErrors: true, verbosity: 0 } as any);
    const pdf = await task.promise;
    if (pdf.numPages > MAX_PAGES) return fail("page_limit", inputSha256);
    const pages: unknown[] = []; let totalItems = 0, textLength = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      const items = content.items.filter((item): item is any => "str" in item);
      if (items.length > MAX_ITEMS_PAGE || totalItems + items.length > MAX_ITEMS) return fail("item_limit", inputSha256);
      // pdf.js supplies both directional runs and explicit EOL boundaries.
      // Keep them as evidence and make the rendered text deterministic without
      // silently collapsing meaningful line endings.
      const layout = items.map((item) => ({ text: String(item.str).normalize("NFC"), x: round(item.transform[4]), y: round(item.transform[5]), width: round(item.width), height: round(item.height), font: String(item.fontName ?? ""), dir: String(item.dir ?? ""), hasEol: Boolean(item.hasEOL) }));
      const text = layout.map((item) => item.text + (item.hasEol ? "\n" : "")).join("").replace(/\r\n?/g, "\n").normalize("NFC");
      textLength += text.length; if (textLength > MAX_TEXT) return fail("text_limit", inputSha256);
      totalItems += layout.length;
      pages.push({ pageNumber, width: round(viewport.width), height: round(viewport.height), rotation: viewport.rotation, text, layout });
    }
    const status = totalItems === 0 ? "no_text_layer" : "ok";
    process.stdout.write(JSON.stringify({ contractVersion: CONTRACT_VERSION, inputSha256, status, errorCode: status === "ok" ? null : "no_text_layer", pages }) + "\n");
  } catch (error) {
    const name = String((error as { name?: string })?.name ?? "");
    const message = String((error as { message?: string })?.message ?? "").toLowerCase();
    const code = name.includes("Password") || message.includes("password") ? "encrypted_pdf" : message.includes("invalid") || message.includes("malformed") ? "malformed_pdf" : "unsupported_pdf";
    process.stdout.write(JSON.stringify({ contractVersion: CONTRACT_VERSION, inputSha256, status: code, errorCode: code, pages: [] }) + "\n");
  }
}
void main();
