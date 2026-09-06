/** diag11 — does pdfjs getDocument detach the input buffer? */
import * as fs from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument } from "pdf-lib";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf";

async function main() {
  const bytes = fs.readFileSync(ORIG);
  const copy = new Uint8Array(bytes); // 独立副本
  console.log("before getDocument: copy.byteLength =", copy.byteLength);

  const pdf = await getDocument({ data: new Uint8Array(copy), isEvalSupported: false }).promise;
  console.log("pdfjs loaded pages:", pdf.numPages);
  console.log("after getDocument: copy.byteLength =", copy.byteLength, "copy[0] =", copy[0]);

  // 尝试用同一 buffer 再 load pdf-lib（模拟 importer 行为）
  try {
    const lib = await PDFDocument.load(new Uint8Array(copy.buffer as ArrayBuffer), { ignoreEncryption: true, throwOnInvalidObject: false });
    console.log("pdf-lib load OK pages:", lib.getPageCount());
  } catch (e) {
    console.log("pdf-lib load FAILED:", (e as Error).message);
  }
  await pdf.destroy();
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
