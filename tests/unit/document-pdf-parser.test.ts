import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parsePdfBytes, PDF_PARSER_CONTRACT_VERSION } from "../../src/core/document-pdf-parser";
import { SYNTHETIC_PDF_TEXT, syntheticTextPdf } from "../fixtures/pdf-parser/synthetic-text-pdf";

test("PDF parser is offline, deterministic and binds its response to input bytes", async () => {
  const bytes = new TextEncoder().encode("not a PDF");
  const first = await parsePdfBytes(bytes);
  const second = await parsePdfBytes(bytes);
  expect(first).toEqual(second);
  expect(first.contractVersion).toBe(PDF_PARSER_CONTRACT_VERSION);
  expect(first.inputSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(first.status).toBe("malformed_pdf");
});

test("PDF parser extracts deterministic text and layout from the synthetic fixture", async () => {
  const parsed = await parsePdfBytes(syntheticTextPdf());
  expect(parsed.status).toBe("ok");
  expect(parsed.pages).toHaveLength(1);
  expect(parsed.pages[0]?.text).toBe(SYNTHETIC_PDF_TEXT);
  expect(parsed.pages[0]?.layout.map((item) => item.text).join("\n")).toBe(SYNTHETIC_PDF_TEXT);
  expect(parsed.pages[0]?.width).toBe(612);
  expect(parsed.pages[0]?.height).toBe(792);
});
