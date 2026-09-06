/**
 * @diagnostic BUG-COORD-Y-ROOT-001 · 端到端 Y 坐标追踪
 *
 * 链路：
 *   ORIGINAL PDF → operator-list → 被编辑 text run → 原始 Tm
 *   → parsePdfToEditableDocument → pdfTransform / bbox / baseline
 *   → mutateLineText           → 修改后的同名字段
 *   → export command           → 最终 Tm / x / y
 *   → 导出 PDF → 再次解析 content stream → 最终 Tm
 *
 * 所有阶段统一折算为【PDF pt · user space · text origin(baseline)】以便逐行对比。
 *
 * 只读取 + 调用 production 函数，不修改任何 production 代码。
 *
 * 用法:
 *   npx tsx _diag_ytrace_01_full.mts <PDF路径> [needle] [替换后的该段文本]
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
import { renderDocumentToExportCommands } from "./export-renderer";
import { exportEditableDocument } from "./export-renderer";

const OPS: Record<string, number> = (pdfjs as any).OPS ?? {};
const OP_NAME: Record<number, string> = {};
for (const [k, v] of Object.entries(OPS)) if (typeof v === "number") OP_NAME[v] = k;

const r = (n: any, d = 3) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);
const dash = "—";

type M6 = [number, number, number, number, number, number];

function mul(A: M6, B: M6): M6 {
  return [
    A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3],
    A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3],
    A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5],
  ];
}
function translate(m: M6, tx: number, ty: number): M6 {
  return [m[0], m[1], m[2], m[3], m[4] + tx * m[0] + ty * m[2], m[5] + tx * m[1] + ty * m[3]];
}

interface RawRun {
  seq: number;
  tm: M6;      // content-stream 文字矩阵
  full: M6;    // param × tm × ctm
  fontRes: string;
  tfSize: number;
  op: string;
  codes: number[];
  text: string;
}

/** 完整模拟 PDF 文字状态机，抽取每个 showText 的有效 Tm */
async function extractRuns(bytes: Uint8Array): Promise<{ runs: RawRun[]; pageInfo: string[] }> {
  const doc = await (pdfjs as any).getDocument({
    data: bytes, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true,
  }).promise;
  const pageInfo: string[] = [];
  const runs: RawRun[] = [];
  let seq = 0;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    pageInfo.push(`page${p}: MediaBox=[${(page.view as number[]).join(",")}] CTM=[${vp.transform.map((n) => r(n, 2)).join(",")}]`);
    const ol = await page.getOperatorList();

    let ctm: M6 = [1, 0, 0, 1, 0, 0];
    let tm: M6 = [1, 0, 0, 1, 0, 0];
    let tlm: M6 = [1, 0, 0, 1, 0, 0];
    let tl = 0, ts = 0, tz = 1, tfs = 0;
    let fontRes = "?";

    for (let i = 0; i < ol.fnArray.length; i++) {
      const name = OP_NAME[ol.fnArray[i]] ?? String(ol.fnArray[i]);
      const args = (ol.argsArray[i] ?? []) as any[];
      switch (name) {
        case "transform": ctm = mul([args[0], args[1], args[2], args[3], args[4], args[5]] as M6, ctm); break;
        case "beginText": tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0]; break;
        case "setFont": fontRes = String(args[0] ?? "?"); tfs = Number(args[1]); break;
        case "setTextMatrix": tm = [args[0], args[1], args[2], args[3], args[4], args[5]] as M6; tlm = [...tm] as M6; break;
        case "moveText": tlm = translate(tlm, Number(args[0]) || 0, Number(args[1]) || 0); tm = [...tlm] as M6; break;
        case "setLeadingMoveText": tl = -(Number(args[1]) || 0); tlm = translate(tlm, Number(args[0]) || 0, Number(args[1]) || 0); tm = [...tlm] as M6; break;
        case "nextLine": tlm = translate(tlm, 0, -tl); tm = [...tlm] as M6; break;
        case "setLeading": tl = Number(args[0]) || 0; break;
        case "setTextRise": ts = Number(args[0]) || 0; break;
        case "setHScale": tz = (Number(args[0]) || 100) / 100; break;
        case "showText":
        case "showSpacedText": {
          const glyphs = (args[0] ?? []) as any[];
          const codes: number[] = [];
          let text = "";
          for (const g of glyphs) {
            if (typeof g === "number") codes.push(g);
            else if (g && typeof g === "object") {
              const fc = g.fontChar ?? g.unicode ?? "";
              if (typeof fc === "string" && fc.length) codes.push(fc.codePointAt(0)!);
              text += g.unicode ?? g.fontChar ?? "";
            } else if (typeof g === "string") text += g;
          }
          const param: M6 = [tfs * tz, 0, 0, tfs, 0, ts];
          runs.push({ seq: seq++, tm: [...tm] as M6, full: mul(mul(param, tm), ctm), fontRes, tfSize: tfs, op: name, codes, text });
          break;
        }
        default: break;
      }
    }
  }
  await doc.destroy();
  return { runs, pageInfo };
}

