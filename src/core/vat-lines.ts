import { roundDkk } from "./money";

export type VatLineClassification = "taxable" | "exempt" | "reverse_charge";
export type VatLineInput = { lineTotalExVat?: number; taxClassification?: VatLineClassification; vatRate?: number; reverseChargeBasis?: string };
export type VatLine = { taxClassification: VatLineClassification; vatBase: number; vatRate: number; vatAmount: number; reverseChargeBasis?: string };
export type VatLinesResult = { ok: boolean; lines: VatLine[]; netAmount: number; vatAmount: number; grossAmount: number; errors: string[] };

/** Project explicit tax lines. Missing classifications are only allowed for a
 * legacy uniform document, whose treatment supplies the unambiguous default. */
export function projectVatLines(lines: VatLineInput[] | undefined, legacyTreatment: "standard" | "domestic_reverse_charge" | "foreign_reverse_charge" = "standard", legacyRate?: number): VatLinesResult {
  const errors: string[] = [];
  const projected = (lines ?? []).map((line, index) => {
    const vatBase = roundDkk(Number(line.lineTotalExVat ?? 0));
    let taxClassification = line.taxClassification;
    if (!taxClassification) taxClassification = legacyTreatment === "standard" ? "taxable" : "reverse_charge";
    if (!Number.isFinite(vatBase) || vatBase < 0) errors.push(`lines[${index}].lineTotalExVat must be a non-negative number`);
    if (taxClassification !== "taxable" && taxClassification !== "exempt" && taxClassification !== "reverse_charge") errors.push(`lines[${index}].taxClassification must be taxable, exempt or reverse_charge`);
    const vatRate = taxClassification === "taxable" ? Number(line.vatRate ?? legacyRate) : 0;
    if (taxClassification === "taxable" && (!(vatRate > 0) || !Number.isFinite(vatRate))) errors.push(`lines[${index}].vatRate is required for taxable lines`);
    if (taxClassification === "reverse_charge" && !line.reverseChargeBasis && line.taxClassification) errors.push(`lines[${index}].reverseChargeBasis is required for reverse-charge lines`);
    return { taxClassification: taxClassification as VatLineClassification, vatBase, vatRate, vatAmount: taxClassification === "taxable" ? roundDkk(vatBase * vatRate) : 0, ...(line.reverseChargeBasis ? { reverseChargeBasis: line.reverseChargeBasis } : {}) };
  });
  const netAmount = roundDkk(projected.reduce((sum, line) => sum + line.vatBase, 0));
  const vatAmount = roundDkk(projected.reduce((sum, line) => sum + line.vatAmount, 0));
  return { ok: errors.length === 0, lines: projected, netAmount, vatAmount, grossAmount: roundDkk(netAmount + vatAmount), errors };
}
