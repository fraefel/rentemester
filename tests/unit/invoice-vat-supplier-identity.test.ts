import { describe, expect, test } from "bun:test";
import { resolveSupplierIdentity } from "../../src/core/supplier-identity";
import { projectVatLines } from "../../src/core/vat-lines";
import { validateInvoice } from "../../src/core/invoice";

describe("supplier identity and mixed VAT lines", () => {
  test("does not treat a non-EU supplier identity as EU VAT registration", () => {
    expect(resolveSupplierIdentity({ country: "US", identifier: "12-3456789", identifierKind: "non_eu" })).toMatchObject({ ok: true, euVatRegistered: false });
    expect(resolveSupplierIdentity({ country: "US", identifier: "US123", identifierKind: "eu_vat" })).toMatchObject({ ok: false, status: "human_resolution_required" });
    expect(resolveSupplierIdentity({ country: "DE", identifier: "123" })).toMatchObject({ ok: false, status: "human_resolution_required" });
  });

  test("projects, validates and totals explicit mixed tax lines", () => {
    const lines = [
      { description: "Taxable", quantity: 1, unitPriceExVat: 100, lineTotalExVat: 100, taxClassification: "taxable" as const, vatRate: 0.25 },
      { description: "Exempt", quantity: 1, unitPriceExVat: 50, lineTotalExVat: 50, taxClassification: "exempt" as const },
      { description: "Reverse", quantity: 1, unitPriceExVat: 25, lineTotalExVat: 25, taxClassification: "reverse_charge" as const, reverseChargeBasis: "EU_MOMSDIREKTIV_ART_196" },
    ];
    expect(projectVatLines(lines)).toMatchObject({ ok: true, netAmount: 175, vatAmount: 25, grossAmount: 200 });
    expect(validateInvoice({
      invoiceType: "full", issueDate: "2026-07-18", seller: { name: "Seller", address: "Street", vatOrCvr: "DK12345678" }, buyer: { name: "Buyer", address: "Street" }, lines,
      totals: { netAmount: 175, vatAmount: 25, grossAmount: 200 },
    }).ok).toBe(true);
  });
});