const lineTextOf = (line: any) => (line.glyphs ?? []).map((g: any) => g.char ?? "").join("");

async function main() {
  const pdfPath = process.argv[2];
  const needle = process.argv[3] || "268282";
  if (!pdfPath) { console.error("用法: npx tsx _diag_ytrace_01_full.mts <PDF路径> [needle]"); process.exit(2); }
  const abs = resolve(pdfPath);
  if (!existsSync(abs)) { console.error(`文件不存在: ${abs}`); process.exit(2); }

  const fileBuf = readFileSync(abs);
  // pdf.js 的 getDocument 会 transfer/detach ArrayBuffer，每次消费都必须给独立副本
  const freshBytes = () => new Uint8Array(Uint8Array.from(fileBuf).buffer);
  const bytes = freshBytes();

  console.log("=".repeat(100));
  console.log("BUG-COORD-Y-ROOT-001 · 端到端 Y 坐标追踪");
  console.log("=".repeat(100));
  console.log(`PDF   : ${abs}`);
  console.log(`needle: ${JSON.stringify(needle)}`);

  // ═══════════ Stage A: 原始 operator ═══════════
  console.log("\n\n########## Stage A · ORIGINAL PDF → operator-list ##########");
  const { runs, pageInfo } = await extractRuns(bytes);
  pageInfo.forEach((s) => console.log(`  ${s}`));
  console.log(`  showText runs: ${runs.length}`);

  const targetRun = runs.find((x) => x.text.includes(needle));
  if (!targetRun) {
    console.log(`  ✗ 未找到包含 ${JSON.stringify(needle)} 的 run`);
    console.log("  可用 run 文本样本:");
    runs.slice(0, 30).forEach((x) => console.log(`    #${x.seq} ${JSON.stringify(x.text)}`));
    process.exit(1);
  }
  console.log(`\n  [被编辑 text run] #${targetRun.seq}`);
  console.log(`    Tm(content) = [${targetRun.tm.map((n) => r(n)).join(", ")}]`);
  console.log(`    full matrix = [${targetRun.full.map((n) => r(n)).join(", ")}]`);
  console.log(`    origin      = (${r(targetRun.full[4])}, ${r(targetRun.full[5])}) pt  ← user-space baseline`);
  console.log(`    Tf          = /${targetRun.fontRes} ${targetRun.tfSize}`);
  console.log(`    text        = ${JSON.stringify(targetRun.text)}`);
  console.log(`    codes       = [${targetRun.codes.join(",")}]`);

  const ORIGIN_Y = targetRun.full[5];   // 567.35
  const ORIGIN_X = targetRun.full[4];   // 24
  const ORIGIN_TM = targetRun.tm;

  // ═══════════ Stage B: import Glyph ═══════════
  console.log("\n\n########## Stage B · parsePdfToEditableDocument ##########");
  const doc = await parsePdfToEditableDocument(freshBytes(), "diag.pdf");
  const renderScale = doc.runtime?.renderScale ?? 1.5;
  const cssScale = doc.runtime?.cssScale ?? 1;
  const totalScale = renderScale * cssScale;
  console.log(`  runtime: renderScale=${renderScale} cssScale=${cssScale} totalScale=${totalScale}`);

  let hit: { page: any; block: any; line: any; lineIdx: number } | null = null;
  for (const page of doc.pages) for (const block of page.blocks)
    block.lines.forEach((line: any, li: number) => {
      if (!hit && lineTextOf(line).includes(needle)) hit = { page, block, line, lineIdx: li };
    });
  if (!hit) { console.log("  ✗ import 后未找到目标行"); process.exit(1); }
  const { block, line, lineIdx } = hit!;

  const start = lineTextOf(line).indexOf(needle);
  const end = start + needle.length - 1;
  const g0 = line.glyphs[start];
  const pt0 = g0.metrics?.pdfTransform as number[] | undefined;
  const style0 = doc.styles[g0.styleRef] ?? {};

  console.log(`  block=${block.id} line=${line.id} (lineIdx=${lineIdx})`);
  console.log(`  行文本 = ${JSON.stringify(lineTextOf(line))}`);
  console.log(`  needle 区间 = [${start}, ${end}]`);
  console.log(`\n  [import Glyph g[${start}]] char=${JSON.stringify(g0.char)}`);
  console.log(`    pdfTransform = [${pt0 ? pt0.map((n) => r(n)).join(", ") : dash}]`);
  console.log(`    bbox (CSS)   = x=${r(g0.bbox.x)} y=${r(g0.bbox.y)} w=${r(g0.bbox.width)} h=${r(g0.bbox.height)}`);
  console.log(`    baseline(CSS)= ${r(g0.baseline)}   ← bbox.y+h = ${r(g0.bbox.y + g0.bbox.height)}`);
  console.log(`    style.fontSize (CSS px) = ${r(style0.fontSize)}  → pt = ${r(style0.fontSize / totalScale)}`);
  console.log(`    fontIdentity = ${g0.fontIdentity?.fontRef ?? g0.metrics?.fontIdentity?.fontRef ?? dash} subtype=${g0.fontIdentity?.subtype ?? dash}`);
  console.log(`    pdfCharCode  = ${g0.pdfCharCode ?? g0.metrics?.pdfCharCode ?? dash}`);

  // ═══════════ Stage C: mutate ═══════════
  console.log("\n\n########## Stage C · mutateLineText ##########");
  const oldText = lineTextOf(line);
  const seg = oldText.slice(start, end + 1);
  const newSeg = process.argv[4] ?? (seg.slice(0, -1) + "9"); // 默认改最后一字符
  const newText = oldText.slice(0, start) + newSeg + oldText.slice(end + 1);
  console.log(`  替换: ${JSON.stringify(seg)} → ${JSON.stringify(newSeg)}`);
  console.log(`  range = {start:${start}, end:${end}}`);

  const res = mutateLineText(doc, block.id, line.id, newText, { start, end });
  const doc2 = res.document;
  console.log(`  mutated = ${res.mutated}`);

  let line2: any = null;
  for (const page of doc2.pages) for (const b of page.blocks) if (b.id === block.id)
    for (const l of b.lines) if (l.id === line.id) line2 = l;
  if (!line2) { console.log("  ✗ mutate 后未找到目标行"); process.exit(1); }

  const m0 = line2.glyphs[start];
  const mpt0 = m0.metrics?.pdfTransform as number[] | undefined;
  const mstyle0 = doc2.styles[m0.styleRef] ?? {};
  console.log(`\n  [mutate 后 Glyph g[${start}]] char=${JSON.stringify(m0.char)} modified=${m0.modified}`);
  console.log(`    pdfTransform = [${mpt0 ? mpt0.map((n) => r(n)).join(", ") : dash}]`);
  console.log(`    bbox (CSS)   = x=${r(m0.bbox.x)} y=${r(m0.bbox.y)} w=${r(m0.bbox.width)} h=${r(m0.bbox.height)}`);
  console.log(`    baseline(CSS)= ${r(m0.baseline)}   ← bbox.y+h = ${r(m0.bbox.y + m0.bbox.height)}`);
  console.log(`    style.fontSize (CSS px) = ${r(mstyle0.fontSize)} → pt = ${r(mstyle0.fontSize / totalScale)}`);
  console.log(`    fontIdentity = ${m0.fontIdentity?.fontRef ?? m0.metrics?.fontIdentity?.fontRef ?? dash}`);
  console.log(`    pdfCharCode  = ${m0.pdfCharCode ?? m0.metrics?.pdfCharCode ?? dash}`);

  // ═══════════ Stage D: export command ═══════════
  console.log("\n\n########## Stage D · export command ##########");
  const ctx = { renderScale, cssScale, pageHeightPt: 792 };
  const commands = renderDocumentToExportCommands(doc2, ctx, undefined, undefined);
  const glyphCmds = commands.filter((c: any) => c.type === "drawTextGlyph" && c.lineIndex === lineIdx);
  console.log(`  总命令 ${commands.length}，目标行(lineIndex=${lineIdx}) 的 drawTextGlyph: ${glyphCmds.length}`);

  const c0 = glyphCmds[start] ?? glyphCmds[0];
  if (!c0) { console.log("  ✗ 未产出目标行的 export command"); process.exit(1); }
  console.log(`\n  [export command] char=${JSON.stringify(c0.char)}`);
  console.log(`    x        = ${r(c0.x)}`);
  console.log(`    y        = ${r(c0.y)}          ← cssToPdf(bbox).y = bbox 顶部`);
  console.log(`    baseline = ${r(c0.baseline)}    ← 实际用于 drawText 的 Y`);
  console.log(`    fontSize = ${r(c0.fontSize)}`);
  console.log(`    font     = ${c0.fontIdentity?.fontRef ?? dash} / family=${c0.fontFamily}`);
  console.log(`    pdfCharCode   = ${c0.pdfCharCode ?? dash}`);
  console.log(`    pdfTransform  = [${c0.pdfTransform ? c0.pdfTransform.map((n: number) => r(n)).join(", ") : dash}]`);

  // ═══════════ Stage E: 导出 PDF → 重新解析 ═══════════
  console.log("\n\n########## Stage E · 导出 PDF → 再次解析 content stream ##########");
  const outBytes = await exportEditableDocument(doc2, freshBytes());
  const outPath = resolve("_diag_ytrace_out.pdf");
  writeFileSync(outPath, outBytes);
  console.log(`  已写出: ${outPath} (${outBytes.length} bytes)`);

  const { runs: runs2 } = await extractRuns(new Uint8Array(outBytes));
  const finalRun = runs2.find((x) => x.text.includes(newSeg)) ?? runs2.find((x) => x.text.includes(needle));
  if (!finalRun) {
    console.log(`  ✗ 导出 PDF 中未找到 ${JSON.stringify(newSeg)}；文本样本:`);
    runs2.slice(0, 40).forEach((x) => console.log(`    #${x.seq} ${JSON.stringify(x.text)} @(${r(x.full[4])},${r(x.full[5])})`));
    process.exit(1);
  }
  console.log(`\n  [最终 PDF run] #${finalRun.seq}`);
  console.log(`    Tm(content) = [${finalRun.tm.map((n) => r(n)).join(", ")}]`);
  console.log(`    full matrix = [${finalRun.full.map((n) => r(n)).join(", ")}]`);
  console.log(`    origin      = (${r(finalRun.full[4])}, ${r(finalRun.full[5])}) pt`);
  console.log(`    Tf          = /${finalRun.fontRes} ${finalRun.tfSize}`);
  console.log(`    text        = ${JSON.stringify(finalRun.text)}`);
  console.log(`    codes       = [${finalRun.codes.slice(0, 16).join(",")}${finalRun.codes.length > 16 ? ",…" : ""}]`);

  // ═══════════ 汇总表 ═══════════
  const rows: Array<[string, string, string, string, string, string]> = [];
  rows.push([
    "原始 operator",
    r(ORIGIN_X, 2) + "",
    r(ORIGIN_Y, 3) + "",
    r(targetRun.tfSize, 2) + "",
    "/" + targetRun.fontRes,
    String(targetRun.codes[0]),
  ]);
  rows.push([
    "import Glyph",
    pt0 ? r(pt0[4], 2) + "" : dash,
    pt0 ? r(pt0[5], 3) + "" : dash,
    r((style0.fontSize ?? 0) / totalScale, 2) + "",
    (g0.fontIdentity?.fontRef ?? g0.metrics?.fontIdentity?.fontRef ?? dash) + "",
    String(g0.pdfCharCode ?? g0.metrics?.pdfCharCode ?? dash),
  ]);
  rows.push([
    "mutate 后 Glyph",
    mpt0 ? r(mpt0[4], 2) + "" : dash,
    mpt0 ? r(mpt0[5], 3) + "" : dash,
    r((mstyle0.fontSize ?? 0) / totalScale, 2) + "",
    (m0.fontIdentity?.fontRef ?? m0.metrics?.fontIdentity?.fontRef ?? dash) + "",
    String(m0.pdfCharCode ?? m0.metrics?.pdfCharCode ?? dash),
  ]);
  rows.push([
    "export command",
    r(c0.x, 2) + "",
    r(c0.baseline, 3) + "",
    r(c0.fontSize, 2) + "",
    (c0.fontIdentity?.fontRef ?? c0.fontFamily ?? dash) + "",
    String(c0.pdfCharCode ?? dash),
  ]);
  rows.push([
    "最终 PDF",
    r(finalRun.full[4], 2) + "",
    r(finalRun.full[5], 3) + "",
    r(finalRun.tfSize, 2) + "",
    "/" + finalRun.fontRes,
    String(finalRun.codes[0]),
  ]);

  const cols = ["阶段", "X", "Y", "fontSize", "Font", "CharCode"];
  const w = [18, 10, 12, 10, 22, 12];
  const fmtRow = (a: string[]) => "  " + a.map((s, i) => String(s).padEnd(w[i])).join(" │ ");
  const sep = "  " + w.map((n) => "─".repeat(n)).join("─┼─");

  console.log("\n\n" + "=".repeat(100));
  console.log("汇总表（统一单位：PDF pt / user space / text origin=baseline）");
  console.log("=".repeat(100));
  console.log(sep);
  console.log(fmtRow(cols));
  console.log(sep);
  rows.forEach((row) => console.log(fmtRow(row)));
  console.log(sep);

  const dImport = pt0 ? pt0[5] - ORIGIN_Y : NaN;
  const dMutate = mpt0 ? mpt0[5] - (pt0 ? pt0[5] : NaN) : NaN;
  const dExportCmd = c0.baseline - (mpt0 ? mpt0[5] : NaN);
  const dFinal = finalRun.full[5] - c0.baseline;
  const dTotal = finalRun.full[5] - ORIGIN_Y;

  console.log("\n逐层 ΔY（PDF pt，正值 = 向上偏移）:");
  console.log(`  原始 operator → import Glyph   : ${r(dImport, 4)}`);
  console.log(`  import Glyph  → mutate 后 Glyph: ${r(dMutate, 4)}`);
  console.log(`  mutate Glyph  → export command : ${r(dExportCmd, 4)}   ← baseline=${r(c0.baseline)} vs pdfTransform[5]=${r(mpt0?.[5])}`);
  console.log(`  export command→ 最终 PDF       : ${r(dFinal, 4)}`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  总漂移 ΔY = 最终PDF − 原始     : ${r(dTotal, 4)}`);
  console.log(`\n  参考：fontSize=${r(targetRun.tfSize)} × 0.72 = ${r(targetRun.tfSize * 0.72, 4)}`);
  console.log(`        你给的实测 ΔY = 4.752（= 572.102 − 567.35）`);

  // 额外：export command 内部基线推导
  console.log("\n\n[export command 基线推导细节]");
  console.log(`  cssToPdf(bbox).y        = ${r(c0.y)}   (bbox 顶部 → PDF)`);
  console.log(`  cmd.baseline            = ${r(c0.baseline)}   (实际 drawText Y)`);
  console.log(`  差值 baseline − y       = ${r(c0.baseline - c0.y, 4)}  pt`);
  console.log(`  bbox.height(CSS)        = ${r(m0.bbox.height)}  → /totalScale = ${r(m0.bbox.height / totalScale, 4)} pt`);
  console.log(`  baseline(CSS)=${r(m0.baseline)}  bbox.y+h(CSS)=${r(m0.bbox.y + m0.bbox.height)}`);
  console.log(`  (bbox.y+h − baseline)/scale = ${r((m0.bbox.y + m0.bbox.height - m0.baseline) / totalScale, 4)} pt`);
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
