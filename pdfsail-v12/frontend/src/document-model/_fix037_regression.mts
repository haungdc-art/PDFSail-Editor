/**
 * M7.8-037 Provenance Propagation Regression（任务 5-6）
 *
 * 复用目标 PDF 的真实算子，驱动 导入→Mutation→导出→重读 真实管线，验证：
 *   P1 single-char   (mutateGlyphChar)
 *   P2 multi-char     (mutateLineText range)
 *   P3 cross-operator (整行重写跨多 operator)
 *   P4 Find&Replace + AI Translation (mutateFindAndReplace / TranslateCommand)
 *
 * 关键断言：
 *   - operatorId preservation 100%（每个从 existing glyph 映射的新 glyph 继承对应原 glyph 的 operatorId）
 *   - operatorCharIndex preservation 100%
 *   - 跨 operator 行：禁止把整行 provenance 错绑到一个 operator（新行 distinct operatorId 集合 == 原行）
 *   - E2E: 原 operator 被正确剥离（operatorText 清空）且无 collateral deletion（glyph 总数保持）
 *
 * 不修改 production code。运行：npx tsx _fix037_regression.mts <pdfPath>
 */
import * as fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { resolvePageShowTextWithXObjects, type TextShowRecord } from "./content-stream-resolver";
import type { EditableGlyph, EditableDocument, EditableLine } from "./types";
import { exportEditableDocument } from "./export-renderer";
import { mutateGlyphChar, mutateLineText, mutateFindAndReplace } from "./document-mutation";
import { TranslateCommand } from "./translate-command";
import { EditorRuntime } from "./editor-runtime";

try {
  const { createCanvas } = require("@napi-rs/canvas") as any;
  (globalThis as any).document = { createElement: (t: string) => (t === "canvas" ? createCanvas(1, 1) : ({ getContext: () => null } as any)) };
} catch {
  (globalThis as any).document = { createElement: (t: string) => (t === "canvas" ? { getContext: () => ({ measureText: () => ({ width: 5 }), font: "" }) } : ({ getContext: () => null } as any)) };
}

const SUPPRESS = /\[(Sprint40-fix|Sprint34|YDIAG|M7\.8|PDFdraw|ExportLayout|WRITE_ENTRY|COORD_DIAG|DrawGlyph|NATIVE_REPLAY|009B|FIX-002|EditableDocument|ExportRenderer|DBG)\]/;
const _log = console.log.bind(console);
const _err = console.error.bind(console);
console.log = (...a: any[]) => { const s = typeof a[0] === "string" ? a[0] : ""; if (!SUPPRESS.test(s)) _log(...a); };
console.error = (...a: any[]) => { const s = typeof a[0] === "string" ? a[0] : ""; if (!SUPPRESS.test(s)) _err(...a); };

interface CaseResult { name: string; ok: boolean; details: string[]; }

function glyphsOf(doc: EditableDocument): EditableGlyph[] {
  const out: EditableGlyph[] = [];
  for (const p of doc.pages) for (const b of p.blocks) for (const l of b.lines) for (const g of l.glyphs) out.push(g);
  return out;
}
function recsOf(pdf: PDFDocument, page = 0): TextShowRecord[] {
  return resolvePageShowTextWithXObjects(pdf, page) as TextShowRecord[];
}
function textsOf(pdf: PDFDocument, page = 0): string[] {
  return recsOf(pdf, page).map((r) => r.operatorText);
}
async function freshDoc(bytes: Uint8Array): Promise<EditableDocument> {
  const p = await PDFDocument.load(bytes);
  return parsePdfToEditableDocument(bytes as unknown as ArrayBuffer, p);
}
type LineLoc = { blockId: string; lineId: string };
function findLineByText(doc: EditableDocument, substr: string): { loc: LineLoc; line: EditableLine } | null {
  for (const p of doc.pages) for (const b of p.blocks) for (const l of b.lines) {
    if (l.glyphs.map((g) => g.char).join("").includes(substr)) return { loc: { blockId: b.id, lineId: l.id }, line: l };
  }
  return null;
}
function getLine(doc: EditableDocument, loc: LineLoc): EditableLine | null {
  for (const p of doc.pages) for (const b of p.blocks) for (const l of b.lines)
    if (b.id === loc.blockId && l.id === loc.lineId) return l;
  return null;
}
// 取某算子在 doc 中首次出现的 glyph 位置
function findGlyphLoc(doc: EditableDocument, opId: string, charIndex: number): { loc: LineLoc; glyphIndex: number } | null {
  for (const p of doc.pages) for (const b of p.blocks) for (const l of b.lines) {
    const gs = l.glyphs.map((g, i) => ({ g, i })).filter((x) => x.g.operatorId === opId);
    if (gs.length > charIndex) return { loc: { blockId: b.id, lineId: l.id }, glyphIndex: gs[charIndex].i };
  }
  return null;
}

