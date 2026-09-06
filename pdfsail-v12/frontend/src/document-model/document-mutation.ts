/**
 * Document Mutation — Sprint 6 Task 3
 *
 * 编辑流程：
 *   User Input → EditableDocument update → RenderCommand regenerate → GlyphRenderer update
 *
 * 禁止直接修改 DOM。所有编辑通过 Document Mutation API 更新 EditableDocument，
 * 然后 React 重新渲染 GlyphRenderer（commands 变化触发）。
 *
 * 核心 API：
 *   - mutateGlyphChar(doc, glyphId, newChar) — 修改单个字符
 *   - mutateLineText(doc, blockId, lineId, newText) — 修改整行文本
 *   - mutateFindAndReplace(doc, oldText, newText) — 查找替换
 *
 * 修改后返回新的 EditableDocument（不可变更新），
 * 调用方负责 setEditableDocument + 重新生成 RenderCommand。
 */

import type {
  EditableDocument,
  EditableBlock,
  EditableLine,
  EditableGlyph,
  EditableStyle,
  BBox,
} from "./types";
import { mapNewTextToOriginalGlyphs } from "./glyph-mapping";
import { measureCharWidth } from "./text-measurement";

/** 行内 glyph 区间（含 end），identity = 位置性（line.glyphs index）。M5-004A 定义于此避免循环依赖。 */
export interface GlyphRange {
  readonly start: number;
  readonly end: number;
}

/** Mutation 结果 */
export interface MutationResult {
  /** 更新后的文档 */
  document: EditableDocument;
  /** 是否实际发生了修改 */
  mutated: boolean;
  /** 被修改的 glyph ID 列表 */
  modifiedGlyphIds: string[];
  /** M5-004A: 可选原因说明（如 SAFE no-op / TODO 边界），非必需，向后兼容 */
  reason?: string;
  /** M5-004C: 可选 overflow 检测状态（detect only，不改结构）。未检测/无溢出时缺省。 */
  overflow?: OverflowState;
  /** M6-001A: 可选 inverse 数据（供 Undo 恢复完整 operation 状态）。缺省 = 该 operation 不可逆。 */
  inverse?: InverseData;
}

/**
 * M6-001A: Inverse Operation Data（ADR-052）。
 * 记录 operation 的 before/after glyph 状态，供 Undo 精确恢复
 * （Document equality + Glyph identity + Geometry，非仅 text）。
 */
export type InverseData =
  | { kind: "insert"; createdGlyphs: EditableGlyph[]; insertedRange: GlyphRange }
  | { kind: "delete"; removedGlyphs: EditableGlyph[]; removedRange: GlyphRange }
  | { kind: "replace"; beforeGlyphs: EditableGlyph[]; afterGlyphs: EditableGlyph[] };

/**
 * M5-004C: Overflow Detection 状态（detect only，不触发 reflow）。
 * overflow=true 表示行宽超过可用宽度，后续由 Reflow 阶段处理（004D/004E）。
 */
export interface OverflowState {
  overflow: boolean;
  width: number;     // 当前行实际宽度
  maxWidth: number;  // 可用宽度（computeAvailableLineWidth）
}

/**
 * 修改单个 glyph 的字符
 *
 * 场景：用户点击某个字符，直接替换为另一个字符
 *
 * @param doc 当前文档
 * @param blockId 目标 block ID
 * @param lineId 目标行 ID
 * @param glyphIndex glyph 在行内的索引
 * @param newChar 新字符
 * @returns MutationResult
 */
