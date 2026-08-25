/** Thin transport/presentation adapter around the purchase VAT preflight core.
 * It deliberately exposes only durable, safe evidence fields; provider bodies
 * and other raw responses never cross a CLI, MCP, or HTTP boundary. */
import type { Database } from "bun:sqlite";
import {
  ensurePurchaseVatPreflight,
  inspectPurchaseVatPreflight,
  type VatValidationProvider,
} from "../core/purchase-vat-preflight";
import { createOfficialEuViesProvider } from "../core/vies";

export function purchaseVatProvider(): VatValidationProvider {
  return createOfficialEuViesProvider({ baseUrl: process.env.RENTEMESTER_VIES_ENDPOINT });
}

type EventRow = { id: number; event_type: string; classification: string; provider_status: string; evidence_expires_at: string | null; created_at: string; actor: string | null };
type ExceptionRow = { id: number; status: string; severity: string; message: string; required_action: string | null; created_at: string };

/** A surface-neutral snapshot suitable for dry-runs and post-apply results. */
export function purchaseVatPreflightSnapshot(db: Database, documentId: number) {
  const inspection = inspectPurchaseVatPreflight(db, documentId);
  const evidence = db.query("SELECT id,event_type,classification,provider_status,evidence_expires_at,created_at,actor FROM vat_validation_events WHERE document_id = ? ORDER BY id DESC LIMIT 20").all(documentId) as EventRow[];
  const exception = db.query("SELECT id,status,severity,message,required_action,created_at FROM exceptions WHERE related_document_id = ? AND type = 'PURCHASE_VAT_PREFLIGHT' ORDER BY id DESC LIMIT 1").get(documentId) as ExceptionRow | null;
  return {
    ...inspection,
    derivedRegion: inspection.classification,
    requiredValidation: inspection.classification === "EU" ? "EU VAT provider validation" : null,
    cache: { reused: inspection.cached, freshUntil: inspection.evidenceExpiresAt },
    applyWouldCallProvider: inspection.wouldCallProvider,
    evidence,
    exception: exception ? { id: exception.id, status: exception.status, severity: exception.severity, message: exception.message, requiredAction: exception.required_action, createdAt: exception.created_at } : null,
  };
}

export async function applyPurchaseVatPreflight(db: Database, documentId: number, actor: string) {
  await ensurePurchaseVatPreflight(db, documentId, purchaseVatProvider(), { actor });
  return purchaseVatPreflightSnapshot(db, documentId);
}
