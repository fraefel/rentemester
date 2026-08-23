import { describe, expect, test } from "bun:test";
import { createSupplyChainEvidence } from "../../scripts/release/create-supply-chain-evidence";

const licenses = {
  MIT: [{ name: "synthetic-package", versions: ["1.0.0"], license: "MIT" }],
};

describe("release supply-chain evidence", () => {
  test("binds a clean audit and approved licenses to the exact lockfile bytes", () => {
    const first = createSupplyChainEvidence({
      auditReport: {}, licenseReport: licenses, lockfileBytes: new TextEncoder().encode("lock-a"), bunVersion: "1.4.0",
    });
    const second = createSupplyChainEvidence({
      auditReport: {}, licenseReport: licenses, lockfileBytes: new TextEncoder().encode("lock-a"), bunVersion: "1.4.0",
    });
    expect(first).toEqual(second);
    expect(first.audit.advisoryCount).toBe(0);
    expect(first.licenses.packageCount).toBe(1);
    expect(first.lockfile.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("fails closed on any advisory or unapproved license", () => {
    const base = { lockfileBytes: new Uint8Array(), bunVersion: "1.4.0" };
    expect(() => createSupplyChainEvidence({ ...base, auditReport: { pkg: [{}] }, licenseReport: licenses })).toThrow("1 advisories");
    expect(() => createSupplyChainEvidence({ ...base, auditReport: {}, licenseReport: { GPL: [{ name: "x", versions: ["1"], license: "GPL" }] } })).toThrow("unapproved license");
  });
});
