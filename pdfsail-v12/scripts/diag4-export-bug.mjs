/**
 * diag4 — dump ALL text items in the edited region + font inventory,
 * both PDFs side by side, to expose ghosting + overlay items.
 */
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync } from "node:fs";

const origPath = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf";
const expPath = process.argv[2] || "C:/Users/admin/Downloads/edited-edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf.pdf";

async function loadItems(path, pageNo = 1) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), useSystemFonts: false, isEvalSupported: false, standardFontDataUrl: undefined }).promise;
  const page = await doc.getPage(pageNo);
  const tc = await page.getTextContent({ includeMarkedContent: false });
  return tc.items;
}

for (const [label, path] of [["ORIGINAL", origPath], ["EXPORTED", expPath]]) {
  console.log(`\n########## ${label}`);
  const items = await loadItems(path);
  const fonts = new Map();
  for (const it of items) fonts.set(it.fontName, (fonts.get(it.fontName) || 0) + 1);
  console.log("font usage:", [...fonts.entries()].map(([f, n]) => `${f}×${n}`).join(", "));
  // all items with y in [680, 775] (rows 1-2 region), sorted by y desc then x
  const zone = items
    .filter((it) => it.str && it.str.trim() && it.transform[5] >= 675 && it.transform[5] <= 775)
    .sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
  console.log(`items in y[675..775]: ${zone.length}`);
  for (const it of zone) {
    const [a, b, c, d, e, f] = it.transform;
    console.log(`x=${e.toFixed(2)} y=${f.toFixed(2)} w=${it.width.toFixed(2)} fs=${d.toFixed(2)} font=${it.fontName} ${JSON.stringify(it.str)}`);
  }
}