export function mutateGlyphChar(
  doc: EditableDocument,
  blockId: string,
  lineId: string,
  glyphIndex: number,
  newChar: string
): MutationResult {
  let mutated = false;
  const modifiedGlyphIds: string[] = [];

  const pages = doc.pages.map((page) => ({
    ...page,
    blocks: page.blocks.map((block) => {
      if (block.id !== blockId) return block;

      const lines = block.lines.map((line) => {
        if (line.id !== lineId) return line;

        const glyphs = line.glyphs.map((g, i) => {
          if (i !== glyphIndex) return g;
          if (g.char === newChar) return g;

          mutated = true;
          const glyphId = `${blockId}__${lineId}__${glyphIndex}`;
          modifiedGlyphIds.push(glyphId);

          // 保持原 glyph 宽度，避免用 CSS fallback 字体重测导致整行漂移。
          // 用户要求「保持原文大小，不要缩放字体」。
          const newWidth = g.bbox?.width ?? g.metrics?.advanceWidth ?? measureCharWidth(newChar, doc.styles[g.styleRef] || {});

          return {
            ...g,
            char: newChar,
            modified: true,
            bbox: {
              ...g.bbox,
              width: newWidth,
            },
            // originalBBox 保持不变
          };
        });

        return { ...line, glyphs };
      });

      return { ...block, lines };
    }),
  }));

  return {
    document: { ...doc, pages },
    mutated,
    modifiedGlyphIds,
  };
}

/**
 * 修改整行文本
 *
 * 场景：用户编辑某行文本（如 JENNIFER → MARIA）
 * 使用 mapNewTextToOriginalGlyphs 保持原始位置锚定
 *
 * @param doc 当前文档
 * @param blockId 目标 block ID
 * @param lineId 目标行 ID
 * @param newText 新文本
 * @returns MutationResult
 */
