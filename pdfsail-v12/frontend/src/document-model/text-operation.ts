/**
 * TextOperation Model — M5-IMPLEMENT-004A（ADR-049）
 *
 * 统一 Insert / Delete / Replace 的文本操作契约。
 *
 * 分层原则（ADR-049）：
 *   EditSession = 用户意图（intent / caret / draft）
 *   TextOperation = 语义操作（insert / delete / replace）
 *   Geometry Mutation = 几何实现（glyph create / shift / bbox）—— 004B，本文件不做
 *   Layout Engine = overflow / reflow —— 004C，本文件不做
 *
 * 004A 边界（PM 授权，严格限制）：
 *   ✅ 定义 TextOperation / GlyphRange 类型
 *   ✅ 新增 applyTextOperation(document, operation) 入口
 *   ✅ dispatcher：replace 委托现有 M4 mutateLineText；insert/delete 明确 SAFE TODO
 *   ❌ 不做 bbox 修改 / glyph 创建 / suffix shift / reflow / overflow（004B/004C）
 *
 * 关键：M4 Precise Range 契约（mutateLineText）保持不被污染。
 */
import type { EditableDocument, EditableGlyph, EditableLine, BBox } from "./types";
import { IDENTITY_TRANSFORM } from "./types";
import { mutateLineText, type MutationResult, type OverflowState, type GlyphRange } from "./document-mutation";

export type { OverflowState, GlyphRange } from "./document-mutation";
import { measureCharWidth } from "./text-measurement";
import { computeAvailableLineWidth } from "./layout-engine";
import type { GlyphCaret } from "./edit-session";

/**
 * TextOperation — 判别联合（insert/delete/replace 统一抽象）。
 * blockId + lineId 用于 document 定位行；range / position 为行内 glyph index。
 */
export type TextOperation =
  | {
      type: "insert";
      blockId: string;
      /** 插入点（GlyphCaret 含 lineId + glyphIndex + offset） */
      position: GlyphCaret;
      text: string;
    }
  | {
      type: "replace";
      blockId: string;
      lineId: string;
      range: GlyphRange;
      text: string;
    }
  | {
      type: "delete";
      blockId: string;
      lineId: string;
      range: GlyphRange;
    };

/**
 * applyTextOperation — TextOperation 入口 dispatcher。
 *
 * - "replace" → 委托现有 M4 `mutateLineText`（Precise Range，几何保真，契约冻结）。
 * - "insert" / "delete" → SAFE no-op（M5-IMPLEMENT-004B 前不产生几何 mutation），
 *   返回 mutated:false + 明确 reason，避免静默错误。
 *
 * 本文件不做 geometry mutation（glyph create / suffix shift / bbox / reflow）。
 */
export function applyTextOperation(
  doc: EditableDocument,
  operation: TextOperation
): MutationResult {
  switch (operation.type) {
    case "replace": {
      // TextOperation.replace.text = replacement 片段（如 range[6,6] + text:"X" → 替换 W）。
      // M4 Precise Range 的 mutateLineText 期望"整行新文本"，故先由本层重建 fullLineText，
      // 再委托 M4（仅重建 replacement 区间，prefix/suffix 保持原几何，契约冻结）。
      const lineText = getLineText(doc, operation.blockId, operation.lineId);
      if (lineText === null) return { document: doc, mutated: false, modifiedGlyphIds: [], reason: "line-not-found" };
      const start = Math.max(0, Math.min(operation.range.start, lineText.length));
      const end = Math.max(start, Math.min(operation.range.end, lineText.length - 1));
      const fullLineText =
        Array.from(lineText).slice(0, start).join("") +
        operation.text +
        Array.from(lineText).slice(end + 1).join("");
      const baseResult = mutateLineText(doc, operation.blockId, operation.lineId, fullLineText, { start, end });
      // M6-001A: 捕获 before/after glyph（供 inverse replace 恢复完整 geometry/identity）
      const enriched = enrichReplaceInverse(doc, baseResult, operation.blockId, operation.lineId, start, end);
      return withOverflow(doc, operation.blockId, operation.lineId, enriched);
    }

    case "insert":
      // 004B：operation-based insert（create + shift，非 text reconstruction）。
      //   1. 为 operation.text 逐字符创建新 glyph（继承 anchor styleRef/font/transform）
      //   2. 原 prefix 保持对象，suffix 平移 bbox.x（identity 保留，同对象）
      //   3. 更新行 bbox width
      // 004C：detect only（不 reflow），超宽标记到 result.overflow。
      return withOverflow(doc, operation.blockId, operation.position.lineId,
        applyInsert(doc, operation.blockId, operation.position, operation.text));

    case "delete":
      // 004B：operation-based delete（移除 + suffix 左移）。
      //   1. 删除 range 内 glyph
      //   2. suffix 左移填补空隙（identity 保留，同字段，仅 bbox.x 平移）
      //   3. 更新行 bbox width
      // 004C：detect only（不 reflow）。
      return withOverflow(doc, operation.blockId, operation.lineId,
        applyDelete(doc, operation.blockId, operation.lineId, operation.range));
  }
}

