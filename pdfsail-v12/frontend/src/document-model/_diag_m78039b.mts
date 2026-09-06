/**
 * M7.8-039A — Segment geometry proof.
 * 只诊断。对表格行 LineGroup 运行 buildSegments，打印每个 segment 的 cssX/cssW/text，
 * 证明 Editor 路径把多 operator 行扁平化成 1 个（或少数）segment → 列间距丢失。
 */
import * as fs from "node:fs";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractGlyphs } from "../editor-engine/TextExtractor";
import { groupIntoLines, buildSegments } from "../editor-engine/SegmentBuilder";
import { CoordinateMapperImpl } from "../editor-engine/CoordinateMapper";
import { FontAnalyzerImpl } from "../editor-engine/FontAnalyzer";

try {
  const { createCanvas } = require("@napi-rs/canvas") as any;
  (globalThis as any).document = { createElement: (t: string) => (t === "canvas" ? createCanvas(1, 1) : ({ getContext: () => null } as any)) };
} catch {
  (globalThis as any).document = { createElement: (t: string) => (t === "canvas" ? { getContext: () => ({ measureText: () => ({ width: 5 }), font: "" }) } : ({ getContext: () => null } as any)) };
}

const _raw = console.log.bind(console);
const SUPPRESS = /\[(Sprint40-fix|Sprint34|YDIAG|M7\.8|PDFdraw|ExportLayout|WRITE_ENTRY|COORD_DIAG|DrawGlyph|NATIVE_REPLAY|009B|FIX-002|EditableDocument|ExportRenderer|DBG|EditorMaskGeometry)\]/;
console.log = (...a: any[]) => { const s = typeof a[0] === "string" ? a[0] : ""; if (!SUPPRESS.test(s)) _raw(...a); };
console.error = () => {};

async function main() {
  const pdfPath = process.argv[2] as string;
  const bytes = fs.readFileSync(pdfPath);
  GlobalWorkerOptions.workerSrc = new URL("../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).href;
  const pdf = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false }).promise;
  const tc = await pdf.getPage(1).then((pg: any) => pg.getTextContent());
  const vp = await pdf.getPage(1).then((pg: any) => pg.getViewport({ scale: 1.5 }));
  await pdf.destroy();

  const glyphs = extractGlyphs(tc as any);
  const lines = groupIntoLines(glyphs);
  // 找到表格行 LineGroup（含 268282-1-1）
  const row = lines.find((l: any) => l.glyphs.map((g: any) => g.str).join("").includes("268282-1-1"));
  if (!row) { _raw("!! 未找到表格行 LineGroup"); return; }

  _raw("==== RAW LineGroup (表格行) ====");
  _raw(`RawGlyph(operator) 数 = ${row.glyphs.length}  (每个 RawGlyph = 一个 PDF text operator)`);
  row.glyphs.forEach((g: any, i: number) => {
    _raw(`  [op#${i}] pdfX=${g.pdfX.toFixed(2)} w=${g.width.toFixed(2)} str=${JSON.stringify(g.str)}`);
  });

  const mapper = new CoordinateMapperImpl({
    viewportScale: 1.5, viewportHeight: vp.height / 1.5, viewportWidth: vp.width / 1.5, cssScale: 1,
    originXDevice: vp.transform[4], originYDevice: vp.transform[5],
  });
  const fa = new FontAnalyzerImpl();

  _raw("\n==== buildSegments 输出（Editor 实际消费的 segment 几何） ====");
  const segs = buildSegments([row as any], mapper as any, fa as any, 1);
  _raw(`segment 数 = ${segs.length}`);
  segs.forEach((s: any, i: number) => {
    _raw(`  [seg#${i}] cssX=${s.cssX.toFixed(2)} cssW=${s.cssW.toFixed(2)} isTableCell=${s.isTableCell ?? false} text=${JSON.stringify(s.text)}`);
  });

  _raw("\n==== 结论判定 ====");
  if (segs.length === 1) _raw("⚠ 整行被压成 1 个 segment → EditableTextNode 从 cssX 连续流式排版 → 列间距丢失");
  else {
    // 检查相邻 segment 之间是否有重叠/间隙（证明列是否被压）
    const gaps: string[] = [];
    for (let i = 1; i < segs.length; i++) {
      const prevEnd = segs[i - 1].cssX + segs[i - 1].cssW;
      const curStart = segs[i].cssX;
      gaps.push(`seg#${i - 1} end=${prevEnd.toFixed(1)} → seg#${i} start=${curStart.toFixed(1)} gap=${(curStart - prevEnd).toFixed(1)}`);
    }
    _raw("segment 间关系：");
    gaps.forEach((g) => _raw("  " + g));
  }
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
