/**
 * @diagnostic 校验导出后的 PDF：提取第 1 页文字，确认编辑行无重影、其它行完整。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

function pdfToBytes(path: string): Uint8Array {
  const buf = readFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function main() {
  const pdfPath = process.argv[2] ?? "../../_diag_export_e2e_out.pdf";
  const abs = resolve(pdfPath);
  const doc = await (pdfjs as any).getDocument({ data: pdfToBytes(abs), useSystemFonts: false }).promise;
  console.log(`导出 PDF: ${abs} 页数=${doc.numPages}`);

  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  const items = content.items as any[];
  const rows = items
    .filter((it: any) => typeof it.str === "string")
    .map((it: any) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }))
    .sort((a: any, b: any) => b.y - a.y || a.x - b.x);

  console.log(`\n共 ${rows.length} 个文本片段。`);
  // 按 y 归并成行
  let curY: number | null = null;
  let line = "";
  const lines: { y: number; text: string }[] = [];
  for (const r of rows) {
    if (curY === null || Math.abs(r.y - curY) > 2) {
      if (line) lines.push({ y: curY!, text: line });
      curY = r.y;
      line = r.str;
    } else {
      line += r.str;
    }
  }
  if (line) lines.push({ y: curY!, text: line });

  console.log(`\n### 导出 PDF 前 12 行文本:`);
  lines.slice(0, 12).forEach((l, i) => console.log(`  ${i}: y=${l.y.toFixed(1)} "${l.text}"`));

  const bidens = lines.filter((l) => l.text.includes("Bidens"));
  console.log(`\n### 含 Bidens 的行:`);
  bidens.forEach((l) => console.log(`  y=${l.y.toFixed(1)} "${l.text}"`));
  if (bidens.length > 1) {
    console.log("  ⚠️ 出现多行 → 可能重影");
  } else if (bidens.length === 1) {
    console.log("  ✅ 单行，无重影");
  }
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
