/**
 * Vendor-neutral document malware scanner boundary.
 *
 * The `http-json-v1` protocol is intentionally small: deployments own the
 * scanner service and its credentials, while Rentemester only sends a private
 * byte copy and accepts a clean/rejected decision.  Neither URLs nor tokens
 * are returned to callers or written to request logs.
 */
import type { DocumentScanner } from "../core/documents";

export type HttpJsonV1DocumentScannerConfig = {
  provider: "http-json-v1";
  url: string;
  bearerToken: string;
  timeoutMs: number;
};

type ScannerResponse = {
  ok?: unknown;
  scannerId?: unknown;
  scannerVersion?: unknown;
  evidenceRef?: unknown;
};

export function createHttpJsonV1DocumentScanner(config: HttpJsonV1DocumentScannerConfig): DocumentScanner {
  return {
    async scan(input) {
      const response = await fetch(config.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.bearerToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          sha256: input.sha256,
          mimeType: input.mimeType,
          filename: input.filename,
          // The core passes a scanner-only copy. This service must treat it as
          // untrusted input and return no sensitive diagnostic material.
          bytesBase64: input.bytes.toString("base64"),
        }),
        signal: input.signal,
      });
      if (!response.ok) return { ok: false };
      let body: ScannerResponse;
      try {
        body = await response.json() as ScannerResponse;
      } catch {
        return { ok: false };
      }
      if (body.ok !== true || typeof body.scannerId !== "string" || body.scannerId.trim().length === 0) {
        return { ok: false };
      }
      return {
        ok: true,
        scannerId: body.scannerId,
        ...(typeof body.scannerVersion === "string" ? { scannerVersion: body.scannerVersion } : {}),
        ...(typeof body.evidenceRef === "string" ? { evidenceRef: body.evidenceRef } : {}),
      };
    },
  };
}