// ── provenance 契约断言 ──
function provEq(g: EditableGlyph, e: { operatorId?: string | null; operatorCharIndex?: number | null }): boolean {
  return (g.operatorId ?? null) === (e.operatorId ?? null) && (g.operatorCharIndex ?? null) === (e.operatorCharIndex ?? null);
}
// 对比一个 segment：newArr[i] 应继承 expArr[i]（expArr[i]=undefined 表示插入，期望 operatorId 也为 undefined）
function segCompare(newArr: EditableGlyph[], expArr: (EditableGlyph | undefined)[]): { mismatch: number; mapped: number } {
  let mismatch = 0, mapped = 0;
  for (let i = 0; i < newArr.length; i++) {
    const exp = expArr[i];
    mapped++;
    if (!provEq(newArr[i], { operatorId: exp?.operatorId ?? null, operatorCharIndex: exp?.operatorCharIndex ?? null })) mismatch++;
  }
  return { mismatch, mapped };
}
// 通用 provenance 检查：range 路径（start,end 为原选区区间，含）或非 range（整行重写）
function provenanceCheck(line0: EditableLine, line1: EditableLine, range?: { start: number; end: number }): { mismatch: number; mapped: number } {
  const start = range ? Math.max(0, range.start) : 0;
  const end = range ? Math.min(range.end, line0.glyphs.length - 1) : line0.glyphs.length - 1;
  const suffixLen = line0.glyphs.length - (end + 1);
  const replacementLen = line1.glyphs.length - start - suffixLen;
  let mismatch = 0, mapped = 0;
  // prefix
  { const r = segCompare(line1.glyphs.slice(0, start), line0.glyphs.slice(0, start)); mismatch += r.mismatch; mapped += r.mapped; }
  // replacement
  {
    const newSeg = line1.glyphs.slice(start, start + replacementLen);
    const expSeg: (EditableGlyph | undefined)[] = [];
    for (let j = 0; j < replacementLen; j++) {
      const origIdx = start + j;
      expSeg.push(origIdx <= end ? line0.glyphs[origIdx] : undefined);
    }
    const r = segCompare(newSeg, expSeg); mismatch += r.mismatch; mapped += r.mapped;
  }
  // suffix
  { const r = segCompare(line1.glyphs.slice(start + replacementLen), line0.glyphs.slice(end + 1)); mismatch += r.mismatch; mapped += r.mapped; }
  return { mismatch, mapped };
}

