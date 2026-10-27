/**
 * editor/legacy/ocr-adapter.ts — EDITOR-CORE-005
 *
 *   ocr/ocr-storage OcrTextBlock[]  →  EditorDocument
 *
 * ── 坐标系（§19）──────────────────────────────────────────────────
 * OcrTextBlock 的 x/y/w/h 位于「OCR canvas 像素空间（scale=1.5）」
 * （见 document-model/ocr-adapter.ts 头部注释）。本 adapter 通过调用方传入的
 * `cssScale`（= canvas.clientWidth / canvas.width）一次性换到 CSS 显示坐标，
 * 与既有 `ocrBlocksToEditablePage` 的换算方式完全一致 —— **不引入新坐标系**，
 * 也不在此做第二次缩放。
 *
 * ── 映射策略 ────────────────────────────────────────────────────────
 * 按 OcrTextBlock.page 分组 → 每个 page 一个 EditorPage；
 * 每个 OcrTextBlock → 一个 TextBox；text 内的 "\n" 切成多个 Paragraph。
 *
 * ── provenance ──────────────────────────────────────────────────────
 * kind = "ocr"；blockId = OcrTextBlock.id（OCR 侧的稳定 ID，不是 PDF block id）。
 * OCR 结果**没有** PDF glyph 索引，因此不写 startGlyphIndex/endGlyphIndex，
 * 也绝不冒充 pdf-native（§24）。
 */

import type { OcrTextBlock } from "../../ocr/ocr-storage";
import type { TextSourceBinding } from "../core/document/types";
import {
  materializeImport,
  splitParagraphs,
  toTextStyle,
  type ImportBoxDraft,
  type ImportOptions,
  type ImportResult,
} from "./common";

export interface OcrImportOptions extends ImportOptions {
  /**
   * canvas.clientWidth / canvas.width。
   * OCR 坐标是 canvas 像素（scale=1.5 空间），乘以此系数得到 CSS 显示坐标。
   * 缺省 1（不做缩放）。
   */
  cssScale?: number;
}

export function ocrBlocksToEditorDocument(
  blocks: OcrTextBlock[],
  options: OcrImportOptions = {}
): ImportResult {
  const warnings: string[] = [];
  const cssScale = options.cssScale ?? 1;

  const byPage = new Map<number, OcrTextBlock[]>();
  for (const block of blocks) {
    const page = Number.isFinite(block.page) ? block.page : 1;
    const list = byPage.get(page);
    if (list) list.push(block);
    else byPage.set(page, [block]);
  }

  let rotated = 0;

  const pages = [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pageIndex, pageBlocks]) => {
      const boxes: ImportBoxDraft[] = pageBlocks.map((block) => {
        const source: TextSourceBinding = { kind: "ocr", blockId: block.id };
        const rotation = block.geometry?.angle ?? 0;
        if (rotation !== 0) rotated += 1;

        const style = toTextStyle(
          {
            fontSize: (block.fontSize ?? 12) * cssScale,
            lineHeight: 1.3,
            lineHeightIsRatio: true,
          },
          options
        );

        return {
          x: block.x * cssScale,
          y: block.y * cssScale,
          width: block.w * cssScale,
          height: block.h * cssScale,
          rotation,
          source,
          paragraphs: splitParagraphs(block.text ?? "").map((text) => ({
            runs: [{ text, style, source }],
          })),
        };
      });

      return {
        index: pageIndex,
        width: options.pageWidth ?? 0,
        height: options.pageHeight ?? 0,
        boxes,
      };
    });

  warnings.push(
    `OCR 坐标按 cssScale=${cssScale} 换算到 CSS 显示坐标（与既有 ocrBlocksToEditablePage 同一约定）`
  );
  warnings.push("OCR 结果无 PDF glyph 索引 → run.source 只带 kind=ocr + OCR blockId（不冒充 pdf-native）");
  if (rotated > 0) {
    warnings.push(`${rotated} 个 OCR block 带旋转角，已写入 TextBox.rotation`);
  }
  warnings.push("未建模字段（显式丢弃）：label/regionType/layoutMode 决策、transform 矩阵的非旋转分量");

  return materializeImport(pages, options, warnings);
}
