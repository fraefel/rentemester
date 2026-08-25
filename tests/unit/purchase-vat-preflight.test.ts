import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../src/core/db";
import { ensurePurchaseVatPreflight, inspectPurchaseVatPreflight } from "../../src/core/purchase-vat-preflight";

const clock = { now: () => new Date("2026-08-01T10:00:00.000Z") };
function setup() {
  const db = new Database(":memory:"); migrate(db);
  db.run("INSERT INTO documents(id,source,sha256_hash,sender_vat_cvr,supplier_country_code,supplier_identifier_kind,supplier_identity_status) VALUES(1,'test','preflight-document','DE123456789','DE','eu_vat','resolved')");
  return db;
}

describe("purchase VAT preflight", () => {
  test("dry-run is pure, then reuses explicit fresh provider evidence", async () => {
    const db = setup(); let calls = 0;
    const dry = inspectPurchaseVatPreflight(db, 1, { clock });
    expect(dry).toMatchObject({ ok: false, classification: "EU", wouldCallProvider: true, cached: false });
    expect(db.query("SELECT COUNT(*) AS n FROM vat_validation_events").get()).toEqual({ n: 0 });
    const provider = { validate: async () => { calls++; return { status: "valid" as const, name: "Synthetic GmbH", address: "Berlin" }; } };
    const first = await ensurePurchaseVatPreflight(db, 1, provider, { clock, actor: "agent:test" });
    expect(first).toMatchObject({ ok: true, reusedEvidence: false });
    const second = await ensurePurchaseVatPreflight(db, 1, provider, { clock, actor: "agent:test" });
    expect(second).toMatchObject({ ok: true, reusedEvidence: true });
    expect(calls).toBe(1);
    expect(db.query("SELECT event_type, provider_status, actor, created_at FROM vat_validation_events ORDER BY id").all()).toEqual([
      { event_type: "provider_requested", provider_status: "requested", actor: "agent:test", created_at: "2026-08-01T10:00:00.000Z" },
      { event_type: "provider_result", provider_status: "valid", actor: "agent:test", created_at: "2026-08-01T10:00:00.000Z" },
      { event_type: "preflight_passed", provider_status: "valid", actor: "agent:test", created_at: "2026-08-01T10:00:00.000Z" },
    ]);
    db.close();
  });

  test("provider unavailability is a resumable, deduplicated exception", async () => {
    const db = setup();
    const provider = { validate: async () => ({ status: "unavailable" as const }) };
    const first = await ensurePurchaseVatPreflight(db, 1, provider, { clock, actor: "agent:test" });
    const second = await ensurePurchaseVatPreflight(db, 1, provider, { clock, actor: "agent:test" });
    expect(first.ok).toBe(false); expect(second.exceptionId).toBe(first.exceptionId);
    expect(db.query("SELECT COUNT(*) AS n FROM exceptions WHERE type='PURCHASE_VAT_PREFLIGHT'").get()).toEqual({ n: 1 });
    db.close();
  });
});