export function mutateLineText(
  doc: EditableDocument,
  blockId: string,
  lineId: string,
  newText: string,
  range?: { start: number; end: number }
): MutationResult {
  let mutated = false;
  const modifiedGlyphIds: string[] = [];

  const pages = doc.pages.map((page) => ({
    ...page,
    blocks: page.blocks.map((block) => {
      if (block.id !== blockId) return block;

      const lines = block.lines.map((line) => {
        if (line.id !== lineId) return line;

        // 检查是否有变化
        const oldText = line.glyphs.map((g) => g.char).join("");
        if (oldText === newText) return line;

        mutated = true;

        // M4-FIX-005: 传入 range（原选区 glyph 区间），使未选中 prefix/suffix 保持原几何，
        //            仅 replacement 区间重建，避免"整行按新 index 重新锚定"导致的几何漂移。
        // M7.7-010B: styleRef 不再由 mutateLineText 决定。mapNewTextToOriginalGlyphs 内部
        // 使用原始位置 glyph 的 styleRef（字符级继承）。此处仅提供 fallback styleRef
        // （第一个 glyph 的 styleRef），仅当 replacement 比原选区长时使用。
        const fallbackStyleRef = line.glyphs[0]?.styleRef ?? 0;
        const style = line.style || doc.styles[fallbackStyleRef] || {};
        const mapResult = mapNewTextToOriginalGlyphs(
          line.glyphs,
          newText,
          style,
          fallbackStyleRef,
          range
        );
        const { newGlyphs } = mapResult;

        // M7.7-010.7: 带 baseline 数据的 glyph 几何审计
        const origFirst = line.glyphs[0];
        const origLast = line.glyphs[line.glyphs.length - 1];
        const newFirst = newGlyphs[0];
        const newLast = newGlyphs[newGlyphs.length - 1];
        const origLineBbox = {
          minX: Math.min(...line.glyphs.map(g => g.bbox.x)),
          minY: Math.min(...line.glyphs.map(g => g.bbox.y)),
          maxX: Math.max(...line.glyphs.map(g => g.bbox.x + g.bbox.width)),
          maxY: Math.max(...line.glyphs.map(g => g.bbox.y + g.bbox.height)),
        };
        const newLineBbox = {
          minX: Math.min(...newGlyphs.map(g => g.bbox.x)),
          minY: Math.min(...newGlyphs.map(g => g.bbox.y)),
          maxX: Math.max(...newGlyphs.map(g => g.bbox.x + g.bbox.width)),
          maxY: Math.max(...newGlyphs.map(g => g.bbox.y + g.bbox.height)),
        };
        const origStyleRefs = new Set(line.glyphs.map(g => g.styleRef));
        const newStyleRefs = new Set(newGlyphs.map(g => g.styleRef));
        // M7.7-010.8: baseline 审计
        const origLinesWithBaseline = line.glyphs.filter(g => g.baseline !== undefined).length;
        const newLinesWithBaseline = newGlyphs.filter(g => g.baseline !== undefined).length;
        const origFirstBl = origFirst?.baseline;
        const newFirstBl = newFirst?.baseline;
        const lineBaseline = line.baseline; // 行级 baseline（Original Fact）
        // console.log("[M7.7-010.7][GLYPH_GEOMETRY]", {
        //   lineId,
        //   glyphCount: `${line.glyphs.length} → ${newGlyphs.length}`,
        //   origFirst: origFirst ? { char: origFirst.char, x: Math.round(origFirst.bbox.x * 10) / 10, y: Math.round(origFirst.bbox.y * 10) / 10, w: Math.round(origFirst.bbox.width * 10) / 10, h: Math.round(origFirst.bbox.height * 10) / 10, styleRef: origFirst.styleRef, baseline: origFirst.baseline } : null,
        //   origLast: origLast ? { char: origLast.char, x: Math.round(origLast.bbox.x * 10) / 10, y: Math.round(origLast.bbox.y * 10) / 10, w: Math.round(origLast.bbox.width * 10) / 10, h: Math.round(origLast.bbox.height * 10) / 10, styleRef: origLast.styleRef, baseline: origLast.baseline } : null,
        //   newFirst: newFirst ? { char: newFirst.char, x: Math.round(newFirst.bbox.x * 10) / 10, y: Math.round(newFirst.bbox.y * 10) / 10, w: Math.round(newFirst.bbox.width * 10) / 10, h: Math.round(newFirst.bbox.height * 10) / 10, styleRef: newFirst.styleRef, baseline: newFirst.baseline } : null,
        //   newLast: newLast ? { char: newLast.char, x: Math.round(newLast.bbox.x * 10) / 10, y: Math.round(newLast.bbox.y * 10) / 10, w: Math.round(newLast.bbox.width * 10) / 10, h: Math.round(newLast.bbox.height * 10) / 10, styleRef: newLast.styleRef, baseline: newLast.baseline } : null,
        //   origLineBbox: { y: Math.round(origLineBbox.minY * 10) / 10, h: Math.round((origLineBbox.maxY - origLineBbox.minY) * 10) / 10 },
        //   newLineBbox: { y: Math.round(newLineBbox.minY * 10) / 10, h: Math.round((newLineBbox.maxY - newLineBbox.minY) * 10) / 10 },
        //   origStyleRefs: [...origStyleRefs].join(","),
        //   newStyleRefs: [...newStyleRefs].join(","),
        //   baseline: {
        //     lineBaseline: lineBaseline,
        //     origGlyphsWithBaseline: `${origLinesWithBaseline}/${line.glyphs.length}`,
        //     newGlyphsWithBaseline: `${newLinesWithBaseline}/${newGlyphs.length}`,
        //     origFirstBaseline: origFirstBl,
        //     newFirstBaseline: newFirstBl,
        //   },
        //   range: range ? range : null,
        // });

        // 记录修改的 glyph ID
        newGlyphs.forEach((g, i) => {
          if (g.modified) {
            modifiedGlyphIds.push(`${blockId}__${lineId}__${i}`);
          }
        });

        // M7.8-FIX：记录「被替换子串」的原始文本 bbox（CSS 显示坐标）。
        // 导出兜底 mask 用它覆盖旧文本位置：当该行的原 PDF 文本算子既无法被剥离
        // （provenance 缺失）也无法被 native replay 原位替换（字体子集缺口）时，旧文字
        // 会残留在 content stream 中；此时逐字形 mask 只覆盖新文本位置，可能漏掉旧文本。
        // 此处精确记录被替换范围的原始位置，避免盖到列间竖线（只用子串原始宽度）。
        // 用数组累加：表格多列编辑会按 segment 多次调用本函数，每次只覆盖本段子串的原始
        // bbox；若用单值会被后段覆盖，导致前段被替换子串的原始位置丢失、旧文字残留成重影。
        let newEditedRect: BBox | undefined;
        const rs = range?.start ?? 0;
        const re = range?.end ?? line.glyphs.length;
        const replacedGlyphs = line.glyphs.slice(rs, re);
        if (replacedGlyphs.length > 0) {
          const xs = replacedGlyphs.flatMap((g) => (g.bbox ? [g.bbox.x, g.bbox.x + g.bbox.width] : []));
          const ys = replacedGlyphs.flatMap((g) => (g.bbox ? [g.bbox.y, g.bbox.y + g.bbox.height] : []));
          if (xs.length > 0) {
            newEditedRect = {
              x: Math.min(...xs),
              y: Math.min(...ys),
              width: Math.max(...xs) - Math.min(...xs),
              height: Math.max(...ys) - Math.min(...ys),
            };
          }
        }
        // 累加进已有列表（前序 segment 已记录的被替换子串原始位置），无则新建。
        const editedOriginalBounds: BBox[] | undefined =
          newEditedRect ? [...(line.editedOriginalBounds ?? []), newEditedRect] : line.editedOriginalBounds;

        // M7.8-042-ORPHAN：新文本比原选区短时，mapNewTextToOriginalGlyphs 会丢弃尾部原 glyph，
        // 其 operatorId 随 glyph 消失 → 导出 strip 按 glyph.operatorId 收集不到 → 原算子残留成重影
        // （实测 "100%"→"99%" 导出残留孤立 "%"）。此处把孤儿算子累加合并到行上，供导出剥离。
        const { droppedOperatorIds } = mapResult;
        const mergedDropped =
          droppedOperatorIds && droppedOperatorIds.length > 0
            ? [...(line.droppedOperatorIds ?? []), ...droppedOperatorIds].filter(
                (id, i, arr) => arr.indexOf(id) === i,
              )
            : line.droppedOperatorIds;

        return { ...line, glyphs: newGlyphs, editedOriginalBounds, droppedOperatorIds: mergedDropped };
      });

      return { ...block, lines };
    }),
  }));

  return {
    document: { ...doc, pages },
    mutated,
    modifiedGlyphIds,
  };
}

