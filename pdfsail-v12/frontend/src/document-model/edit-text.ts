/**
 * EditText — Sprint40B（Edit Text Feature 层）
 *
 * Edit Fidelity 的编辑操作。Edit 属于 Feature（Edit Text），不在冻结的
 * Import/Export/Runner/Comparator 范围内。
 *
 *   Original PDF → parsePdfToEditableDocument → EditableDocument
 *        ↓
 *   EditText 操作（改字符/改字体/移动）→ EditableDocument（modified）
 *        ↓
 *   exportEditableDocument → PDF
 *
 * 【与 Comparator 的关系】Edit 后导出的文本，只有"被编辑部分"与原文不同，
 * 其余必须完全一致。Comparator 用于验证"除预期编辑外无意外差异"。
 */

import type { EditableDocument } from "./types";

/** 编辑操作结果 */
export interface EditResult {
  /** 被编辑的 glyph 数 */
  editedGlyphCount: number;
  /** 是否发生任何编辑 */
  changed: boolean;
}

/**
 * 替换文本（按字符串匹配，替换首个出现）。
 *
 * 在 EditableDocument 中查找 target 文本序列，替换为 replacement。
 * 被替换的 glyph 标记 modified=true。
 *
 * 【健壮性】pdf.js 可能把整词作为一个 glyph（char="Hello World"），也可能逐字符。
 * 本函数同时支持：
 *   - target 完整落在单个 glyph.char 内 → 直接替换该 glyph 的 char 子串。
 *   - target 跨越多个 glyph → 按逐字符替换（不足用空格填充）。
 *
 * @param doc EditableDocument（会被修改）
 * @param target 要替换的原文
 * @param replacement 替换文本
 * @returns 编辑结果
 */
export function replaceText(
  doc: EditableDocument,
  target: string,
  replacement: string,
): EditResult {
  let editedGlyphCount = 0;

  for (const page of doc.pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        // 情况 1：target 完整落在单个 glyph.char 内（如整词 glyph char="Hello World"）
        let handledInGlyph = false;
        for (const glyph of line.glyphs) {
          if (glyph.char.includes(target)) {
            if (glyph.originalChar === undefined) glyph.originalChar = glyph.char;
            glyph.char = glyph.char.replace(target, replacement);
            glyph.modified = true;
            editedGlyphCount += target.length;
            handledInGlyph = true;
          }
        }
        if (handledInGlyph) continue;

        // 情况 2：target 跨越多个 glyph（逐字符 glyph）
        const text = line.glyphs.map((g) => g.char).join("");
        const idx = text.indexOf(target);
        if (idx === -1) continue;

        const replaced = replacement.split("");
        for (let i = 0; i < target.length; i++) {
          const glyph = line.glyphs[idx + i];
          if (!glyph) continue;
          if (glyph.originalChar === undefined) glyph.originalChar = glyph.char;
          glyph.char = replaced[i] ?? " ";
          glyph.modified = true;
          editedGlyphCount++;
        }
      }
    }
  }

  return { editedGlyphCount, changed: editedGlyphCount > 0 };
}