/**
 * M6-001A: 为 replace 结果附加 inverse 数据（beforeGlyphs/afterGlyphs）。
 * beforeGlyphs = 原行 range 内 glyph（完整 identity/geometry）；
 * afterGlyphs = 结果行对应区间 glyph（替换后）。
 * 供 inverse replace 恢复完整 fidelity（非仅 text swap）。
 */
function enrichReplaceInverse(
  doc: EditableDocument,
  result: MutationResult,
  blockId: string,
  lineId: string,
  start: number,
  end: number
): MutationResult {
  if (!result.mutated) return result;
  const beforeLine = doc.pages.flatMap((p) => p.blocks).find((b) => b.id === blockId)?.lines.find((l) => l.id === lineId);
  const afterLine = result.document.pages.flatMap((p) => p.blocks).find((b) => b.id === blockId)?.lines.find((l) => l.id === lineId);
  if (!beforeLine || !afterLine) return result;
  const beforeGlyphs = beforeLine.glyphs.slice(start, end + 1);
  const afterLen = afterLine.glyphs.length;
  const afterStart = Math.min(start, afterLen);
  const afterEnd = Math.min(afterStart + Math.max(0, afterLen - beforeLine.glyphs.length + (end - start + 1)) - 1, afterLen - 1);
  const afterGlyphs = afterLine.glyphs.slice(afterStart, afterEnd + 1);
  return { ...result, inverse: { kind: "replace", beforeGlyphs, afterGlyphs } };
}

/**
 * M5-004C: Overflow Detection（detect only，不改结构、不 reflow）。
 * 检测操作后目标行是否超宽（line width > available width），附加到 MutationResult.overflow。
 * maxWidth = computeAvailableLineWidth（派生：pageWidth - margins，fallback originalBounds.width）。
 */
function withOverflow(
  doc: EditableDocument,
  blockId: string,
  lineId: string,
  result: MutationResult
): MutationResult {
  if (!result.mutated) return result;
  const overflow = detectOverflow(doc, result.document, blockId, lineId);
  if (overflow === null) return result;
  return { ...result, overflow };
}

/** 计算指定行 overflow 状态；找不到 block/line → null。 */
function detectOverflow(
  doc: EditableDocument,
  afterDoc: EditableDocument,
  blockId: string,
  lineId: string
): MutationResult["overflow"] | null {
  const beforeBlock = doc.pages.flatMap((p) => p.blocks).find((b) => b.id === blockId);
  const afterBlock = afterDoc.pages.flatMap((p) => p.blocks).find((b) => b.id === blockId);
  if (!beforeBlock || !afterBlock) return null;
  const afterLine = afterBlock.lines.find((l) => l.id === lineId);
  if (!afterLine) return null;

  // 行实际宽度 = 首 glyph.x 到末 glyph.x+width
  const glyphs = afterLine.glyphs;
  if (glyphs.length === 0) return { overflow: false, width: 0, maxWidth: 0 };
  const width = glyphs[glyphs.length - 1].bbox.x + glyphs[glyphs.length - 1].bbox.width - glyphs[0].bbox.x;

  // available width：用原始 block bounds + 所在 page 宽度派生
  const page = afterDoc.pages.find((p) => p.blocks.some((b) => b.id === blockId));
  const maxWidth = computeAvailableLineWidth(
    beforeBlock.originalBounds,
    page?.width
  );

  return { overflow: width > maxWidth + 0.5, width, maxWidth };
}

