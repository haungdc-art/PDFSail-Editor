/**
 * @diagnostic BUG-EDITOR-OVERLAY-001 · Original Text Removal Failure · provenance 审计
 *
 * stripReplacedTextOperators（export-renderer.ts:304-441）靠 **CID 序列** 匹配原文算子：
 *   glyphRawCode(g) = g.pdfCharCode ?? g.metrics?.pdfCharCode        (:211-215)
 *   splitLineIntoFragments(line.glyphs) → 每个 fragment = 一段原始 CID 序列  (:222-266)
 *   findContiguousRuns(opCodes, frag.codes) → 在 content stream 算子里找相等 CID 段  (:280-303)
 *   operatorCidCodes(o.rawBytes) → 算子原始字节 → CID 序列            (:269-277)
 *
 * 本脚本回答：glyph 里存的 pdfCharCode，是否等于 content stream 的真实 CID？
 * 若不等 → CID 序列永不匹配 → 原文永不删除 → 重影。
 *
 * 用法: npx tsx _diag_ytrace_07_provenance.mts <PDF> [行锚点]
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

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
(pdfjs as any).GlobalWorkerOptions.workerSrc = new URL(
  "../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url,
).href;

import { parsePdfToEditableDocument } from "./pdf-importer";

const OPS: Record<string, number> = (pdfjs as any).OPS ?? {};
const OP_NAME: Record<number, string> = {};
for (const [k, v] of Object.entries(OPS)) if (typeof v === "number") OP_NAME[v] = k;

const r = (n: any, d = 3) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);

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

/** 复刻 export-renderer.ts:212-215 */
const glyphRawCode = (g: any): number | undefined => {
  const c = g.pdfCharCode ?? g.metrics?.pdfCharCode;
  return typeof c === "number" ? c : undefined;
};

/** 复刻 export-renderer.ts:222-266 */
function splitLineIntoFragments(glyphs: any[]): { codes: number[]; hasEdit: boolean }[] {
  const frags: { codes: number[]; hasEdit: boolean }[] = [];
  const adv: number[] = [];
  for (let i = 1; i < glyphs.length; i++) {
    const a = glyphs[i - 1].bbox;
    const b = glyphs[i].bbox;
    if (a && b) adv.push(b.x - (a.x + (a.width ?? 0)));
  }
  adv.sort((x, y) => x - y);
  const medianAdv = adv.length ? adv[Math.floor(adv.length / 2)] : 0;
  const gapLimit = Math.max(2, medianAdv * 3);
  let cur: number[] = [];
  let curEdit = false;
  let prevX: number | null = null;
  let prevW = 0;
  const flush = () => { if (cur.length) frags.push({ codes: cur, hasEdit: curEdit }); cur = []; curEdit = false; };
  for (const g of glyphs) {
    const code = glyphRawCode(g);
    const edited = g.originalChar !== undefined && g.char !== g.originalChar;
    if (code === undefined) { flush(); prevX = null; continue; }
    const x = g.bbox?.x;
    if (cur.length && prevX !== null && typeof x === "number") {
      const gap = x - (prevX + prevW);
      if (gap > gapLimit || x + 1 < prevX || edited !== curEdit) flush();
    }
    cur.push(code);
    if (edited) curEdit = true;
    if (typeof x === "number") prevX = x;
    prevW = g.bbox?.width ?? 0;
  }
  flush();
  return frags.filter((f) => f.codes.length > 0);
}

