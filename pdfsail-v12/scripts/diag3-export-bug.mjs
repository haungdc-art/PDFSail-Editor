/**
 * diag3 — use pdfjs getTextContent to compare text item geometry
 * (x, y, width, font) between original and exported PDF — quantifies spacing.
 */
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync } from "node:fs";

const origPath = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf";
const expPath = process.argv[2] || "C:/Users/admin/Downloads/edited-edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf.pdf";

async function loadItems(path) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), useSystemFonts: false, isEvalSupported: false }).promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  return { page, items: tc.items, doc };
}

function fmtItem(it) {
  const [a, b, c, d, e, f] = it.transform;
  const x = e.toFixed(2), y = f.toFixed(2);
  return `x=${x} y=${y} w=${it.width.toFixed(2)} h=${it.height.toFixed(2)} fs=${d.toFixed(2)} font=${it.fontName} "${it.str}"`;
}

for (const [label, path] of [["ORIGINAL", origPath], ["EXPORTED", expPath]]) {
  console.log(`\n########## ${label}`);
  const { items } = await loadItems(path);
  console.log("total items:", items.length);
  // find items of interest
  for (const it of items) {
    if (/S3[03]|power|PASS|100%|99%|DAILY|PRODUC|LOAD/i.test(it.str)) {
      console.log(fmtItem(it));
    }
  }
}
