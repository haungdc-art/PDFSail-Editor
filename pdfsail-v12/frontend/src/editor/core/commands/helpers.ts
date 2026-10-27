/**
 * editor/core/commands/helpers.ts — EDITOR-CORE-003
 *
 * 纯函数级 mutation 原语（规范 §27）。
 *
 * 层次：
 *   applyToTextBox(document, textBoxId, updater)   ← 文档级：重建 pages，bump version
 *     └── updater: (tb) => TextBoxObject | null    ← 对象级：返回 null 表示 no-op
 *           ├── insertIntoTextBox
 *           ├── removeRangeFromTextBox
 *           ├── splitParagraphInTextBox
 *           ├── mergeParagraphsInTextBox
 *           └── setStyleInTextBox
 *
 * 全部纯函数：不依赖 React / DOM / PDF.js / PDF 导出（§27）。
 * 全部不可变：不修改入参；未修改的对象共享引用（§3）。
 */

import { bumpVersion, createTextStyle, nextId } from "../document/factory";
import { isTextBox } from "../document/query";
import type {
  EditorDocument,
  Paragraph,
  TextBoxObject,
  TextRun,
  TextStyle,
  TextSourceBinding,
} from "../document/types";
import { getParagraphTextLength, resolveParagraphOffset } from "../position/index";
import type { TextPosition, TextRange } from "../position/types";
import { CommandError } from "./types";

// ─────────────────────────────────────────────────────────────────────
//  Source binding（§24 / §25 / §26）
// ─────────────────────────────────────────────────────────────────────

/**
 * Command 新产生的文本：显式标记 generated，**不带任何 PDF 字段**。
 *
 * §24：不得伪造 blockId / lineId / glyphIndex 冒充新增文本的 PDF source。
 */
export const GENERATED_SOURCE: TextSourceBinding = { kind: "generated" };

/**
 * 文本被修改后，run 上的 glyph 索引不再可靠（行内字符数已偏移）。
 *
 * 保留 kind / blockId / lineId / lineIdx（仍然标识 PDF 中的块与行），
 * 仅清除 startGlyphIndex / endGlyphIndex —— 否则导出会用旧索引做错误替换（§25）。
 */
export function stripGlyphRange(
  source: TextSourceBinding | undefined
): TextSourceBinding | undefined {
  if (!source) return undefined;
  const next: TextSourceBinding = { kind: source.kind };
  if (source.blockId !== undefined) next.blockId = source.blockId;
  if (source.lineId !== undefined) next.lineId = source.lineId;
  if (source.lineIdx !== undefined) next.lineIdx = source.lineIdx;
  return next;
}

// ─────────────────────────────────────────────────────────────────────
//  基础构造
// ─────────────────────────────────────────────────────────────────────

export function makeRun(
  text: string,
  style: TextStyle,
  source?: TextSourceBinding
): TextRun {
  const run: TextRun = { id: nextId("run"), text, style };
  if (source !== undefined) run.source = source;
  return run;
}

/** 派生 run：保留原 id/style/blockId 等，但清除 glyph 索引 */
export function deriveRun(run: TextRun, text: string): TextRun {
  return { id: run.id, text, style: run.style, source: stripGlyphRange(run.source) };
}

export function styleEquals(a: TextStyle, b: TextStyle): boolean {
  return (
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.fontWeight === b.fontWeight &&
    a.fontStyle === b.fontStyle &&
    a.color === b.color &&
    a.letterSpacing === b.letterSpacing &&
    a.lineHeight === b.lineHeight &&
    a.sourceFontName === b.sourceFontName
  );
}

/** 保证段落至少有一个 run（可为空串），避免出现无法定位的 TextPosition */
export function ensureNonEmptyRuns(runs: TextRun[], fallbackStyle: TextStyle): TextRun[] {
  if (runs.length > 0) return runs;
  return [makeRun("", fallbackStyle)];
}

function paragraphFallbackStyle(paragraph: Paragraph): TextStyle {
  return paragraph.runs[0]?.style ?? createTextStyle();
}

export function findParagraphIndex(tb: TextBoxObject, paragraphId: string): number {
  return tb.paragraphs.findIndex((p) => p.id === paragraphId);
}