/**
 * 查找替换
 *
 * 场景：用户输入 "JENNIFER" → "MARIA"
 * 自动找到包含 oldText 的行并替换
 *
 * @param doc 当前文档
 * @param oldText 要查找的原文
 * @param newText 要替换的新文本
 * @returns MutationResult
 */
export function mutateFindAndReplace(
  doc: EditableDocument,
  oldText: string,
  newText: string
): MutationResult {
  let result: MutationResult = { document: doc, mutated: false, modifiedGlyphIds: [] };

  // 遍历所有 page/block/line，找到包含 oldText 的行
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      for (let lineIdx = 0; lineIdx < block.lines.length; lineIdx++) {
        const line = block.lines[lineIdx];
        const lineText = line.glyphs.map((g) => g.char).join("");
        if (lineText.includes(oldText)) {
          const replacedText = lineText.replace(oldText, newText);
          const mutation = mutateLineText(
            result.document,
            block.id,
            line.id,
            replacedText
          );
          if (mutation.mutated) {
            result = mutation;
          }
        }
      }
    }
  }

  return result;
}

/**
 * 根据 GlyphHitRecord 修改字符
 *
 * 便捷方法：从 GlyphHitMap 的命中记录直接修改
 *
 * @param doc 当前文档
 * @param hit GlyphHitRecord
 * @param newChar 新字符
 * @returns MutationResult
 */
export function mutateByHit(
  doc: EditableDocument,
  hit: {
    blockId: string;
    lineId: string;
    command: { styleRef: number };
  },
  newText: string
): MutationResult {
  // 把整个行的文本替换（hit 对应的行）
  // 找到 block 和 line
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.id !== hit.blockId) continue;
      for (const line of block.lines) {
        if (line.id !== hit.lineId) continue;

        // 保留行内其他字符，只替换选中部分
        // 简化：用 mutateLineText 替换整行
        // 实际场景中用户会编辑整行文本
        return mutateLineText(doc, hit.blockId, hit.lineId, newText);
      }
    }
  }

  return { document: doc, mutated: false, modifiedGlyphIds: [] };
}
