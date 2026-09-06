/**
 * @diagnostic 对比 PDFDocument.load 有无 updateMetadata:false 对算子 byteStart 的影响。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import { resolvePageShowTextWithXObjects } from "./content-stream-resolver";

function pdfToBytes(path: string): Uint8Array {
  const buf = readFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
async function run(withOpt: boolean, label: string) {
  const bytes = pdfToBytes(resolve(process.argv[2] ?? "../../testcases/ocr/edit-pdf_uploads_1784668534110-k2v2grpo8.pdf"));
  const pdf = withOpt ? await PDFDocument.load(bytes, { updateMetadata: false }) : await PDFDocument.load(bytes);
  const records = resolvePageShowTextWithXObjects(pdf, 0);
  const r = records.filter((x: any) => /#(15|16|17)\b/.test(x.operatorId));
  console.log(`\n[${label}] updateMetadata:${withOpt}`);
  for (const x of r) console.log(`  ${x.operatorId}: byteStart=${x.byteStart} byteEnd=${x.byteEnd}`);
}
async function main() {
  await run(true, "with-opt");
  await run(false, "no-opt");
}
main().catch((e) => { console.error("异常:", e); process.exit(1); });
