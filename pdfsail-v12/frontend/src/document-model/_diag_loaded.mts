/**
 * @diagnostic 模拟 strip 真实路径：PDFDocument.load 后，
 * 用 resolvePageShowTextWithXObjects 解析，打印 #15/#16/#17 的 byteStart。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import { resolvePageShowTextWithXObjects } from "./content-stream-resolver";

function pdfToBytes(path: string): Uint8Array {
  const buf = readFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function main() {
  const path = resolve(process.argv[2] ?? "../../testcases/ocr/edit-pdf_uploads_1784668534110-k2v2grpo8.pdf");
  const bytes = pdfToBytes(path);
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const records = resolvePageShowTextWithXObjects(pdf, 0);
  for (const r of records) {
    if (/#(15|16|17)\b/.test(r.operatorId)) {
      console.log(`  ${r.operatorId}: byteStart=${r.byteStart} byteEnd=${r.byteEnd} text=${JSON.stringify(r.unicodeText ?? r.operatorText)}`);
    }
  }
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
