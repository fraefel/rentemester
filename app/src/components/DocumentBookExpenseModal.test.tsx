import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { DocumentBookExpenseModal } from "./DocumentBookExpenseModal";
import { mockFetch } from "../test/fixtures";

describe("DocumentBookExpenseModal", () => {
  test("#529/#530 shows durable supplier identity and the exact purchase VAT split", async () => {
    mockFetch({
      "GET /api/companies/acme-aps/documents/1/booking-options": {
        options: {
          document: {
            id: 1,
            documentNo: "DOC-2026-000001",
            documentType: "purchase_sale",
            invoiceNo: "US-529",
            invoiceDate: "2026-07-18",
            supplierName: "US SaaS Inc.",
            supplierVatOrCvr: null,
            supplierCountryCode: "US",
            supplierIdentifierKind: "non_eu",
            supplierIdentityStatus: "resolved",
            purchaseVatLines: [
              { classification: "dk_purchase_25", netAmount: 975, vatAmount: 243.75 },
              { classification: "exempt", netAmount: 670, vatAmount: 0 },
            ],
            amountIncVat: 1888.75,
            vatAmount: 243.75,
            currency: "DKK",
          },
          expenseAccounts: [{ accountNo: "3000", name: "Software", defaultVatCode: "DK_PURCHASE_25" }],
          unmatchedOutgoingBank: [{ id: 1, date: "2026-07-18", text: "US SaaS", amount: -1888.75, currency: "DKK", reference: null }],
        },
      },
    });

    render(
      <DocumentBookExpenseModal
        slug="acme-aps"
        documentId={1}
        onBooked={() => {}}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText(/Leverandøridentitet: US · non_eu · resolved/)).toBeInTheDocument();
    expect(screen.getByLabelText("Momsfordeling")).toHaveTextContent("dk_purchase_25");
    expect(screen.getByLabelText("Momsfordeling")).toHaveTextContent("exempt");
    expect(screen.getByLabelText("Moms-behandling (valgfri — udledes ellers af kontoen)")).toHaveTextContent("Omvendt betalingspligt (udenlandsk ydelse)");
  });
});
