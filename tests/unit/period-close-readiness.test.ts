import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, migrate } from "../../src/core/db";
import { createPeriodCloseReadinessPacket, listPeriodCloseOpenItems } from "../../src/core/period-close-readiness";
import { closeAccountingPeriod, reopenAccountingPeriod } from "../../src/core/periods";

const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "rm-period-close-")); roots.push(root); const db = openDb(join(root, "ledger.sqlite")); migrate(db); return db; }
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("#580 period-close readiness", () => {
  test("persists a replay-safe packet, rejects stale/missing hashes, and records a normal decision", () => {
    const db = fixture(); const packet = createPeriodCloseReadinessPacket(db, { periodStart: "2025-01-01", periodEnd: "2025-01-31" });
    expect(closeAccountingPeriod(db, { periodStart: "2025-01-01", periodEnd: "2025-01-31", kind: "custom", readinessPacketHash: "0".repeat(64) }).errors).toContain("PERIOD_CLOSE_PACKET_STALE_OR_MISSING");
    const closed = closeAccountingPeriod(db, { periodStart: "2025-01-01", periodEnd: "2025-01-31", kind: "custom", readinessPacketHash: packet.hash, createdBy: "user:test" });
    expect(closed.ok).toBe(true);
    expect(db.query("SELECT decision FROM period_close_decisions").all()).toEqual([{ decision: "closed" }]);
    expect(() => db.run("UPDATE period_close_readiness_packets SET cutoff='x'")).toThrow(); db.close();
  });

  test("blocks unreconciled bank activity and creates durable forced-close obligations", () => {
    const db = fixture(); db.run("INSERT INTO bank_transactions(transaction_date,text,amount,currency) VALUES('2025-01-02','synthetic',100,'DKK')");
    const packet = createPeriodCloseReadinessPacket(db, { periodStart: "2025-01-01", periodEnd: "2025-01-31" }); expect(packet.items.map(x => x.code)).toContain("BANK_UNRECONCILED");
    expect(closeAccountingPeriod(db, { periodStart: "2025-01-01", periodEnd: "2025-01-31", kind: "custom", readinessPacketHash: packet.hash, createdBy: "user:test" }).ok).toBe(false);
    const forced = closeAccountingPeriod(db, { periodStart: "2025-01-01", periodEnd: "2025-01-31", kind: "custom", readinessPacketHash: packet.hash, force: true, forceAuthorized: true, forceConfirmed: true, forceReason: "synthetic waiver", createdBy: "user:test" });
    expect(forced.ok).toBe(true); expect(listPeriodCloseOpenItems(db, forced.periodId!).length).toBeGreaterThan(0); db.close();
  });

  test("reopen appends and supersedes history", () => {
    const db = fixture(); const packet = createPeriodCloseReadinessPacket(db, { periodStart: "2025-02-01", periodEnd: "2025-02-28" }); const closed = closeAccountingPeriod(db, { periodStart: "2025-02-01", periodEnd: "2025-02-28", kind: "custom", readinessPacketHash: packet.hash, createdBy: "user:test" });
    const reopened = reopenAccountingPeriod(db, { periodStart: "2025-02-01", periodEnd: "2025-02-28", kind: "custom", reason: "synthetic correction", createdBy: "user:test" }); expect(reopened.ok).toBe(true);
    expect(db.query("SELECT decision,supersedes_decision_id FROM period_close_decisions ORDER BY id").all()).toEqual([{ decision: "closed", supersedes_decision_id: null }, { decision: "reopened", supersedes_decision_id: closed.periodId }]); db.close();
  });
});
