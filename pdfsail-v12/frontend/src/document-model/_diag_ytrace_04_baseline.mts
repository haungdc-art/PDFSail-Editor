/**
 * @diagnostic BUG-COORD-Y-ROOT-001 · baseline 语义因果验证
 *
 * 已知（来自导出 PDF 的权威测量）：overlay 基线 = 572.102 = 原始 567.35 + ascent(4.752)
 *
 * 数学化简（export-renderer.ts:774-779）：
 *   baselinePdfY = pdfRect.y + (bbox.y + bbox.height − baseCssY)/totalScale
 *   而 pdfRect.y  = flipBase − bbox.y/S − bbox.height/S
 *   ⇒ baselinePdfY = flipBase − baseCssY / totalScale        ← 与 bbox 完全无关！
 *
 * 因此 baselinePdfY 只由 baseCssY（= glyph.baseline）决定。
 * 本脚本对照两种 baseline 语义，看谁产出 572.102。
 *
 * 用法: npx tsx _diag_ytrace_04_baseline.mts <PDF>
 */
import { readFileSync, existsSync } from "node:fs";
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

import { parsePdfToEditableDocument } from "./pdf-importer";
import { mutateLineText } from "./document-mutation";
import { renderDocumentToExportCommands } from "./export-renderer";

const r = (n: any, d = 3) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);
const lineTextOf = (l: any) => (l.glyphs ?? []).map((g: any) => g.char ?? "").join("");

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) { console.error("用法: npx tsx _diag_ytrace_04_baseline.mts <PDF>"); process.exit(2); }
  const abs = resolve(pdfPath);
  if (!existsSync(abs)) { console.error(`文件不存在: ${abs}`); process.exit(2); }
  const fileBuf = readFileSync(abs);
  const fresh = () => new Uint8Array(Uint8Array.from(fileBuf).buffer);

  const doc = await parsePdfToEditableDocument(fresh(), "diag.pdf");
  const renderScale = doc.runtime?.renderScale ?? 1.5;
  const cssScale = doc.runtime?.cssScale ?? 1;
  const S = renderScale * cssScale;
  const ctx = { renderScale, cssScale, pageHeightPt: 792 };

  console.log("=".repeat(96));
  console.log("baseline 语义因果验证");
  console.log("=".repeat(96));
  console.log(`renderScale=${renderScale} cssScale=${cssScale} totalScale=${S} flipBase=${ctx.pageHeightPt}`);
  console.log(`\n  化简式: baselinePdfY = flipBase − glyph.baseline / totalScale`);
  console.log(`  实测目标: 572.102  ⇒ 反推 glyph.baseline = (792 − 572.102) × ${S} = ${r((792 - 572.102) * S)}`);

  // 找被编辑行（含 "1.057" 的那一行）
  let hit: any = null;
  for (const page of doc.pages) for (const block of page.blocks)
    block.lines.forEach((line: any, li: number) => {
      if (!hit && lineTextOf(line).includes("1.057")) hit = { block, line, li };
    });
  if (!hit) { console.log("未找到含 '1.057' 的行"); process.exit(1); }
  const { block, line, li } = hit;

  const oldText = lineTextOf(line);
  const needle = "1.057,50";
  const start = oldText.indexOf(needle);
  const end = start + needle.length - 1;
  console.log(`\n  行文本 = ${JSON.stringify(oldText)}`);
  console.log(`  编辑段 ${JSON.stringify(needle)} @ [${start}, ${end}]  → "1.059,50"`);

  const g0 = line.glyphs[start];
  const st = doc.styles[g0.styleRef] ?? {};
  console.log(`\n  ── import 后 glyph[${start}] ──`);
  console.log(`    bbox.y        = ${r(g0.bbox.y)}      (CSS, 应为 bbox 顶部)`);
  console.log(`    bbox.height   = ${r(g0.bbox.height)}      (CSS)`);
  console.log(`    baseline      = ${r(g0.baseline)}      (CSS)`);
  console.log(`    pdfTransform  = [${(g0.metrics?.pdfTransform ?? []).map((n: number) => r(n)).join(", ")}]`);
  console.log(`    fontSize(style)= ${r(st.fontSize)} CSS px → ${r((st.fontSize ?? 0) / S)} pt`);
  console.log(`    bbox.y + h − baseline = ${r(g0.bbox.y + g0.bbox.height - g0.baseline)} CSS px`);

  const newText = oldText.slice(0, start) + "1.059,50" + oldText.slice(end + 1);
  const res = mutateLineText(doc, block.id, line.id, newText, { start, end });
  const doc2 = res.document;

  // ── 情形 A：保持 import 出来的 baseline（当前 production 数据） ──
  const cmdsA = renderDocumentToExportCommands(doc2, ctx, undefined, undefined)
    .filter((c: any) => c.type === "drawTextGlyph" && c.lineIndex === li);
  const a0 = cmdsA[start] ?? cmdsA[0];

  // ── 情形 B：把 baseline 改成 bbox.y（bbox 顶部） ──
  const docB = {
    ...doc2,
    pages: doc2.pages.map((p: any) => ({
      ...p,
      blocks: p.blocks.map((b: any) => ({
        ...b,
        lines: b.lines.map((l: any) => ({
          ...l,
          glyphs: l.glyphs.map((g: any) => ({ ...g, baseline: g.bbox.y })),
        })),
      })),
    })),
  } as any;
  const cmdsB = renderDocumentToExportCommands(docB, ctx, undefined, undefined)
    .filter((c: any) => c.type === "drawTextGlyph" && c.lineIndex === li);
  const b0 = cmdsB[start] ?? cmdsB[0];

  // ── 情形 C：baseline 缺失（undefined → fallback bbox.y + bbox.height） ──
  const docC = {
    ...doc2,
    pages: doc2.pages.map((p: any) => ({
      ...p,
      blocks: p.blocks.map((b: any) => ({
        ...b,
        lines: b.lines.map((l: any) => ({
          ...l,
          glyphs: l.glyphs.map((g: any) => { const c = { ...g }; delete c.baseline; return c; }),
        })),
      })),
    })),
  } as any;
  const cmdsC = renderDocumentToExportCommands(docC, ctx, undefined, undefined)
    .filter((c: any) => c.type === "drawTextGlyph" && c.lineIndex === li);
  const c0 = cmdsC[start] ?? cmdsC[0];

  const m0 = doc2.pages.flatMap((p: any) => p.blocks).find((b: any) => b.id === block.id)
    ?.lines.find((l: any) => l.id === line.id)?.glyphs[start];

  console.log(`\n\n${"=".repeat(96)}`);
  console.log("三种 baseline 语义 → 导出 baseline 对照");
  console.log("=".repeat(96));
  const w = [34, 16, 16, 16, 14];
  const fmt = (a: string[]) => "  " + a.map((s, i) => String(s).padEnd(w[i])).join(" │ ");
  const sep = "  " + w.map((n) => "─".repeat(n)).join("─┼─");
  console.log(sep);
  console.log(fmt(["情形", "baseline(CSS)", "cmd.baseline", "Δ vs 567.35", "是否 572.102"]));
  console.log(sep);
  const row = (name: string, blCss: any, cmd: any) => {
    const bl = cmd?.baseline;
    const d = typeof bl === "number" ? bl - 567.35 : NaN;
    console.log(fmt([
      name,
      r(blCss) + "",
      r(bl) + "",
      r(d, 4) + "",
      Math.abs((bl ?? NaN) - 572.102) < 0.01 ? "✅ 命中" : "—",
    ]));
  };
  row("A 真 baseline (import 原值)", m0?.baseline, a0);
  row("B baseline = bbox.y (bbox 顶)", m0?.bbox?.y, b0);
  row("C baseline 缺失 (fallback 底)", "(undefined)", c0);
  console.log(sep);

  console.log(`\n  期望: 原始 567.35 ； 实测导出 572.102 ； 差 = 4.752 (= 6.6 × 0.72)`);
  console.log(`\n  A 的 pdfRect.y (cssToPdf 输出, bbox 顶) = ${r(a0?.y)}`);
  console.log(`  A 的 baseline − y 差值                 = ${r((a0?.baseline ?? 0) - (a0?.y ?? 0), 4)} pt`);
  console.log(`  bbox.height/totalScale                 = ${r((m0?.bbox?.height ?? 0) / S, 4)} pt`);
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
