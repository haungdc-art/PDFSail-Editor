/**
 * @diagnostic 追踪导出 Y 坐标链：PDF Tm → RawGlyph → EditableGlyph.pdfTransform
 *   → bbox → baseline → export command → final Tm。
 * 重点验证：glyph.baseline 到底是“真实基线”还是“bbox 顶部/底部”，
 * 并复算 export Y 与 original Tm.y 的差异。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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

function dumpLine(page: any, block: any, line: any, idx: number) {
  const g0 = line.glyphs[0];
  if (!g0) return;
  const totalScale = (page.renderScale ?? 1.5) * (page.cssScale ?? 1);
  const pageHeightPt = (page.cssHeight ?? page.height) / totalScale;
  const baselineCss = g0.baseline;
  const bbox = g0.bbox ?? {};
  const ob = g0.originalBBox ?? {};
  const pdfT = g0.metrics?.pdfTransform ?? g0.transform ?? null;
  const rawTmY = Array.isArray(pdfT) ? pdfT[5] : null;
  // 复算三种 export Y（page-space, bottom-left origin, flipBase = pageHeightPt）
  const boxTopCss = bbox.y;
  const boxBottomCss = bbox.y + bbox.height;
  const expY_trueBase = pageHeightPt - (typeof baselineCss === "number" ? baselineCss / totalScale : boxBottomCss / totalScale);
  const expY_boxTop = pageHeightPt - boxTopCss / totalScale;
  const expY_boxBottom = pageHeightPt - boxBottomCss / totalScale;
  console.log(`\n--- line#${idx} block=${block.id} text="${lineTextOf(line).slice(0, 40)}" ---`);
  console.log(`  renderScale=${page.renderScale} cssScale=${page.cssScale} totalScale=${totalScale} pageHeightPt=${r(pageHeightPt)}`);
  console.log(`  bbox.y=${r(bbox.y)} bbox.h=${r(bbox.height)} => boxTop=${r(boxTopCss)} boxBottom=${r(boxBottomCss)}`);
  console.log(`  baseline(CSS)=${r(baselineCss)}  relative: top->baseline=${r(baselineCss - boxTopCss)}  baseline->bottom=${r(boxBottomCss - baselineCss)}`);
  console.log(`  originalRawTmY(user-space)=${r(rawTmY)}  => page-space origY=${rawTmY !== null ? r(rawTmY + 792) : "n/a"}`);
  console.log(`  EXPORT Y candidates (page-space):`);
  console.log(`    true-baseline (myFix) = ${r(expY_trueBase)}`);
  console.log(`    box-top (old g.y+g.h) = ${r(expY_boxTop)}`);
  console.log(`    box-bottom (fallback g.y) = ${r(expY_boxBottom)}`);
  if (rawTmY !== null) {
    const origPage = rawTmY + 792;
    console.log(`  DELTA vs original page-space ${r(origPage)}:`);
    console.log(`    true-baseline dY = ${r(expY_trueBase - origPage)}`);
    console.log(`    box-top dY       = ${r(expY_boxTop - origPage)}`);
    console.log(`    box-bottom dY    = ${r(expY_boxBottom - origPage)}`);
  }
}
function r(n: any) { return typeof n === "number" ? Math.round(n * 1000) / 1000 : n; }

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) { console.error("用法: npx tsx _diag_coord.mts <PDF>"); process.exit(2); }
  const abs = resolve(pdfPath);
  const fileBuf = readFileSync(abs);
  const bytes = new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength);
  console.log(`载入 ${abs}`);
  const doc = await parsePdfToEditableDocument(bytes, "diag.pdf");
  const needle = process.argv[3];
  const page = doc.pages[0];
  console.log(`page0: cssHeight=${page.cssHeight} height=${page.height} renderScale=${page.renderScale} cssScale=${page.cssScale} originYPt=${page.originYPt} blocks=${page.blocks.length}`);
  let li = 0;
  for (const block of page.blocks) {
    for (const line of block.lines) {
      const t = lineTextOf(line);
      if (needle && !t.includes(needle)) { li++; continue; }
      dumpLine(page, block, line, li++);
      if (li > 12) return;
    }
  }
}
main().catch((e) => { console.error("异常:", e); process.exit(1); });