/**
 * M5-004B: operation-based Delete（移除 + suffix 左移）。
 * 不做 text reconstruction；suffix 保留 identity（originalChar/transform/styleRef 不变），
 * 仅 bbox.x 左移填补删除空隙。
 */
function applyDelete(
  doc: EditableDocument,
  blockId: string,
  lineId: string,
  range: GlyphRange
): MutationResult {
  const modifiedGlyphIds: string[] = [];
  let mutated = false;
  let found = false;
  let inverseData: MutationResult["inverse"] = undefined;

  const pages = doc.pages.map((page) => ({
    ...page,
    blocks: page.blocks.map((block) => {
      if (block.id !== blockId) return block;
      const lines = block.lines.map((line) => {
        if (line.id !== lineId) return line;
        found = true;

        const glyphs = line.glyphs;
        if (glyphs.length === 0) return line;

        const start = Math.max(0, Math.min(range.start, glyphs.length - 1));
        const end = Math.max(start, Math.min(range.end, glyphs.length - 1));

        // M6-001A: 捕获被删 glyph（含完整 identity/geometry，供 inverse insert 恢复）
        const removedGlyphs = glyphs.slice(start, end + 1);
        // 被删区间总宽（供 suffix 左移）
        const removedWidth = removedGlyphs.reduce((acc, g) => acc + g.bbox.width, 0);
        // 记录被删 glyph id
        removedGlyphs.forEach((g, i) => {
          modifiedGlyphIds.push(`${blockId}__${lineId}__del_${start + i}`);
        });
        inverseData = { kind: "delete", removedGlyphs, removedRange: { start, end } };

        // prefix 保持同对象；suffix 移除并左移（bbox.x -= removedWidth，identity 保留）
        const prefix = glyphs.slice(0, start);
        const suffix = glyphs.slice(end + 1).map((g) => ({
          ...g,
          bbox: { ...g.bbox, x: g.bbox.x - removedWidth },
        }));

        const newGlyphsFull = [...prefix, ...suffix];
        mutated = true;

        // 更新行 bbox width
        let newLineBBox = line.bbox;
        if (newGlyphsFull.length > 0) {
          const last = newGlyphsFull[newGlyphsFull.length - 1];
          const width = last.bbox.x + last.bbox.width - newGlyphsFull[0].bbox.x;
          newLineBBox = { ...line.bbox, width: Math.max(width, 0) };
        } else {
          newLineBBox = { ...line.bbox, width: 0 };
        }

        return { ...line, glyphs: newGlyphsFull, bbox: newLineBBox };
      });
      return { ...block, lines };
    }),
  }));

  if (!found || !mutated) return { document: doc, mutated: false, modifiedGlyphIds: [] };
  return { document: { ...doc, pages }, mutated, modifiedGlyphIds, inverse: inverseData };
}

/** 从 EditableDocument 读取指定行完整文本；找不到 block/line → null。 */
function getLineText(
  doc: EditableDocument,
  blockId: string,
  lineId: string
): string | null {
  const block = doc.pages.flatMap((p) => p.blocks).find((b) => b.id === blockId);
  if (!block) return null;
  const line = block.lines.find((l) => l.id === lineId);
  if (!line) return null;
  return line.glyphs.map((g) => g.char).join("");
}

/**
 * M5-004B: operation-based Insert（create + shift）。
 *
 * 关键：不做 text reconstruction（复用 mapNewTextToOriginalGlyphs 会重新映射所有 glyph → identity loss）。
 * 这里：
 *   - prefix glyph 保持同对象
 *   - 新 glyph 逐字符创建（继承 anchor 的 styleRef/font/transform）
 *   - suffix glyph 平移 bbox.x（同对象，identity 保留），而非重建
 *   - 更新行 bbox width
 */