/** 段落内 (runId, offset) → 段落偏移 */
export function paragraphOffsetOf(
  paragraph: Paragraph,
  runId: string,
  offset: number
): number {
  const idx = paragraph.runs.findIndex((r) => r.id === runId);
  if (idx < 0) throw new CommandError("missing-run", `Run "${runId}" 不在该段落中`);
  let n = 0;
  for (let i = 0; i < idx; i++) n += paragraph.runs[i].text.length;
  const len = paragraph.runs[idx].text.length;
  const clamped = Math.min(len, Math.max(0, Math.trunc(Number.isFinite(offset) ? offset : 0)));
  return n + clamped;
}

/** 在 TextBox 内比较两个位置（不依赖 id 字符串排序） */
export function compareInTextBox(tb: TextBoxObject, a: TextPosition, b: TextPosition): number {
  const ai = findParagraphIndex(tb, a.paragraphId);
  const bi = findParagraphIndex(tb, b.paragraphId);
  if (ai < 0 || bi < 0) throw new CommandError("missing-paragraph", "位置不在该 TextBox 内");
  if (ai !== bi) return ai < bi ? -1 : 1;
  const ao = paragraphOffsetOf(tb.paragraphs[ai], a.runId, a.offset);
  const bo = paragraphOffsetOf(tb.paragraphs[bi], b.runId, b.offset);
  if (ao === bo) return 0;
  return ao < bo ? -1 : 1;
}

