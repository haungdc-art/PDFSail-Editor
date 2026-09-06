/**
 * @diagnostic 对比原 PDF 与导出 PDF 的 showText 算子，确认目标算子是否被剥离。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const pdfLib = await import("pdf-lib");

function pdfToBytes(path: string): Uint8Array {
  const buf = readFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function main() {
  const origPath = resolve(process.argv[2] ?? "../../testcases/ocr/edit-pdf_uploads_1784668534110-k2v2grpo8.pdf");
  const outPath = resolve(process.argv[3] ?? "../../frontend/_diag_export_e2e_out.pdf");

  const { resolvePageShowTextWithXObjects } = await import("./content-stream-resolver");

  for (const [label, path] of [["原PDF", origPath], ["导出PDF", outPath]] as const) {
    const pdf = await pdfLib.PDFDocument.load(pdfToBytes(path), { updateMetadata: false });
    const records = resolvePageShowTextWithXObjects(pdf, 0);
    console.log(`\n===== ${label}: ${records.length} 个算子 =====`);
    const interesting = records.filter((r: any) => /#(6|7|8|15|16|17|18)\b/.test(r.operatorId));
    for (const r of interesting) {
      const bytes = Buffer.from(r.rawBytes ?? []).toString("latin1");
      console.log(
        `  ${r.operatorId}: text="${r.unicodeText ?? ""}" bytes="${bytes.substring(0, 40)}" ` +
        `charCodes=${r.charCodes ? JSON.stringify(r.charCodes.slice(0, 10)) : "null"}`
      );
    }
  }
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
