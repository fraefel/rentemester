import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { parseRegisteredPdfBatch } from "../../src/core/document-pdf-parser";

test("PDF batch bounds requests before opening a source", async () => {
  const db = new Database(":memory:");
  await expect(parseRegisteredPdfBatch(db, "/missing", Array.from({ length: 101 }, (_, i) => i + 1))).rejects.toThrow("limit is 100");
  await expect(parseRegisteredPdfBatch(db, "/missing", [], { concurrency: 5 })).rejects.toThrow("between 1 and 4");
  expect(await parseRegisteredPdfBatch(db, "/missing", [])).toEqual([]);
  db.close();
});