async function main() {
  const pdfPath = process.argv[2];
  const anchor = process.argv[3] ?? "268282-1-1";
  if (!pdfPath) { console.error("用法: npx tsx _diag_ytrace_07_provenance.mts <PDF> [行锚点]"); process.exit(2); }
  const abs = resolve(pdfPath);
  if (!existsSync(abs)) { console.error(`文件不存在: ${abs}`); process.exit(2); }
  const fileBuf = readFileSync(abs);
  const fresh = () => new Uint8Array(Uint8Array.from(fileBuf).buffer);

  console.log("=".repeat(100));
  console.log("Original Text Removal Failure · provenance 审计");
  console.log("=".repeat(100));
  console.log(`PDF: ${abs}\n行锚点: ${JSON.stringify(anchor)}`);

  // ── ① content stream 真实算子（含原始 CID）──
  const pdf = await (pdfjs as any).getDocument({
    data: fresh(), useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true,
  }).promise;
  const page = await pdf.getPage(1);
  const ol = await page.getOperatorList();
  let ctm: M6 = [1, 0, 0, 1, 0, 0];
  let tm: M6 = [1, 0, 0, 1, 0, 0];
  let tlm: M6 = [1, 0, 0, 1, 0, 0];
  let tl = 0, ts = 0, tz = 1, tfs = 0, fontRes = "?";
  const gsStack: M6[] = [];
  const runs: { seq: number; codes: number[]; text: string; y: number; x: number; font: string; op: string }[] = [];
  let seq = 0;
  for (let i = 0; i < ol.fnArray.length; i++) {
    const name = OP_NAME[ol.fnArray[i]] ?? String(ol.fnArray[i]);
    const args = (ol.argsArray[i] ?? []) as any[];
    switch (name) {
      case "transform": ctm = mul([args[0], args[1], args[2], args[3], args[4], args[5]] as M6, ctm); break;
      case "save": gsStack.push([...ctm] as M6); break;
      case "restore": ctm = gsStack.pop() ?? ctm; break;
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
        const codes: number[] = []; let text = "";
        for (const g of glyphs) {
          if (typeof g === "number") codes.push(g);
          else if (g && typeof g === "object") {
            const fc = g.fontChar ?? g.unicode ?? "";
            if (typeof fc === "string" && fc.length) codes.push(fc.codePointAt(0)!);
            text += g.unicode ?? g.fontChar ?? "";
          } else if (typeof g === "string") text += g;
        }
        const full = mul(mul([tfs * tz, 0, 0, tfs, 0, ts] as M6, tm), ctm);
        runs.push({ seq: seq++, codes, text, y: r(full[5], 2), x: r(full[4], 2), font: fontRes, op: name });
        break;
      }
      default: break;
    }
  }
  await pdf.destroy();

  console.log(`\n── ① content stream 算子（page 1，共 ${runs.length}）──`);
  const rowRuns = runs.filter((u) => Math.abs(u.y - 567.35) < 1);
  console.log(`目标行（y≈567.35）的算子: ${rowRuns.length}`);
  for (const u of rowRuns) {
    console.log(`  #${u.seq} op=${u.op} /${u.font} x=${u.x} y=${u.y}  text=${JSON.stringify(u.text)}`);
    console.log(`       真实 CID = [${u.codes.join(",")}]`);
  }

  // ── ② EditableGlyph 里的 pdfCharCode ──
  const doc = await parsePdfToEditableDocument(fresh(), "diag.pdf");
  let hit: any = null;
  for (const p of doc.pages) for (const b of p.blocks)
    b.lines.forEach((ln: any) => {
      if (!hit) {
        const t = (ln.glyphs ?? []).map((g: any) => g.char ?? "").join("");
        if (t.includes(anchor)) hit = { block: b, line: ln, lineText: t };
      }
    });
  if (!hit) { console.log("未找到目标行"); process.exit(1); }
  const { block, line, lineText } = hit;

  console.log(`\n── ② EditableGlyph 的 pdfCharCode（block=${block.id} line=${line.id}）──`);
  console.log(`  行文本 = ${JSON.stringify(lineText)}`);
  console.log(`\n  idx char  pdfCharCode  metrics.pdfCharCode  rawCode  fontRef  bbox.x  advW`);
  const gs = line.glyphs as any[];
  for (let i = 0; i < Math.min(gs.length, 22); i++) {
    const g = gs[i];
    const top = typeof g.pdfCharCode === "number" ? g.pdfCharCode : undefined;
    const met = typeof g.metrics?.pdfCharCode === "number" ? g.metrics.pdfCharCode : undefined;
    const raw = glyphRawCode(g);
    console.log(
      `  ${String(i).padStart(3)} ${JSON.stringify(g.char).padEnd(5)} ${String(top ?? "-").padStart(11)} ` +
      `${String(met ?? "-").padStart(19)} ${String(raw ?? "-").padStart(8)} ` +
      `${String(g.fontIdentity?.fontRef ?? g.metrics?.fontIdentity?.fontRef ?? "-").padStart(8)} ` +
      `${String(r(g.bbox?.x)).padStart(7)} ${String(r(g.metrics?.advanceWidth)).padStart(6)}`,
    );
  }
  const distinct = new Set(gs.map((g) => glyphRawCode(g)));
  console.log(`\n  rawCode 去重集合（前 20）= [${[...distinct].slice(0, 20).join(", ")}]  共 ${distinct.size} 种`);
  console.log(`  content stream 该行真实 CID 范围 = [${
    [...new Set(rowRuns.flatMap((u) => u.codes))].slice(0, 20).join(", ")
  }]`);

  // ── ③ 模拟 stripReplacedTextOperators 的匹配 ──
  console.log(`\n── ③ 模拟 splitLineIntoFragments → findContiguousRuns 匹配 ──`);
  const frags = splitLineIntoFragments(gs);
  console.log(`  切分出 ${frags.length} 个 fragment:`);
  frags.forEach((f, i) => {
    console.log(`    [${i}] hasEdit=${f.hasEdit} codes(${f.codes.length}) = [${f.codes.slice(0, 14).join(",")}${f.codes.length > 14 ? ",…" : ""}]`);
  });

  // 构造 opCodes（复刻 operatorCidCodes：偶数长度按 2 字节大端）
  const operatorCidCodes = (rawBytes: number[]): number[] => {
    if (!rawBytes || rawBytes.length === 0) return [];
    if (rawBytes.length >= 2 && rawBytes.length % 2 === 0) {
      const codes: number[] = [];
      for (let i = 0; i < rawBytes.length; i += 2) codes.push((rawBytes[i] << 8) | (rawBytes[i + 1]));
      return codes;
    }
    return rawBytes.slice();
  };
  const allCodes = runs.flatMap((u) => u.codes);
  // content stream 里每个算子一个 CID 列表；这里用整行算子的 CID 序列做粗匹配
  const opCodes: number[][] = rowRuns.map((u) => u.codes);

  const arraysEqual = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  function findContiguousRuns(list: number[][], target: number[]): { start: number; end: number }[] {
    const out: { start: number; end: number }[] = [];
    if (target.length === 0) return out;
    let i = 0;
    while (i < list.length) {
      let acc: number[] = [];
      let j = i;
      let matched = false;
      while (j < list.length) {
        acc = acc.concat(list[j]);
        if (acc.length === target.length) {
          if (arraysEqual(acc, target)) { out.push({ start: i, end: j }); matched = true; }
          break;
        }
        if (acc.length > target.length) break;
        j++;
      }
      i = matched ? j + 1 : i + 1;
    }
    return out;
  }

  let totalHits = 0;
  for (const f of frags.filter((x) => x.hasEdit)) {
    const m = findContiguousRuns(opCodes, f.codes);
    totalHits += m.length;
    console.log(`  hasEdit fragment codes=[${f.codes.slice(0, 10).join(",")}${f.codes.length > 10 ? ",…" : ""}] → 命中 ${m.length} 段`);
  }
  console.log(`\n  >>> 可剥离片段总数 = ${totalHits}   （0 = 原文永不删除 → 重影）`);

  // ── ④ 结论 ──
  const realFirst = rowRuns[0]?.codes?.[0];
  const modelFirst = glyphRawCode(gs[0]);
  console.log(`\n── ④ 判定 ──`);
  console.log(`  content stream 首字符真实 CID = ${realFirst}`);
  console.log(`  模型 glyph[0].rawCode         = ${modelFirst}`);
  console.log(`  相等? ${realFirst === modelFirst ? "✅ 相等（provenance 完好）" : "❌ 不等（PROVENANCE LOSS）"}`);
  if (realFirst !== modelFirst) {
    console.log(`\n  → splitLineIntoFragments 用 [${modelFirst},…] 去匹配 content stream 的 [${realFirst},…]`);
    console.log(`  → CID 序列永不相等 → findContiguousRuns 返回 0 → targets 为空 → 原文不删除`);
  }
  console.log(`\n  全部 rawCode 是否单一值（同一行不同字符却是同一个 code）: ${distinct.size <= 1 ? "✅ 是（明显错误）" : "否"}`);
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
