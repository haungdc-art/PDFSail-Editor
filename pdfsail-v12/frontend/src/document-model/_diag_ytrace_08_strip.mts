/**
 * @diagnostic BUG-EDITOR-OVERLAY-001 · 为什么 stripReplacedTextOperators 没删掉原文
 *
 * 用生产环境同一个 resolver（resolvePageShowTextWithXObjects）取 content stream 的
 * **原始字节**，复刻 stripReplacedTextOperators 的完整判定链：
 *   splitLineIntoFragments → nonEditedFragments 唯一性栅栏 → findContiguousRuns
 * 逐步打印每一步的通过/拦截情况。
 *
 * 用法: npx tsx _diag_ytrace_08_strip.mts <PDF> [行锚点] [被改字符下标]
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

import { PDFDocument } from "pdf-lib";
import { resolvePageShowTextWithXObjects } from "./content-stream-resolver";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { mutateLineText } from "./document-mutation";

const r3 = (n: any, d = 3) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);

// ── 复刻 export-renderer.ts:212-303 ──
const glyphRawCode = (g: any): number | undefined => {
  const c = g.pdfCharCode ?? g.metrics?.pdfCharCode;
  return typeof c === "number" ? c : undefined;
};

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

// M7.8-036-FIX-001：不再按 rawBytes 长度猜测编码，直接消费 TextShowRecord.charCodes。
// 无法权威解码（null）用 NaN 占位 → 天然匹配屏障。
const authoritativeCodes = (rec: { charCodes?: number[] | null }): number[] =>
  rec.charCodes ?? [Number.NaN];

const arraysEqual = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function findContiguousRuns(opCodes: number[][], target: number[]): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = [];
  if (target.length === 0) return runs;
  let i = 0;
  while (i < opCodes.length) {
    let acc: number[] = [];
    let j = i;
    let matched = false;
    while (j < opCodes.length) {
      acc = acc.concat(opCodes[j]);
      if (acc.length === target.length) {
        if (arraysEqual(acc, target)) { runs.push({ start: i, end: j }); matched = true; }
        break;
      }
      if (acc.length > target.length) break;
      j++;
    }
    i = matched ? j + 1 : i + 1;
  }
  return runs;
}

async function main() {
  const pdfPath = process.argv[2];
  const anchor = process.argv[3] ?? "268282-1-1";
  const editIdxArg = process.argv[4];
  if (!pdfPath) { console.error("用法: npx tsx _diag_ytrace_08_strip.mts <PDF> [行锚点] [被改字符下标]"); process.exit(2); }
  const abs = resolve(pdfPath);
  if (!existsSync(abs)) { console.error(`文件不存在: ${abs}`); process.exit(2); }
  const fileBuf = readFileSync(abs);
  const fresh = () => new Uint8Array(Uint8Array.from(fileBuf).buffer);

  console.log("=".repeat(100));
  console.log("stripReplacedTextOperators 判定链复刻");
  console.log("=".repeat(100));
  console.log(`PDF: ${abs}`);

  // ── ① content stream 原始字节（生产 resolver）──
  const libDoc = await PDFDocument.load(fresh(), { ignoreEncryption: true, throwOnInvalidObject: false });
  const records = resolvePageShowTextWithXObjects(libDoc, 0);
  console.log(`\n── ① resolvePageShowTextWithXObjects(page 0): ${records.length} 条 ──`);
  const byStream = new Map<string, typeof records>();
  for (const rec of records) {
    if (!byStream.has(rec.streamObjRef)) byStream.set(rec.streamObjRef, []);
    byStream.get(rec.streamObjRef)!.push(rec);
  }
  for (const [ref, recs] of byStream) {
    const authoritative = recs.filter((o) => o.charCodes !== null).length;
    const basis: Record<string, number> = {};
    for (const o of recs) basis[o.charCodeBasis] = (basis[o.charCodeBasis] ?? 0) + 1;
    console.log(`  stream ${ref}: ${recs.length} 算子，权威解码 ${authoritative}，unknown ${recs.length - authoritative}`);
    console.log(`      编码依据分布: ${JSON.stringify(basis)}`);
    const sample = recs.slice(0, 4).map((o) => {
      const c = o.charCodes;
      return `${o.op}{${o.literalKind}} font=${o.fontResourceKey || "-"} bytes[${o.rawBytes.length}]` +
        `=[${o.rawBytes.slice(0, 6).join(",")}${o.rawBytes.length > 6 ? "…" : ""}]` +
        ` → codes(${o.charCodeBasis})[${c ? c.length : "null"}]=[${c ? c.slice(0, 6).join(",") + (c.length > 6 ? ",…" : "") : "—"}]`;
    });
    sample.forEach((s) => console.log(`      ${s}`));
  }

  // ── ①-b 全部算子明细 ──
  console.log(`\n── ①-b 全部算子明细（按字节序）──`);
  const allRecs = [...records].sort((a, b) => a.byteStart - b.byteStart);
  allRecs.forEach((o, i) => {
    const cc = o.charCodes;
    console.log(
      `  ${String(i).padStart(2)} font=${(o.fontResourceKey || "-").padEnd(4)} ${o.op} ${o.literalKind.padEnd(7)} ` +
      `codes[${cc ? cc.length : "null"}]=[${cc ? cc.slice(0, 14).join(",") + (cc.length > 14 ? ",…" : "") : "—"}]  ` +
      `text=${JSON.stringify((o.operatorText || "").slice(0, 30))}`,
    );
  });

  // ── ② 导入 + 模拟编辑 ──
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

  // 定位 "1.057,50" 里的 '7'
  const editIdx = editIdxArg !== undefined ? Number(editIdxArg) : lineText.indexOf("1.057,50") + 4;
  console.log(`\n── ② 模拟编辑 ──`);
  console.log(`  line=${line.id}  glyphs=${line.glyphs.length}`);
  console.log(`  行文本 = ${JSON.stringify(lineText)}`);
  console.log(`  改下标 ${editIdx}('${lineText[editIdx]}') → 得到 "${lineText.slice(0, editIdx)}9${lineText.slice(editIdx + 1)}"`);

  const newText = lineText.slice(0, editIdx) + "9" + lineText.slice(editIdx + 1);
  const res = mutateLineText(doc, block.id, line.id, newText, { start: editIdx, end: editIdx });
  const doc2 = res.document;

  let line2: any = null;
  for (const p of doc2.pages) for (const b of p.blocks) if (b.id === block.id)
    for (const l of b.lines) if (l.id === line.id) line2 = l;
  const editedCount = line2.glyphs.filter((g: any) => g.originalChar !== undefined && g.char !== g.originalChar).length;
  console.log(`  mutated=${res.mutated}  被编辑 glyph 数=${editedCount}`);

  // ── ③ 唯一性栅栏 ──
  console.log(`\n── ③ splitLineIntoFragments + 唯一性栅栏 ──`);
  const frags = splitLineIntoFragments(line2.glyphs);
  console.log(`  目标行切出 ${frags.length} fragment:`);
  frags.forEach((f, i) => {
    console.log(`    [${i}] hasEdit=${String(f.hasEdit).padEnd(5)} len=${String(f.codes.length).padStart(3)}  codes=[${f.codes.slice(0, 16).join(",")}${f.codes.length > 16 ? ",…" : ""}]`);
  });

  const nonEditedFragments = new Set<string>();
  for (const p of doc2.pages) for (const b of p.blocks)
    b.lines.forEach((ln: any) => {
      if (ln.id === line.id) return;
      for (const f of splitLineIntoFragments(ln.glyphs)) nonEditedFragments.add(f.codes.join(","));
    });
  console.log(`\n  非编辑行 fragment 去重集合大小 = ${nonEditedFragments.size}`);

  const editFrags = frags.filter((f) => f.hasEdit);
  console.log(`  含编辑的 fragment 数 = ${editFrags.length}`);
  let blocked = 0;
  for (const f of editFrags) {
    const key = f.codes.join(",");
    const inFence = nonEditedFragments.has(key);
    if (inFence) blocked++;
    console.log(`    codes=[${f.codes.slice(0, 16).join(",")}${f.codes.length > 16 ? ",…" : ""}]  len=${f.codes.length}`);
    console.log(`       唯一性栅栏: ${inFence ? "❌ 命中 → continue（跳过剥离）" : "✅ 未命中 → 继续匹配"}`);
  }

  // ── ④ CID 序列匹配 ──
  console.log(`\n── ④ findContiguousRuns 匹配 content stream ──`);
  let totalHits = 0;
  for (const [ref, recs] of byStream) {
    const ops = [...recs].sort((a, b) => a.byteStart - b.byteStart);
    const opCodes = ops.map((o) => authoritativeCodes(o));
    console.log(`  stream ${ref}: ${ops.length} 算子`);
    for (const f of editFrags) {
      const key = f.codes.join(",");
      if (nonEditedFragments.has(key)) { console.log(`    片段[${f.codes.slice(0, 10).join(",")}] 被栅栏拦截，未参与匹配`); continue; }
      const m = findContiguousRuns(opCodes, f.codes);
      totalHits += m.length;
      const preview = m.slice(0, 3).map((x) => `[${x.start}..${x.end}] "${ops.slice(x.start, x.end + 1).map((o) => o.operatorText).join("").slice(0, 24)}"`).join(" ");
      console.log(`    片段[${f.codes.slice(0, 10).join(",")}${f.codes.length > 10 ? ",…" : ""}] → 命中 ${m.length} 段 ${preview}`);
    }
  }

  console.log(`\n${"=".repeat(100)}`);
  console.log(`结论：可剥离片段总数 = ${totalHits}`);
  if (totalHits === 0) {
    console.log(`  0 ⇒ stripReplacedTextOperators 一个都不删 ⇒ 原文保留 + 新文叠加 ⇒ 重影`);
    if (blocked > 0) console.log(`  主因候选：唯一性栅栏拦截了 ${blocked}/${editFrags.length} 个含编辑片段`);
    else console.log(`  主因候选：CID 序列本身在 content stream 里找不到（provenance 值不对 / 算子切分不一致）`);
  } else {
    console.log(`  ⇒ 应能剥离 ${totalHits} 段，需回查为何生产流程未生效`);
  }
  console.log("=".repeat(100));
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
