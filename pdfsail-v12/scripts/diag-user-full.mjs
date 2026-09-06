/** diag-user-full — 对比原PDF与用户导出PDF 第2页 y[600..790] 全部文本项 + 字体清单 */
import * as fs from "node:fs";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";

GlobalWorkerOptions.workerSrc = new URL(
  "../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url,
).href;

const dump = async (label, file) => {
  const bytes = fs.readFileSync(file);
  const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, standardFontDataUrl: "../../node_modules/pdfjs-dist/standard_fonts/" }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  console.log(`=== ${label} page2 H=${vp.height.toFixed(1)} W=${vp.width.toFixed(1)}`);
  const tc = await page.getTextContent();
  const zone = tc.items
    .filter((it) => it.str && it.str.trim() && it.transform[5] >= 600 && it.transform[5] <= 790)
    .sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
  for (const it of zone) {
    const e = it.transform[4], f = it.transform[5];
    console.log(`x=${e.toFixed(2)} y=${f.toFixed(2)} w=${it.width.toFixed(2)} font=${it.fontName} ${JSON.stringify(it.str)}`);
  }
  await doc.destroy();
};

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf";
const USER = "C:/Users/admin/Downloads/edited-edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf.pdf";
await dump("ORIGINAL", ORIG);
await dump("USER-EXPORT", USER);
