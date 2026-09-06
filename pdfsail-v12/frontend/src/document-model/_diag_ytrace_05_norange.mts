/**
 * @diagnostic BUG-COORD-Y-ROOT-001 · 非 range 路径验证
 *
 * useExport.ts:87 —— 当 lineText === seg.originalText（segment 就是整行）时：
 *     mutateLineText(doc, blockId, lineId, seg.text)      // ← 不传 range
 * 走 glyph-mapping.ts:266-325 的「整行重写」分支：
 *     const lineY = firstOriginal.bbox.y;                 // = 329.847（bbox 顶！）
 *     glyphBBox.y = lineY;                                // 整行所有 glyph 统一用 bbox 顶
 *     baseline: originalGlyph?.baseline ?? lastOriginal?.baseline
 *
 * 之前的诊断全部用的 range 路径，从未覆盖这条分支。
 *
 * 用法: npx tsx _diag_ytrace_05_norange.mts <PDF>
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";

(globalThis as any).document = {
  createElement(tag: string) {
    if (tag === "canvas") return createCanvas(1, 1);
    throw new Error(`diag: unsupported <${tag}>`);
  },
  getElementsByTagName: () => [] as any,
  createElementNS: (_ns: string, tag: string) => (globalThis as any).document.createElement(tag),
} as any;
if (!(globalThis as any).Image) {
  (globalThis as any).Image = class { width = 0; height = 0; src = ""; onload: any = null; onerror: any = null; };
}

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
(pdfjs as any).GlobalWorkerOptions.workerSrc = new URL(
  "../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url,
).href;

import { parsePdfToEditableDocument } from "./pdf-importer";
import { mutateLineText } from "./document-mutation";
import { renderDocumentToExportCommands, exportEditableDocument } from "./export-renderer";

const r = (n: any, d = 3) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);
const lineTextOf = (l: any) => (l.glyphs ?? []).map((g: any) => g.char ?? "").join("");

/** 用 getTextContent 量导出 PDF 里该行的 baseline（权威） */
async function measureOverlayY(pdfPath: string, needle: string, nearY: number) {
  const buf = readFileSync(pdfPath);
  const doc = await (pdfjs as any).getDocument({
    data: new Uint8Array(Uint8Array.from(buf).buffer),
    useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true,
  }).promise;
  const rows: Array<{ y: number; x0: number; n: number; font: string; text: string }> = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const byY = new Map<string, any[]>();
    for (const it of tc.items as any[]) {
      if (!("str" in it)) continue;
      const t = it.transform as number[];
      if (Math.abs(t[5] - nearY) > 12) continue;
      const k = r(t[5], 1).toFixed(1);
      const arr = byY.get(k) ?? [];
      arr.push({ x: t[4], s: it.str ?? "", f: it.fontName });
      byY.set(k, arr);
    }
    for (const [k, arr] of byY) {
      const sorted = arr.slice().sort((a, b) => a.x - b.x);
      rows.push({
        y: Number(k), x0: r(sorted[0].x, 2), n: sorted.length,
        font: sorted[0].f, text: sorted.map((a) => a.s).join(""),
      });
    }
  }
  await doc.destroy();
  return rows.sort((a, b) => b.y - a.y);
}

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) { console.error("用法: npx tsx _diag_ytrace_05_norange.mts <PDF>"); process.exit(2); }
  const abs = resolve(pdfPath);
  if (!existsSync(abs)) { console.error(`文件不存在: ${abs}`); process.exit(2); }
  const fileBuf = readFileSync(abs);
  const fresh = () => new Uint8Array(Uint8Array.from(fileBuf).buffer);

  console.log("=".repeat(100));
  console.log("非 range 路径（整行重写）验证 —— 目标 572.102");
  console.log("=".repeat(100));

  const doc = await parsePdfToEditableDocument(fresh(), "diag.pdf");
  const renderScale = doc.runtime?.renderScale ?? 1.5;
  const cssScale = doc.runtime?.cssScale ?? 1;
  const S = renderScale * cssScale;
  const ctx = { renderScale, cssScale, pageHeightPt: 792 };
  console.log(`runtime: renderScale=${renderScale} cssScale=${cssScale} totalScale=${S}`);

  // 找目标行（含 "1.057,50"）
  let hit: any = null;
  for (const page of doc.pages) for (const block of page.blocks)
    block.lines.forEach((line: any, li: number) => {
      if (!hit && lineTextOf(line).includes("1.057,50")) hit = { block, line, li };
    });
  if (!hit) { console.log("未找到目标行"); process.exit(1); }
  const { block, line, li } = hit;
  const oldText = lineTextOf(line);
  const newText = oldText.replace("1.057,50", "1.059,50");
  console.log(`\n  行 ${line.id} (lineIndex=${li}) glyphs=${line.glyphs.length}`);
  console.log(`  原文: ${JSON.stringify(oldText)}`);

  const g0before = line.glyphs[0];
  console.log(`\n  [import] glyph[0]: bbox.y=${r(g0before.bbox.y)} h=${r(g0before.bbox.height)} baseline=${r(g0before.baseline)}`);

  // ── 情形 1：非 range（整行重写）── 对应 useExport.ts:87 ──
  const resNoRange = mutateLineText(doc, block.id, line.id, newText);
  const docNR = resNoRange.document;
  let lineNR: any = null;
  for (const p of docNR.pages) for (const b of p.blocks) if (b.id === block.id)
    for (const l of b.lines) if (l.id === line.id) lineNR = l;

  const g0nr = lineNR.glyphs[0];
  console.log(`\n  ── 情形1：非 range（useExport.ts:87）──`);
  console.log(`    glyph[0]: bbox.y=${r(g0nr.bbox.y)} h=${r(g0nr.bbox.height)} baseline=${r(g0nr.baseline)}`);
  console.log(`    baseline === bbox.y ? ${g0nr.baseline === g0nr.bbox.y ? "✅ 是（这就是 bug 条件）" : "否"}`);
  const cmdsNR = renderDocumentToExportCommands(docNR, ctx, undefined, undefined)
    .filter((c: any) => c.type === "drawTextGlyph" && c.lineIndex === li);
  console.log(`    cmd.baseline = ${r(cmdsNR[0]?.baseline)}   Δ vs 567.35 = ${r((cmdsNR[0]?.baseline ?? NaN) - 567.35, 4)}`);
  const bytesNR = await exportEditableDocument(docNR, fresh());
  writeFileSync("_diag_ytrace_out_norange.pdf", bytesNR);

  // ── 情形 2：range（对照，applySegmentEditsToDocument:99）──
  const start = oldText.indexOf("1.057,50");
  const end = start + "1.057,50".length - 1;
  const resRange = mutateLineText(doc, block.id, line.id, newText, { start, end });
  const docR = resRange.document;
  let lineR: any = null;
  for (const p of docR.pages) for (const b of p.blocks) if (b.id === block.id)
    for (const l of b.lines) if (l.id === line.id) lineR = l;
  const g0r = lineR.glyphs[0];
  console.log(`\n  ── 情形2：range [${start},${end}]（useExport.ts:99，此前一直测的）──`);
  console.log(`    glyph[0]: bbox.y=${r(g0r.bbox.y)} h=${r(g0r.bbox.height)} baseline=${r(g0r.baseline)}`);
  const cmdsR = renderDocumentToExportCommands(docR, ctx, undefined, undefined)
    .filter((c: any) => c.type === "drawTextGlyph" && c.lineIndex === li);
  console.log(`    cmd.baseline = ${r(cmdsR[0]?.baseline)}   Δ vs 567.35 = ${r((cmdsR[0]?.baseline ?? NaN) - 567.35, 4)}`);

  // ── 落盘测量 ──
  console.log(`\n\n${"=".repeat(100)}`);
  console.log("导出 PDF 实测（getTextContent 权威落点，y ∈ 567.35±12）");
  console.log("=".repeat(100));
  const rows = await measureOverlayY("_diag_ytrace_out_norange.pdf", "1.059,50", 567.35);
  for (const row of rows) {
    console.log(`  y=${String(r(row.y)).padStart(8)}  x0=${String(row.x0).padStart(7)}  n=${String(row.n).padStart(3)}  ${row.font}`);
    console.log(`      ${JSON.stringify(row.text.slice(0, 90))}`);
  }
  console.log(`\n  期望: 原始 567.35 ；真实导出 572.102 ；Δ = +4.752`);
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
