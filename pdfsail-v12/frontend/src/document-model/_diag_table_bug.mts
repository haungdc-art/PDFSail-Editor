/**
 * @diagnostic 分析表格 PDF 编辑后线条被擦除 / 字符间距被拉开问题。
 * 加载原始 PDF，打印目标行每个 glyph 的几何信息，并模拟常见编辑场景观察 suffix shift。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";

(globalThis as any).document = {
  createElement(tag: string) {
    if (tag === "canvas") return createCanvas(1, 1);
    throw new Error(`diag: unsupported element <${tag}>`);
  },
  getElementsByTagName: () => [] as any,
  createElementNS: (_ns: string, tag: string) => (globalThis as any).document.createElement(tag),
} as any;
if (!(globalThis as any).Image) {
  (globalThis as any).Image = class { width = 0; height = 0; src = ""; onload: any = null; onerror: any = null; };
}

import { parsePdfToEditableDocument } from "./pdf-importer";
import { mapNewTextToOriginalGlyphs } from "./glyph-mapping";

function lineTextOf(line: any): string {
  return (line.glyphs ?? []).map((g: any) => g.char ?? g.originalChar ?? g.text ?? "").join("");
}

function findLines(doc: any, textSub: string) {
  const out: any[] = [];
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        const t = lineTextOf(line);
        if (t && t.includes(textSub)) {
          const styles = block.styles ?? doc.styles ?? [];
          out.push({ page, block, line, blockId: block.id, lineId: line.id, text: t, styles });
        }
      }
    }
  }
  return out;
}

function dumpLine(label: string, found: any) {
  console.log(`\n===== ${label} =====`);
  console.log(`block=${found.blockId} line=${found.lineId} len=${found.text.length} text="${found.text}"`);
  const glyphs = found.line.glyphs as any[];
  const widths = glyphs.map((g) => g.bbox?.width ?? g.metrics?.advanceWidth ?? 0).filter((w) => w > 0.001);
  const avg = widths.length ? widths.reduce((a, b) => a + b, 0) / widths.length : 0;
  console.log(`glyph count=${glyphs.length} avg width=${avg.toFixed(2)}`);
  glyphs.forEach((g, i) => {
    const b = g.bbox ?? {};
    console.log(
      `  [${i}] ch=${JSON.stringify(g.char ?? g.originalChar)} ` +
      `x=${b.x?.toFixed(2)} y=${b.y?.toFixed(2)} w=${b.width?.toFixed(2)} h=${b.height?.toFixed(2)} ` +
      `baseline=${g.baseline?.toFixed?.(2) ?? "n/a"} styleRef=${g.styleRef}`
    );
  });
}

function simulateEdit(line: any, styles: any[], range: { start: number; end: number }, newText: string, label: string) {
  const originalGlyphs = line.glyphs as any[];
  const styleRef = originalGlyphs[0]?.styleRef ?? 0;
  const style = styles[styleRef] ?? {};
  const res = mapNewTextToOriginalGlyphs(originalGlyphs, newText, style, styleRef, range);
  console.log(`\n### 模拟编辑: ${label} range=${JSON.stringify(range)} newText="${newText}"`);
  res.newGlyphs.forEach((g, i) => {
    const b = g.bbox ?? {};
    console.log(
      `  [${i}] ch=${JSON.stringify(g.char)} x=${b.x?.toFixed(2)} w=${b.width?.toFixed(2)} modified=${g.modified}`
    );
  });
  const widths = originalGlyphs.map((g) => g.bbox?.width ?? 0).filter((w) => w > 0.001);
  const avg = widths.length ? widths.reduce((a, b) => a + b, 0) / widths.length : 0;
  console.log(`  行内 glyph 平均宽度=${avg.toFixed(2)}`);
}

async function main() {
  const pdfPath = process.argv[2] ?? "../../testcases/ocr/edit-pdf_uploads_1784668534110-k2v2grpo8.pdf";
  const abs = resolve(pdfPath);
  const fileBuf = readFileSync(abs);
  const bytes = new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength);

  console.log(`载入 ${abs}`);
  const doc = await parsePdfToEditableDocument(bytes, "diag.pdf");

  for (const sub of ["Bidens", "Maria", "221", "10"]) {
    const found = findLines(doc, sub);
    console.log(`\n### 查找 "${sub}" → 命中 ${found.length} 行`);
    found.forEach((f, idx) => dumpLine(`匹配#${idx} "${sub}"`, f));
  }

  // 模拟常见编辑场景
  const bidens = findLines(doc, "Bidens")[0];
  if (bidens) {
    const text = lineTextOf(bidens.line);
    // 贴近图片：把数量 "69"（indices 9-10）替换成 "f r"（新增空格）
    simulateEdit(bidens.line, bidens.styles, { start: 9, end: 10 }, text.slice(0, 9) + "f r", "69 -> f r");
    // 贴近图片：把 "69" 替换成 "f  r"（两个空格）
    simulateEdit(bidens.line, bidens.styles, { start: 9, end: 10 }, text.slice(0, 9) + "f  r", "69 -> f  r");
    // 单 caret 在 69 前插入 "abc"
    simulateEdit(bidens.line, bidens.styles, { start: 9, end: 8 }, text.slice(0, 9) + "abc" + text.slice(9), "在 69 前插入 abc");
    // 贴近图片：用户可能点击了大空格（index 8）并输入 "f r"
    simulateEdit(bidens.line, bidens.styles, { start: 8, end: 8 }, text.slice(0, 8) + "f r" + text.slice(9), "大空格 -> f r");
    // 用户删除 69 并输入 "f    r"（4 空格）
    simulateEdit(bidens.line, bidens.styles, { start: 9, end: 10 }, text.slice(0, 9) + "f    r", "69 -> f    r");
  }

  const maria = findLines(doc, "Maria")[0];
  if (maria) {
    const text = lineTextOf(maria.line);
    simulateEdit(maria.line, maria.styles, { start: 0, end: -1 }, "MariaX" + text.slice(5), "在 Maria 前插入 X");
    simulateEdit(maria.line, maria.styles, { start: 0, end: 0 }, "X" + text.slice(1), "替换 M 为 X");
  }
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