function applyInsert(
  doc: EditableDocument,
  blockId: string,
  position: GlyphCaret,
  text: string
): MutationResult {
  const modifiedGlyphIds: string[] = [];
  const newText = Array.from(text);
  if (newText.length === 0) return { document: doc, mutated: false, modifiedGlyphIds: [] };

  let mutated = false;
  let newLineBBox: BBox | null = null;
  let found = false;
  let inverseData: MutationResult["inverse"] = undefined;

  const pages = doc.pages.map((page) => ({
    ...page,
    blocks: page.blocks.map((block) => {
      if (block.id !== blockId) return block;
      const lines = block.lines.map((line) => {
        if (line.id !== position.lineId) return line;
        found = true;

        const glyphs = line.glyphs;
        if (glyphs.length === 0) return line; // 空行 insert 留待 004B 边界外（当前 SAFE）

        // 插入位置（字符偏移）：offset after → index+1；before → index
        const rawInsert = position.offset === "after" ? position.glyphIndex + 1 : position.glyphIndex;
        const insertPos = Math.max(0, Math.min(rawInsert, glyphs.length));

        // anchor glyph：优先插入点前一个（或第 0 个）用于继承样式
        const anchor = glyphs[Math.min(insertPos, glyphs.length - 1)] ?? glyphs[glyphs.length - 1];
        const styleRef = anchor.styleRef;
        const lineHeight = anchor.bbox.height;
        const lineY = anchor.bbox.y;
        const transform = anchor.transform ?? IDENTITY_TRANSFORM;

        // 为插入文本逐字符创建新 glyph，并测量累计宽度
        let currentX = insertPos > 0 ? glyphs[insertPos - 1].bbox.x + glyphs[insertPos - 1].bbox.width : (anchor.bbox.x - measureCharWidth(Array.from(text)[0] ?? " ", line.style));
        const newGlyphs: EditableGlyph[] = [];
        let insertW = 0;
        newText.forEach((ch) => {
          const w = measureCharWidth(ch, line.style);
          newGlyphs.push({
            char: ch,
            originalChar: ch,
            bbox: { x: currentX, y: lineY, width: w, height: lineHeight },
            originalBBox: { x: currentX, y: lineY, width: w, height: lineHeight },
            styleRef,
            modified: true,
            transform,
          });
          modifiedGlyphIds.push(`${blockId}__${position.lineId}__ins_${ch}_${currentX}`);
          currentX += w;
          insertW += w;
        });

        // 新行 glyph 数组 = prefix(同对象) + 新 glyph + suffix(平移，同对象)
        // suffix 平移：bbox.x += insertW（identity 保留，仅坐标右移，不重建）
        const prefix = glyphs.slice(0, insertPos);
        const suffix = glyphs.slice(insertPos).map((g) => ({
          ...g,
          bbox: { ...g.bbox, x: g.bbox.x + insertW },
        }));

        const newGlyphsFull = [...prefix, ...newGlyphs, ...suffix];
        mutated = true;

        // M6-001A: 捕获创建的 glyph + 插入区间（供 inverse delete 精确定位）
        inverseData = {
          kind: "insert",
          createdGlyphs: newGlyphs,
          insertedRange: { start: insertPos, end: insertPos + newGlyphs.length - 1 },
        };

        // 更新行 bbox width
        const last = newGlyphsFull[newGlyphsFull.length - 1];
        const lineWidth = last ? last.bbox.x + last.bbox.width - newGlyphsFull[0].bbox.x : line.bbox.width;
        newLineBBox = { ...line.bbox, width: Math.max(lineWidth, line.bbox.width) };

        return { ...line, glyphs: newGlyphsFull, bbox: newLineBBox ?? line.bbox };
      });
      return { ...block, lines };
    }),
  }));

  if (!found || !mutated) {
    return { document: doc, mutated: false, modifiedGlyphIds: [] };
  }
  return { document: { ...doc, pages }, mutated, modifiedGlyphIds, inverse: inverseData };
}