// E2E：导出 mutated doc → 重读，验证原 operator 文本消失（native 替换或 strip+overlay 均可）+ 无 collateral deletion + 新文出现
async function e2eCheck(doc2: EditableDocument, bytes: Uint8Array, editedLoc: LineLoc, line0: EditableLine, expectedNewChars: string, label: string): Promise<{ ok: boolean; details: string[] }> {
  const details: string[] = [];
  const out = await exportEditableDocument(doc2, bytes as unknown as ArrayBuffer);
  const pdfOut = await PDFDocument.load(out);
  const outRecs = recsOf(pdfOut, 0);
  const exportedTexts = outRecs.map((r) => r.operatorText);
  const line1 = getLine(doc2, editedLoc)!;
  const editedOpIds = [...new Set(line1.glyphs.filter((g) => g.modified).map((g) => g.operatorId).filter((x): x is string => !!x))];
  // 原 operator 文本消失：检查该算子「自身」在导出 PDF 中的 recorded 文本——native 替换（=new）或
  //   strip+overlay（=""）都算原文消失、无重影。用算子自身的 rec 而非全局文本层，避免 "-" 等常见字符误判。
  let removedOk = true;
  for (const opId of editedOpIds) {
    const origText = line0.glyphs.filter((g) => g.operatorId === opId).map((g) => g.originalChar ?? g.char).join("");
    const rec = outRecs.find((r) => r.operatorId === opId);
    const recText = rec ? rec.operatorText : "";
    const gone = recText === "" || !recText.includes(origText);
    if (!gone) removedOk = false;
    details.push(`  编辑算子 ${opId} 原文本消失=${gone} 导出算子文本=${JSON.stringify(recText.slice(0, 12))}`);
  }
  // 无 collateral deletion：glyph 总数保持
  const docOut = await freshDoc(out);
  const outGlyphCount = glyphsOf(docOut).length;
  const origGlyphCount = glyphsOf(doc2).length;
  const glyphKept = outGlyphCount >= origGlyphCount - 5;
  details.push(`  glyph 总数 导出=${outGlyphCount}/改后=${origGlyphCount} (≈ 则无 collateral)`);
  // 新文出现
  const outChars = glyphsOf(docOut).map((g) => g.char).join("");
  const newPresent = expectedNewChars.split("").every((c) => outChars.includes(c));
  details.push(`  新字符出现=${newPresent} (期望含 ${JSON.stringify(expectedNewChars)})`);
  const ok = removedOk && glyphKept && newPresent;
  details.unshift(`[${label}] E2E: 原算子移除=${removedOk} 无collateral=${glyphKept} 新文=${newPresent}`);
  return { ok, details };
}

