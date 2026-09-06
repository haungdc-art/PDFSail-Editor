import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const path = "C:/Users/admin/Downloads/edited-edit-pdf_uploads_1784668534110-k2v2grpo8.pdf (13).pdf";
const bytes = readFileSync(path);
const url = pathToFileURL("d:/TRAE/pdfsail-v12/node_modules/pdfjs-dist/standard_fonts/").href;

const doc = await getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: url, useSystemFonts: false, isEvalSupported: false }).promise;
const page = await doc.getPage(1);

let text = "";
try {
  const txt = await page.getTextContent();
  text = txt.items.map((it: any) => it.str).join("\n").slice(0, 800);
  console.log("=== getTextContent ===");
  console.log(text);
} catch (e) {
  console.log("getTextContent error:", e);
}

try {
  const ops = await page.getOperatorList();
  const fn = ops.fnArray;
  let show = 0, beginText = 0, endText = 0;
  for (const f of fn) {
    if (f === 56 || f === 57) show++;
    if (f === 28) beginText++;
    if (f === 29) endText++;
  }
  console.log("\n=== getOperatorList ===");
  console.log("total ops:", fn.length, "ShowText:", show, "BT:", beginText, "ET:", endText);
} catch (e) {
  console.log("getOperatorList error:", e);
}
