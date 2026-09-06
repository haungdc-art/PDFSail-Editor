/** diag-user-pdf — 全页搜索编辑行：S30/S33/99%/power，输出字体与宽度 */
import * as fs from "node:fs";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";

GlobalWorkerOptions.workerSrc = new URL(
  "../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url,
).href;

const FILE = process.argv[2] ?? "C:/Users/admin/Downloads/edited-edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf.pdf";
const bytes = fs.readFileSync(FILE);
const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
console.log(`pages=${doc.numPages}`);
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  const hits = tc.items.filter((it: any) => it.str && /S3[03]|99%|S9|S10|PROMAX|PRO MAX|power/.test(it.str));
  if (hits.length === 0) continue;
  console.log(`--- page ${p} (${hits.length} hits) ---`);
  const sorted = hits.sort((a: any, b: any) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
  for (const it of sorted) {
    const [, , , , e, f] = it.transform;
    console.log(`x=${e.toFixed(2)} y=${f.toFixed(2)} w=${it.width.toFixed(2)} font=${it.fontName} ${JSON.stringify(it.str)}`);
  }
}
await doc.destroy();
