# Offline PDF parsing

Rentemester can extract a stored PDF's text with the locked `pdfjs-dist` runtime
(parser contract `document-pdf-text-v1`). It is an optional evidence aid, not a
bookkeeping authority: parsing never ingests, categorises, approves, or posts.
Agents bring their own decision policy and must request the explicit write.

Use `documents parse --company <path> --document-id 12 --confirm yes`, or MCP
`documents_parse` with `confirm:true`. Batch parsing is explicit (`parse-pending`)
and is limited to 100 documents; a text read is limited to 10 pages. Reads are
`parse-status` and `parsed-text` and do not mutate the ledger.

Results are deterministic and offline. Status is one of `ok`, `no_text_layer`,
`malformed_pdf`, `encrypted_pdf`, `unsupported_pdf`, or `resource_limit`; errors
are stable codes, never child stderr, paths, or secrets. `no_text_layer` retains
the authorized original-download route: it does not alter or replace the source.

The parser is `pdfjs-dist` 6.2.108 (Apache-2.0), bounded to 200 pages, 25,000
items/page, 200,000 items and 5 MiB text. It runs in a child with a 15-second
limit. HTTP mirrors CLI/MCP: POST `/documents/:id/parse` or `/documents/parse-pending`
requires `confirm:true`; GET `/parse-status` and `/parsed-text?offset=0&limit=10`
are read-only. The container uses non-root execution; run it with a read-only
root filesystem, `--network none`, and resource limits for isolated parsing.

## Stable public responses

CLI, HTTP and MCP use the same verified DTO. `parse-status` returns `{ parse }`,
where `parse` is `null` or `{ documentId, sourceSha256, parserId, parserVersion,
contractVersion, status, errorCode, pageCount, itemCount, textLength,
resultHash }`. It contains no database id, path, child command, stdout or stderr.

`parsed-text` returns `{ parse, pages, offset, limit, nextOffset }`; `limit` is
1–10. A page contains decoded `text`, dimensions, rotation, `itemCount`, and
`layoutHash`, never layout coordinates. The four tools are `documents_parse`,
`documents_parse_pending`, `documents_parse_status`, and
`documents_parsed_text`. Writes require the normal actor/auth policy and
`confirm:true`, return bounded summaries, and batches return canonical
`{ requested, parsed, failed, resume }` without nested worker messages.

This is BYO evidence interpretation: parser output has no bookkeeping authority
and never posts a transaction. `PDF_PARSE_FAILED` is the stable write-boundary
code; persisted parser status exposes stable parser error codes. The versioned
contract is `document-pdf-text-v1`; `pdfjs-dist@6.2.108` is Apache-2.0 and the
offline parser does not send documents to third parties.