/** 找到包含该段落的 TextBox */
export function findTextBoxIdByParagraph(
  document: EditorDocument,
  paragraphId: string
): string | null {
  for (const page of document.pages) {
    for (const tb of page.objects) {
      if (!isTextBox(tb)) continue; // F3B-6.24-B3：图片对象无段落
      if (tb.paragraphs.some((p) => p.id === paragraphId)) return tb.id;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
//  文档级应用器（§3 / §4 / §5）
// ─────────────────────────────────────────────────────────────────────

/**
 * 在指定 TextBox 上应用一次变更。
 *
 * - updater 返回 null 或同一引用 → **no-op**：返回原 document，version 不变（§5）
 * - 否则重建 pages 数组并 version + 1（§4）
 */
export function applyToTextBox(
  document: EditorDocument,
  textBoxId: string,
  updater: (tb: TextBoxObject) => TextBoxObject | null
): EditorDocument {
  for (let pi = 0; pi < document.pages.length; pi++) {
    const page = document.pages[pi];
    const oi = page.objects.findIndex((o) => o.id === textBoxId);
    if (oi < 0) continue;
    const prev = page.objects[oi];
    if (prev.type !== "text") continue; // 图片等非文本对象不参与文本框编辑
    const next = updater(prev);
    if (!next || next === prev) return document; // no-op
    const objects = page.objects.slice();
    objects[oi] = next;
    const pages = document.pages.slice();
    pages[pi] = { ...page, objects };
    return bumpVersion({ ...document, pages });
  }
  throw new CommandError("missing-text-box", `TextBox "${textBoxId}" 不存在`);
}

// ─────────────────────────────────────────────────────────────────────
//  插入
// ─────────────────────────────────────────────────────────────────────

/** 单行插入（不含 "\n"）到段落内 */
function insertPlainIntoParagraph(
  paragraph: Paragraph,
  offset: number,
  text: string,
  style: TextStyle
): Paragraph | null {
  if (text === "") return null;
  const total = getParagraphTextLength(paragraph);
  const off = Math.min(total, Math.max(0, Math.trunc(offset)));
  const { runIndex, runOffset } = resolveParagraphOffset(paragraph, off);
  const target = paragraph.runs[runIndex];
  const before = paragraph.runs.slice(0, runIndex);
  const after = paragraph.runs.slice(runIndex + 1);
  const head = target.text.slice(0, runOffset);
  const tail = target.text.slice(runOffset);

  // §8 / §9：插入文字继承所在 run 的 style；style 相同且无 provenance 冲突时
  // 合并回同一 run，避免 "Hello" / "beautiful" / " world" 三碎片。
  // §23：有 source binding 的 run 不合并（合并会破坏 provenance）。
  if (!target.source && styleEquals(target.style, style)) {
    const merged = { ...target, text: head + text + tail };
    return { ...paragraph, runs: ensureNonEmptyRuns([...before, merged, ...after], style) };
  }

  const runs: TextRun[] = [...before];
  if (head) runs.push(deriveRun(target, head));
  runs.push(makeRun(text, style, GENERATED_SOURCE));
  if (tail) runs.push(makeRun(tail, target.style, stripGlyphRange(target.source)));
  runs.push(...after);
  return { ...paragraph, runs: ensureNonEmptyRuns(runs, paragraphFallbackStyle(paragraph)) };
}

/**
 * 插入文本（支持 "\n"，§7）。
 *
 * "\n" 解释为段落拆分，而不是把换行符当作 run 的普通字符。
 */
export function insertIntoTextBox(
  tb: TextBoxObject,
  paragraphId: string,
  offset: number,
  text: string,
  style: TextStyle
): TextBoxObject | null {
  if (text === "") return null;
  const pIdx = findParagraphIndex(tb, paragraphId);
  if (pIdx < 0) throw new CommandError("missing-paragraph", `Paragraph "${paragraphId}" 不存在`);

  const segs = text.split("\n");
  if (segs.length === 1) {
    const next = insertPlainIntoParagraph(tb.paragraphs[pIdx], offset, segs[0], style);
    if (!next) return null;
    const paragraphs = tb.paragraphs.slice();
    paragraphs[pIdx] = next;
    return { ...tb, paragraphs };
  }

  // 多段：首段 = before + head + seg0；中间段 = seg_i；末段 = segLast + tail + after
  const paragraph = tb.paragraphs[pIdx];
  const total = getParagraphTextLength(paragraph);
  const off = Math.min(total, Math.max(0, Math.trunc(offset)));
  const { runIndex, runOffset } = resolveParagraphOffset(paragraph, off);
  const target = paragraph.runs[runIndex];
  const before = paragraph.runs.slice(0, runIndex);
  const after = paragraph.runs.slice(runIndex + 1);
  const head = target.text.slice(0, runOffset);
  const tail = target.text.slice(runOffset);

  const firstRuns: TextRun[] = [...before];
  if (head) firstRuns.push(deriveRun(target, head));
  if (segs[0]) firstRuns.push(makeRun(segs[0], style, GENERATED_SOURCE));

  const lastRuns: TextRun[] = [];
  if (segs[segs.length - 1]) {
    lastRuns.push(makeRun(segs[segs.length - 1], style, GENERATED_SOURCE));
  }
  if (tail) lastRuns.push(makeRun(tail, target.style, stripGlyphRange(target.source)));
  lastRuns.push(...after);

  const fallback = paragraphFallbackStyle(paragraph);
  const first: Paragraph = {
    id: paragraph.id,
    runs: ensureNonEmptyRuns(firstRuns, fallback),
    alignment: paragraph.alignment,
  };
  const middle: Paragraph[] = [];
  for (let i = 1; i < segs.length - 1; i++) {
    middle.push({
      id: nextId("para"),
      runs: ensureNonEmptyRuns([makeRun(segs[i], style, GENERATED_SOURCE)], fallback),
      alignment: paragraph.alignment,
    });
  }
  const last: Paragraph = {
    id: nextId("para"),
    runs: ensureNonEmptyRuns(lastRuns, fallback),
    alignment: paragraph.alignment,
  };

  const paragraphs = tb.paragraphs.slice();
  paragraphs.splice(pIdx, 1, first, ...middle, last);
  return { ...tb, paragraphs };
}

// ─────────────────────────────────────────────────────────────────────
//  删除
// ─────────────────────────────────────────────────────────────────────

/** 删除段落内 [startOffset, endOffset) */
function deleteWithinParagraph(
  paragraph: Paragraph,
  startOffset: number,
  endOffset: number
): Paragraph | null {
  if (startOffset === endOffset) return null;
  const runs: TextRun[] = [];
  let acc = 0;
  let changed = false;
  for (const run of paragraph.runs) {
    const rs = acc;
    const re = acc + run.text.length;
    acc = re;
    const s = Math.max(rs, startOffset);
    const e = Math.min(re, endOffset);
    if (e <= s) {
      runs.push(run); // 未触及 → 共享引用，保留完整 source
      continue;
    }
    const keep = run.text.slice(0, s - rs) + run.text.slice(e - rs);
    if (keep === "") {
      changed = true; // 整 run 删除
      continue;
    }
    changed = true;
    runs.push(deriveRun(run, keep)); // 部分删除 → glyph 索引失效（§25）
  }
  if (!changed) return null;
  return {
    ...paragraph,
    runs: ensureNonEmptyRuns(runs, paragraphFallbackStyle(paragraph)),
  };
}

/**
 * 删除 TextRange（§10–§13）。支持同 run / 跨 run / 跨 paragraph。
 *
 * 跨段落且删除区间包含段落边界 → 执行段落合并（§13）。
 */
export function removeRangeFromTextBox(
  tb: TextBoxObject,
  range: TextRange
): TextBoxObject | null {
  const order = compareInTextBox(tb, range.anchor, range.focus);
  const a = order <= 0 ? range.anchor : range.focus;
  const b = order <= 0 ? range.focus : range.anchor;

  const startIdx = findParagraphIndex(tb, a.paragraphId);
  const endIdx = findParagraphIndex(tb, b.paragraphId);
  if (startIdx < 0 || endIdx < 0) {
    throw new CommandError("missing-paragraph", "删除范围不在该 TextBox 内");
  }

  const startOff = paragraphOffsetOf(tb.paragraphs[startIdx], a.runId, a.offset);
  const endOff = paragraphOffsetOf(tb.paragraphs[endIdx], b.runId, b.offset);

  if (startIdx === endIdx) {
    const next = deleteWithinParagraph(tb.paragraphs[startIdx], startOff, endOff);
    if (!next) return null;
    const paragraphs = tb.paragraphs.slice();
    paragraphs[startIdx] = next;
    return { ...tb, paragraphs };
  }

  const firstP = tb.paragraphs[startIdx];
  const lastP = tb.paragraphs[endIdx];
  const firstRemain =
    deleteWithinParagraph(firstP, startOff, getParagraphTextLength(firstP)) ?? firstP;
  const lastRemain = deleteWithinParagraph(lastP, 0, endOff) ?? lastP;

  const merged: Paragraph = {
    id: firstP.id,
    runs: ensureNonEmptyRuns(
      [...firstRemain.runs, ...lastRemain.runs],
      paragraphFallbackStyle(firstP)
    ),
    alignment: firstP.alignment,
  };
  const paragraphs = tb.paragraphs.slice();
  paragraphs.splice(startIdx, endIdx - startIdx + 1, merged);
  return { ...tb, paragraphs };
}

// ─────────────────────────────────────────────────────────────────────
//  段落拆分 / 合并
// ─────────────────────────────────────────────────────────────────────

/**
 * 在段落偏移处拆分为两个段落（§17–§20）。
 *
 * start / middle / end 三种位置都正确；空段落保留（§18/§19：不偷偷删除）。
 * 两侧 run 的 style 原样保留（§20）。
 */
export function splitParagraphInTextBox(
  tb: TextBoxObject,
  paragraphId: string,
  offset: number
): TextBoxObject | null {
  const pIdx = findParagraphIndex(tb, paragraphId);
  if (pIdx < 0) throw new CommandError("missing-paragraph", `Paragraph "${paragraphId}" 不存在`);
  const paragraph = tb.paragraphs[pIdx];
  const total = getParagraphTextLength(paragraph);
  const off = Math.min(total, Math.max(0, Math.trunc(offset)));
  const { runIndex, runOffset } = resolveParagraphOffset(paragraph, off);
  const target = paragraph.runs[runIndex];
  const before = paragraph.runs.slice(0, runIndex);
  const after = paragraph.runs.slice(runIndex + 1);

  const firstRuns: TextRun[] = [...before];
  const secondRuns: TextRun[] = [];
  if (runOffset === 0) {
    secondRuns.push(target, ...after);
  } else if (runOffset >= target.text.length) {
    firstRuns.push(target);
    secondRuns.push(...after);
  } else {
    firstRuns.push(deriveRun(target, target.text.slice(0, runOffset)));
    secondRuns.push(makeRun(target.text.slice(runOffset), target.style, stripGlyphRange(target.source)), ...after);
  }

  const fallback = paragraphFallbackStyle(paragraph);
  const first: Paragraph = {
    id: paragraph.id,
    runs: ensureNonEmptyRuns(firstRuns, fallback),
    alignment: paragraph.alignment,
  };
  const second: Paragraph = {
    id: nextId("para"),
    runs: ensureNonEmptyRuns(secondRuns, fallback),
    alignment: paragraph.alignment,
  };
  const paragraphs = tb.paragraphs.slice();
  paragraphs.splice(pIdx, 1, first, second);
  return { ...tb, paragraphs };
}

/**
 * 将指定段落与其**前一个**段落合并（§21 / §22）。
 *
 * 段落边界本身不引入空格（§22）：
 *   "Hello" + "world" = "Helloworld"
 *   "Hello " + "world" = "Hello world"
 * 第一个段落无前驱 → no-op（返回 null）。
 * run 不合并且 source 原样保留（§23：合并是优化，不是必须条件；本阶段无文本删除）。
 */
export function mergeParagraphsInTextBox(
  tb: TextBoxObject,
  paragraphId: string
): TextBoxObject | null {
  const idx = findParagraphIndex(tb, paragraphId);
  if (idx < 0) throw new CommandError("missing-paragraph", `Paragraph "${paragraphId}" 不存在`);
  if (idx === 0) return null; // 无前一个段落
  const prev = tb.paragraphs[idx - 1];
  const cur = tb.paragraphs[idx];
  const merged: Paragraph = {
    id: prev.id,
    runs: ensureNonEmptyRuns([...prev.runs, ...cur.runs], paragraphFallbackStyle(prev)),
    alignment: prev.alignment,
  };
  const paragraphs = tb.paragraphs.slice();
  paragraphs.splice(idx - 1, 2, merged);
  return { ...tb, paragraphs };
}

// ─────────────────────────────────────────────────────────────────────
//  样式（§38）
// ─────────────────────────────────────────────────────────────────────

/** 保证 offset 处存在 run 边界（必要时拆分 run） */
function splitRunsAt(runs: TextRun[], offset: number): TextRun[] {
  const out: TextRun[] = [];
  let acc = 0;
  for (const run of runs) {
    const rs = acc;
    const re = acc + run.text.length;
    acc = re;
    if (offset > rs && offset < re) {
      const cut = offset - rs;
      out.push(deriveRun(run, run.text.slice(0, cut)));
      out.push(makeRun(run.text.slice(cut), run.style, stripGlyphRange(run.source)));
    } else {
      out.push(run);
    }
  }
  return out;
}

/** 给段落 [s, e) 区间套用样式（Partial<TextStyle> 合并） */
function applyStyleToParagraph(
  paragraph: Paragraph,
  s: number,
  e: number,
  style: Partial<TextStyle>
): Paragraph | null {
  if (s === e) return null;
  let runs = splitRunsAt(paragraph.runs, s);
  runs = splitRunsAt(runs, e);
  let acc = 0;
  let changed = false;
  const out = runs.map((run) => {
    const rs = acc;
    const re = acc + run.text.length;
    acc = re;
    if (run.text.length > 0 && rs >= s && re <= e) {
      changed = true;
      return { ...run, style: { ...run.style, ...style } };
    }
    return run;
  });
  if (!changed) return null;
  return { ...paragraph, runs: out };
}

/**
 * 设置选区文本样式（§38：最小语义，不含字体替换 / 嵌入 / 解析器 / 导出）。
 */
export function setStyleInTextBox(
  tb: TextBoxObject,
  range: TextRange,
  style: Partial<TextStyle>
): TextBoxObject | null {
  if (Object.keys(style).length === 0) return null;
  const order = compareInTextBox(tb, range.anchor, range.focus);
  const a = order <= 0 ? range.anchor : range.focus;
  const b = order <= 0 ? range.focus : range.anchor;
  const startIdx = findParagraphIndex(tb, a.paragraphId);
  const endIdx = findParagraphIndex(tb, b.paragraphId);
  if (startIdx < 0 || endIdx < 0) {
    throw new CommandError("missing-paragraph", "样式范围不在该 TextBox 内");
  }
  const startOff = paragraphOffsetOf(tb.paragraphs[startIdx], a.runId, a.offset);
  const endOff = paragraphOffsetOf(tb.paragraphs[endIdx], b.runId, b.offset);

  const paragraphs = tb.paragraphs.slice();
  let changed = false;

  if (startIdx === endIdx) {
    const next = applyStyleToParagraph(paragraphs[startIdx], startOff, endOff, style);
    if (next) {
      paragraphs[startIdx] = next;
      changed = true;
    }
  } else {
    const firstNext = applyStyleToParagraph(
      paragraphs[startIdx],
      startOff,
      getParagraphTextLength(paragraphs[startIdx]),
      style
    );
    if (firstNext) {
      paragraphs[startIdx] = firstNext;
      changed = true;
    }
    for (let i = startIdx + 1; i < endIdx; i++) {
      const next = applyStyleToParagraph(
        paragraphs[i],
        0,
        getParagraphTextLength(paragraphs[i]),
        style
      );
      if (next) {
        paragraphs[i] = next;
        changed = true;
      }
    }
    const lastNext = applyStyleToParagraph(paragraphs[endIdx], 0, endOff, style);
    if (lastNext) {
      paragraphs[endIdx] = lastNext;
      changed = true;
    }
  }
  if (!changed) return null;
  return { ...tb, paragraphs };
}
