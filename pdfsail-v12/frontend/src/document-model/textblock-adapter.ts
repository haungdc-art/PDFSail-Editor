/**
 * TextBlock Compatibility Adapter — EditableDocument → editor TextBlock[]
 *
 * Sprint 1 要求：现有 PDFCanvas / EditableTextNode / Export 无需修改。
 *
 * 本 Adapter 把 EditableDocument 转换为编辑器层已有的 Block[] 类型，
 * 保证渲染/导出管线零摩擦接入。
 *
 * 转换规则：
 *   - 每个 EditableBlock → 一个 editor TextBlock
 *   - bbox 直接映射（已是 CSS 显示坐标）
 *   - text = lines 中所有 glyph.char 拼接（按行用 \n 连接）
 *   - fontSize / fontFamily / color 从 line.style 提取
 *   - originalBounds 直接传递（OCR 替换模式用）
 *
 * 注意：本 Adapter 是「单向 + 有损」的——
 *   EditableDocument → TextBlock 会丢失 glyph 级信息（originalChar/modified）。
 *   这是有意为之：TextBlock 是显示对象，不需要文档理解信息。
 *   文档理解信息保留在 EditableDocument 中，由 AI Agent / 差异检测使用。
 */

import type { Block, TextBlock } from "../editor/types";
import type { EditableDocument, EditableBlock, EditableLine } from "./types";

/**
 * 把单个 EditableBlock 转换为 editor TextBlock。
 *
 * 文本拼接：lines 按顺序用 \n 连接，每行的 glyphs.char 直接拼接。
 * 字体属性：取第一行的 style（多数情况同行同字体）。
 *
 * Sprint 3 更新：
 *   - bbox 使用 block.bbox（已由 Layout Engine 重建，确保原文不露出）
 *   - originalBounds 使用 block.originalBounds（遮盖区域，已确保完整覆盖）
 *   - fontSize 从 style 固定，不缩小
 */
export function editableBlockToTextBlock(block: EditableBlock): TextBlock {
  // 拼接文本（保留换行）
  const text = block.lines
    .map((line) => line.glyphs.map((g) => g.char).join(""))
    .join("\n");

  // 取第一行样式（fallback 到空对象）
  const firstLine: EditableLine | undefined = block.lines[0];
  const style = firstLine?.style || {};

  return {
    id: block.id,
    type: "text",
    page: 0, // page 由 convertEditableDocumentToBlocks 按页填充
    // Sprint 3：使用 block.bbox（Layout Engine 重建后，高度已确保原文不露出）
    x: block.bbox.x,
    y: block.bbox.y,
    w: block.bbox.width,
    h: block.bbox.height,
    text,
    // Sprint 3：fontSize 从 style 固定，禁止自动缩小
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
    color: style.color,
    originalBounds: block.originalBounds
      ? {
          x: block.originalBounds.x,
          y: block.originalBounds.y,
          w: block.originalBounds.width,
          h: block.originalBounds.height,
        }
      : undefined,
  };
}

/**
 * 把 EditableDocument 的某一页转换为 editor Block[]。
 *
 * @param doc EditableDocument
 * @param pageIndex 页码（1-based）。若不传，转换所有页。
 * @returns Block[]（当前只产出 TextBlock，image/table 暂时跳过）
 */
export function convertToTextBlocks(
  doc: EditableDocument,
  pageIndex?: number
): Block[] {
  const blocks: Block[] = [];

  for (const page of doc.pages) {
    if (pageIndex !== undefined && page.index !== pageIndex) continue;

    for (const block of page.blocks) {
      if (block.type !== "text") continue; // Sprint 1 只处理 text

      const tb = editableBlockToTextBlock(block);
      tb.page = page.index;
      blocks.push(tb);
    }
  }

  return blocks;
}

/**
 * 把 EditableDocument 所有页转换为 Block[]（便捷方法）。
 */
export function convertEditableDocumentToBlocks(doc: EditableDocument): Block[] {
  return convertToTextBlocks(doc);
}