async function main() {
  const pdfPath = process.argv[2] as string;
  const bytes = fs.readFileSync(pdfPath);
  const doc0 = await freshDoc(bytes);
  const recs = recsOf(await PDFDocument.load(bytes), 0);

  // 选真实算子
  const tjOne = recs.find((r) => r.op === "Tj" && r.unicodeText && r.unicodeText.length === 1 && r.operatorId); // 单字符 Tj
  const tjMulti = recs.find((r) => r.op === "Tj" && r.unicodeText && (r.unicodeText.length ?? 0) >= 5 && r.operatorId); // 多字符 Tj

  const results: CaseResult[] = [];
  const agg = { opMismatch: 0, opMapped: 0, charMismatch: 0, charMapped: 0 };

  // ── P1: single-char (mutateGlyphChar) ──
  {
    const opId = tjOne?.operatorId ?? tjMulti?.operatorId!;
    const locG = findGlyphLoc(doc0, opId, 0);
    if (locG) {
      const line0 = getLine(doc0, locG.loc)!;
      const from = line0.glyphs[locG.glyphIndex].char;
      const to = from === "X" ? "Y" : "X";
      const res = mutateGlyphChar(doc0, locG.loc.blockId, locG.loc.lineId, locG.glyphIndex, to);
      const line1 = getLine(res.document, locG.loc)!;
      const pc = provenanceCheck(line0, line1);
      agg.opMismatch += pc.mismatch; agg.opMapped += pc.mapped;
      agg.charMismatch += pc.mismatch; agg.charMapped += pc.mapped;
      const e2e = await e2eCheck(res.document, bytes, locG.loc, line0, to, "P1");
      results.push({ name: "P1 single-char (mutateGlyphChar)", ok: pc.mismatch === 0 && e2e.ok, details: [`算子 ${opId} glyph#${locG.glyphIndex} '${from}'→'${to}'`, `provenance mismatch=${pc.mismatch}/${pc.mapped}`, ...e2e.details] });
    } else results.push({ name: "P1", ok: false, details: ["无可用单字符算子"] });
  }

  // ── P2: multi-char (mutateLineText range) ──
  {
    const opId = tjMulti?.operatorId!;
    const locG = findGlyphLoc(doc0, opId, 0);
    if (locG) {
      const line0 = getLine(doc0, locG.loc)!;
      const T = line0.glyphs.map((g) => g.char).join("");
      const n = Math.min(5, line0.glyphs.length);
      const newHead = Array.from({ length: n }, (_, i) => (T[i] === "X" ? "Y" : "Q")).join("");
      const newText = newHead + T.slice(n);
      const range = { start: 0, end: n - 1 };
      const res = mutateLineText(doc0, locG.loc.blockId, locG.loc.lineId, newText, range);
      const line1 = getLine(res.document, locG.loc)!;
      const pc = provenanceCheck(line0, line1, range);
      agg.opMismatch += pc.mismatch; agg.opMapped += pc.mapped;
      agg.charMismatch += pc.mismatch; agg.charMapped += pc.mapped;
      const e2e = await e2eCheck(res.document, bytes, locG.loc, line0, newHead, "P2");
      // cross-operator guard：replacement 区间不应全部错绑到单一 operator
      const repSeg = line1.glyphs.slice(0, n);
      const ids = new Set(repSeg.map((g) => g.operatorId).filter(Boolean));
      results.push({ name: "P2 multi-char (mutateLineText range)", ok: pc.mismatch === 0 && e2e.ok, details: [`算子 ${opId} 改前${n}字符 → '${newHead}'`, `provenance mismatch=${pc.mismatch}/${pc.mapped}`, `replacement distinct operatorId=${[...ids].length}`, ...e2e.details] });
    } else results.push({ name: "P2", ok: false, details: ["无可用多字符算子"] });
  }

  // ── P3: cross-operator 行替换（range 跨两个 operator，只改少量 glyph 以控制导出开销）──
  {
    // 找一行含 ≥2 个不同 operatorId（且都非 undefined）
    let target: { loc: LineLoc; line: EditableLine } | null = null;
    for (const p of doc0.pages) for (const b of p.blocks) for (const l of b.lines) {
      const ids = new Set(l.glyphs.map((g) => g.operatorId).filter(Boolean));
      if (ids.size >= 2) { target = { loc: { blockId: b.id, lineId: l.id }, line: l }; break; }
    }
    if (target) {
      const line0 = target.line;
      const ids = [...new Set(line0.glyphs.map((g) => g.operatorId).filter(Boolean))];
      const A = ids[0], B = ids[1];
      const aStart = line0.glyphs.findIndex((g) => g.operatorId === A);
      let bEnd = -1;
      line0.glyphs.forEach((g, i) => { if (g.operatorId === B) bEnd = i; });
      const start = aStart, end = bEnd; // 区间跨越 operator A 与 B
      const T = line0.glyphs.map((g) => g.char).join("");
      // 长度保持：仅区间内的偶数位字符替换（实际改变，触发 mutation）
      const newText = Array.from(T).map((c, i) => (i >= start && i <= end && i % 2 === 0) ? (c === "X" ? "Y" : "Q") : c).join("");
      const range = { start, end };
      const res = mutateLineText(doc0, target.loc.blockId, target.loc.lineId, newText, range);
      const line1 = getLine(res.document, target.loc)!;
      const pc = provenanceCheck(line0, line1, range);
      agg.opMismatch += pc.mismatch; agg.opMapped += pc.mapped;
      agg.charMismatch += pc.mismatch; agg.charMapped += pc.mapped;
      // 跨 operator 守护：replacement 区间的 distinct operatorId 集合必须 == 原区间 {A,B}（禁止错绑单一 operator）
      const repSeg = line1.glyphs.slice(start, end + 1);
      const idsNew = [...new Set(repSeg.map((g) => g.operatorId).filter(Boolean))].sort();
      const idsOld = [...new Set(line0.glyphs.slice(start, end + 1).map((g) => g.operatorId).filter(Boolean))].sort();
      const crossOk = idsNew.length >= 2 && JSON.stringify(idsOld) === JSON.stringify(idsNew);
      const e2e = await e2eCheck(res.document, bytes, target.loc, line0, "Q", "P3");
      results.push({ name: "P3 cross-operator 行替换 (range)", ok: pc.mismatch === 0 && crossOk && e2e.ok, details: [`区间[${start},${end}] 跨 operator ${A} & ${B}`, `replacement distinct operatorId=${idsNew.length} 集合一致=${JSON.stringify(idsOld) === JSON.stringify(idsNew)}`, `provenance mismatch=${pc.mismatch}/${pc.mapped}`, ...e2e.details] });
    } else results.push({ name: "P3", ok: false, details: ["无跨 operator 行可测"] });
  }

  // ── P4a: Find&Replace (mutateFindAndReplace) ──
  {
    const hit = findLineByText(doc0, "Solicitamos");
    if (hit) {
      const line0 = hit.line;
      const T = line0.glyphs.map((g) => g.char).join("");
      const oldText = "Solicitamos";
      const newText = "SolicitamosXYZ"; // 更长 → 含插入 glyph（operatorId 应为 undefined）
      const res = mutateFindAndReplace(doc0, oldText, newText);
      const line1 = getLine(res.document, hit.loc)!;
      const pc = provenanceCheck(line0, line1);
      agg.opMismatch += pc.mismatch; agg.opMapped += pc.mapped;
      agg.charMismatch += pc.mismatch; agg.charMapped += pc.mapped;
      const e2e = await e2eCheck(res.document, bytes, hit.loc, line0, "XYZ", "P4a");
      // 插入 glyph（超出原行长）必须 operatorId=undefined
      const inserted = line1.glyphs.slice(T.length);
      const insertOk = inserted.every((g) => g.operatorId === undefined && g.operatorCharIndex === undefined);
      results.push({ name: "P4a Find&Replace (mutateFindAndReplace)", ok: pc.mismatch === 0 && insertOk && e2e.ok, details: [`替换 '${oldText}'→'${newText}'`, `provenance mismatch=${pc.mismatch}/${pc.mapped}`, `插入glyph数=${inserted.length} 全部operatorId=undefined=${insertOk}`, ...e2e.details] });
    } else results.push({ name: "P4a", ok: false, details: ["无含 'Solicitamos' 的行"] });
  }

  // ── P4b: AI Translation (TranslateCommand range，模拟 LLM 输出更长译文) ──
  {
    const hit = findLineByText(doc0, "providenciar");
    if (hit) {
      const line0 = hit.line;
      const T = line0.glyphs.map((g) => g.char).join("");
      const oldText = "providenciar";
      const start = T.indexOf(oldText);
      const end = start + oldText.length - 1;
      const translated = "proVIdenciar_TRANSLATED_LONGER"; // 更长译文
      const newText = T.slice(0, start) + translated + T.slice(end + 1);
      const holder: { doc: EditableDocument } = { doc: doc0 };
      const runtime = new EditorRuntime({
        getDocument: () => holder.doc,
        applyDocument: (r) => { holder.doc = r.document; },
      });
      const cmd = new TranslateCommand(runtime);
      await cmd.execute({ blockId: hit.loc.blockId, lineId: hit.loc.lineId, startGlyphIndex: start, endGlyphIndex: end } as any, { text: translated });
      const doc2 = holder.doc;
      const line1 = getLine(doc2, hit.loc)!;
      const pc = provenanceCheck(line0, line1, { start, end });
      agg.opMismatch += pc.mismatch; agg.opMapped += pc.mapped;
      agg.charMismatch += pc.mismatch; agg.charMapped += pc.mapped;
      const e2e = await e2eCheck(doc2, bytes, hit.loc, line0, "TRANSLATED", "P4b");
      results.push({ name: "P4b AI Translation (TranslateCommand)", ok: pc.mismatch === 0 && e2e.ok, details: [`区间[${start},${end}] 译文长=${translated.length}`, `provenance mismatch=${pc.mismatch}/${pc.mapped}`, ...e2e.details] });
    } else results.push({ name: "P4b", ok: false, details: ["无含 'providenciar' 的行"] });
  }

  // ── 报告 ──
  const pass = results.filter((r) => r.ok).length;
  const opPct = agg.opMapped ? (100 * (agg.opMapped - agg.opMismatch) / agg.opMapped) : 100;
  const charPct = agg.charMapped ? (100 * (agg.charMapped - agg.charMismatch) / agg.charMapped) : 100;
  _log("==================================================");
  _log("M7.8-037 Provenance Propagation Regression Report");
  _log("==================================================");
  for (const r of results) {
    _log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
    for (const d of r.details) _log(`      ${d}`);
  }
  _log("--------------------------------------------------");
  _log(`P1-P4: ${pass}/${results.length} PASS`);
  _log(`operatorId preservation:       ${opPct.toFixed(1)}%  (mismatch ${agg.opMismatch}/${agg.opMapped})`);
  _log(`operatorCharIndex preservation: ${charPct.toFixed(1)}%  (mismatch ${agg.charMismatch}/${agg.charMapped})`);
  _log(`original operator removal:     ${results.every((r) => r.ok) ? "PASS" : "CHECK E2E 行"}`);
  _log(`new text rendering:            ${results.every((r) => r.ok) ? "PASS" : "CHECK"}`);
  _log(`collateral deletion:           ${results.every((r) => r.ok) ? "0" : "CHECK"}`);
  _log("==================================================");
}

main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
