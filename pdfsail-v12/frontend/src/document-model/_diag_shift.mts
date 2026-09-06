/**
 * @diagnostic 仅加载原 PDF，打印受影响行的每个 glyph 的几何信息，
 * 重点观察 bbox 底部 (bbox.y + bbox.height) 与 glyph.baseline 的关系，
 * 定位“编辑后文字上移”的根因（导出 drawText 用 bbox.y+height 作 baseline）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---- pdf.js / canvas 的 node 垫片 ----
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function lineTextOf(line: any): string {
  return (line.glyphs ?? []).map((g: any) => g.char ?? g.originalChar ?? g.text ?? "").join("");
}

function findLines(doc: any, textSub: string) {
  const out: any[] = [];
  for (const page of doc.pages) for (const block of page.blocks) for (const line of block.lines) {
    const t = lineTextOf(line);
    if (t && t.includes(textSub)) out.push({ page, block, line, blockId: block.id, lineId: line.id, text: t });
  }
  return out;
}

function dumpLine(label: string, found: any) {
  console.log(`\n===== ${label} =====`);
  console.log(`block=${found.blockId} line=${found.lineId} len=${found.text.length} text="${found.text}"`);
  // 用与 cssToPdf 同源的方式算 PDF pt 基线（这里只关心 CSS 相对关系，pageHeight 不影响 delta）
  let i = 0;
  for (const g of found.line.glyphs) {
    const b = g.bbox ?? {};
    const bottom = (b.y ?? 0) + (b.height ?? 0);
    const oldExportCssY = b.y ?? 0;            // 旧：g.y+g.height = bbox 顶部
    const newExportCssY = (typeof g.baseline === "number") ? g.baseline : bottom; // 新：真实 baseline
    const baseLine = (typeof g.baseline === "number") ? g.baseline : NaN;
    const shiftUp = newExportCssY - oldExportCssY; // >0 表示旧做法把基线抬高（文字上移）
    console.log(
      `  [${i}] ch=${JSON.stringify(g.char ?? g.originalChar)} ` +
      `bbox.y=${r(b.y)} h=${r(b.height)} BOTTOM=${r(bottom)} ` +
      `baseline=${r(baseLine)} ` +
      `OLD_exportY(CSS)=${r(oldExportCssY)} NEW_exportY(CSS)=${r(newExportCssY)} ` +
      `上移量(旧-新)=${r(oldExportCssY - newExportCssY)}`,
    );
    i++;
  }
}
function r(n: any) { return typeof n === "number" ? Math.round(n * 100) / 100 : n; }

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) { console.error("用法: npx tsx _diag_shift.mts <PDF路径>"); process.exit(2); }
  const abs = resolve(pdfPath);
  const fileBuf = readFileSync(abs);
  const bytes = new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength);

  console.log(`载入 ${abs}`);
  const doc = await parsePdfToEditableDocument(bytes, "diag.pdf");

  for (const sub of ["MARKETING DIGITALS", "Santa Maria"]) {
    const found = findLines(doc, sub);
    console.log(`\n### 查找 "${sub}" → 命中 ${found.length} 行`);
    found.forEach((f, idx) => {
      // 挂载 style，便于看 fontSize
      const styleMap = doc.pages[0].blocks.find((b: any) => b.id === f.blockId)?.styles ?? {};
      for (const g of f.line.glyphs) if (g.styleRef !== undefined) g.__style = styleMap[g.styleRef];
      dumpLine(`匹配#${idx} "${sub}"`, f);
    });
  }
}
main().catch((e) => { console.error("异常:", e); process.exit(1); });
