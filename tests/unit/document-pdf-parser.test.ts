import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parsePdfBytes, PDF_PARSER_CONTRACT_VERSION } from "../../src/core/document-pdf-parser";

test("PDF parser is offline, deterministic and binds its response to input bytes", async () => {
  const bytes = new TextEncoder().encode("not a PDF");
  const first = await parsePdfBytes(bytes);
  const second = await parsePdfBytes(bytes);
  expect(first).toEqual(second);
  expect(first.contractVersion).toBe(PDF_PARSER_CONTRACT_VERSION);
  expect(first.inputSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(first.status).toBe("malformed_pdf");
});
