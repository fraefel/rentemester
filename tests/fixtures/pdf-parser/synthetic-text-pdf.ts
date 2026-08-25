/** A tiny deterministic PDF fixture containing no customer data. */
export const SYNTHETIC_PDF_TEXT = "Synthetic parser evidence\nInvoice SYN-001";

function syntheticPdf(stream: string): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "binary"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}

export function syntheticTextPdf(): Uint8Array {
  return syntheticPdf(`BT\n/F1 18 Tf\n72 720 Td\n(Synthetic parser evidence) Tj\n0 -28 Td\n(Invoice SYN-001) Tj\nET\n`);
}

/** Valid one-page PDF with no text layer, used for the supported no-text path. */
export function syntheticNoTextPdf(): Uint8Array { return syntheticPdf(""); }
