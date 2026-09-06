/** diag8 — why assignOperatorProvenance yields nothing for this PDF */
import * as fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { resolvePageShowTextWithXObjects } from "./content-stream-resolver";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf";

async function main() {
  const bytes = fs.readFileSync(ORIG);
  let pdfLibDoc: PDFDocument | undefined;
  try {
    pdfLibDoc = await PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true, throwOnInvalidObject: false });
    console.log("pdf-lib load OK, pages:", pdfLibDoc.getPageCount());
  } catch (e) {
    console.log("pdf-lib load FAILED:", (e as Error).message);
    return;
  }
  const records = resolvePageShowTextWithXObjects(pdfLibDoc, 0);
  console.log("page0 showText records:", records.length);
  const byBasis = new Map<string, number>();
  let withUnicode = 0, nullCodes = 0;
  for (const r of records) {
    byBasis.set(r.charCodeBasis, (byBasis.get(r.charCodeBasis) ?? 0) + 1);
    if (r.unicodeText) withUnicode++;
    if (r.charCodes === null) nullCodes++;
  }
  console.log("charCodeBasis:", [...byBasis.entries()]);
  console.log("with unicodeText:", withUnicode, " null charCodes:", nullCodes);
  // dump first 10 records
  for (const r of records.slice(0, 10)) {
    console.log(
      `op=${r.op} font=${r.fontResourceKey} basis=${r.charCodeBasis} codes=${r.charCodes ? r.charCodes.length : "null"} ` +
      `opText=${JSON.stringify(r.operatorText.slice(0, 30))} uni=${JSON.stringify((r.unicodeText ?? "").slice(0, 30))}`
    );
  }
  // check the font dict of the first record
  const first = records.find((r) => r.charCodes === null);
  if (first) {
    console.log("\nsample null-codes record:", first.operatorId, "fontKey=", first.fontResourceKey, "fontResource=", JSON.stringify(first.fontResource));
  }
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
