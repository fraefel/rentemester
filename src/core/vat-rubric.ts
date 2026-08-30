import { addDkk, subtractDkk } from "./money";
import type { VatPeriodReport } from "./vat";

/** Canonical SKAT momsangivelse projection shared by every delivery surface. */
export type VatRubric = {
  salgsmoms: number;
  momsAfVarekobUdland: number;
  momsAfYdelseskobUdland: number;
  kobsmoms: number;
  momstilsvar: number;
  rubrikA: number;
  rubrikB: number;
  rubrikC: number;
};

export function emptyVatRubric(): VatRubric {
  return { salgsmoms: 0, momsAfVarekobUdland: 0, momsAfYdelseskobUdland: 0, kobsmoms: 0, momstilsvar: 0, rubrikA: 0, rubrikB: 0, rubrikC: 0 };
}

/**
 * The single rubric mapping. The booked output-VAT control position includes
 * reverse-charge VAT for both foreign services and EU-goods acquisitions;
 * both are removed from salgsmoms before being placed in their dedicated
 * rubrics. Domestic reverse charge belongs in C and foreign reverse charge in
 * B.
 */
export function projectVatRubric(report: VatPeriodReport): VatRubric {
  const momsAfVarekobUdland = report.euGoodsAcquisitionPurchaseBase > 0
    ? report.euGoodsAcquisitionOutputVat
    : 0;
  const momsAfYdelseskobUdland = subtractDkk(
    report.reverseChargePurchaseOutputVat,
    momsAfVarekobUdland,
  );
  const salgsmoms = subtractDkk(
    report.outputVat,
    addDkk(momsAfVarekobUdland, momsAfYdelseskobUdland),
  );
  const kobsmoms = report.inputVat;
  return {
    salgsmoms,
    momsAfVarekobUdland,
    momsAfYdelseskobUdland,
    kobsmoms,
    momstilsvar: subtractDkk(addDkk(salgsmoms, momsAfVarekobUdland, momsAfYdelseskobUdland), kobsmoms),
    rubrikA: addDkk(report.reverseChargePurchaseBase, report.euGoodsAcquisitionPurchaseBase),
    rubrikB: report.foreignReverseChargeSalesBase,
    rubrikC: addDkk(report.exemptSalesBase, report.domesticReverseChargeSalesBase),
  };
}
