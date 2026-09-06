/**
 * @diagnostic 定位内容流中目标算子的真实字节位置，与 resolver 给出的 byteStart 对比。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";

function pdfToBytes(path: string): Uint8Array {
  const buf = readFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function main() {
  const path = resolve(process.argv[2] ?? "../../testcases/ocr/edit-pdf_uploads_1784668534110-k2v2grpo8.pdf");
  const pdf = await PDFDocument.load(pdfToBytes(path), { updateMetadata: false });
  const page = pdf.getPage(0) as any;
  const contents = page.node.Contents?.();
  console.log(`Contents 类型: ${contents?.constructor?.name}`);

  let text: string;
  if (contents instanceof PDFRawStream) {
    text = Buffer.from(decodePDFRawStream({ dict: contents.dict, contents: contents.asUint8Array() }).getBytes()).toString("latin1");
  } else {
    console.log("非直接流对象");
    return;
  }
  console.log(`内容流长度: ${text.length}`);

  // resolver 给出的位置
  const reported = [
    { id: "#15", start: 4093, end: 4099, expect: "4" },
    { id: "#16", start: 4227, end: 4238, expect: "Bidens" },
    { id: "#17", start: 4361, end: 4368, expect: "69" },
  ];
  console.log(`\n### resolver 报告的位置:`);
  for (const r of reported) {
    console.log(`  ${r.id} [${r.start}..${r.end}] = ${JSON.stringify(text.slice(r.start, r.end))}`);
  }

  // 实际位置
  console.log(`\n### 实际搜索:`);
  for (const r of reported) {
    const idx = text.indexOf(`(${r.expect})`);
    console.log(`  "(${r.expect})" 实际位置=${idx}` +
      (idx >= 0 ? ` 附近=${JSON.stringify(text.slice(idx, idx + 20))} 偏移=${idx - r.start}` : ""));
  }

  // 打印 4080..4260 区间原文，人工核对
  console.log(`\n### 内容流 4080..4260:`);
  console.log(JSON.stringify(text.slice(4080, 4260)));
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
