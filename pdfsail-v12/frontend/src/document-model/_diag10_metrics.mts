/** diag10 — does parsePdfFontMetrics throw for this PDF? */
import * as fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { parsePdfFontMetrics } from "./pdf-font-metrics";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf";

async function main() {
  const bytes = fs.readFileSync(ORIG);
  const pdfLibDoc = await PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true, throwOnInvalidObject: false });
  try {
    const m = parsePdfFontMetrics(pdfLibDoc);
    console.log("parsePdfFontMetrics OK, pages:", m?.length ?? "undefined");
  } catch (e) {
    console.log("parsePdfFontMetrics THREW:", (e as Error).message);
    console.log((e as Error).stack?.split("\n").slice(0, 6).join("\n"));
  }
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
