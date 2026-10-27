/**
 * editor/legacy/segment-adapter.ts — EDITOR-CORE-005
 *
 *   editor-engine Segment[]  →  EditorDocument
 *
 * ── 映射策略 ────────────────────────────────────────────────────────
 * Segment 是"PDF 一行的可编辑切片"（按标点切割 / 表格按列切割）。
 * 现行编辑链路的可编辑单位就是 **一个 Segment = 一个编辑框**，因此本 adapter
 * 保持 1:1：一个 Segment → 一个 TextBox（单段落、单 Run）。
 *
 *   这样做的好处：Segment.source 的 glyph 区间可以原样、无歧义地落到 run.source，
 *   不需要任何字符级重算（避免伪造 provenance，§24）。
 *
 * ── 坐标系（§19）──────────────────────────────────────────────────
 * Segment 的 cssX/cssY/cssW/cssH 已是 CSS 显示坐标（px，左上原点），
 * 直接作为 Page Canvas Space 使用，本层不做任何变换。
 *
 * ── glyph 索引归属（V7）────────────────────────────────────────────
 * Segment.source.{blockId, lineId, lineIdx, startGlyphIndex, endGlyphIndex}
 *   → TextRun.source（TextSourceBinding，provenance）
 * 绝不进入 TextPosition / TextRange / Caret / Selection。
 *
 * ── 未建模字段（显式记录，不静默丢弃）──────────────────────────────
 * hz（PDF Tz 水平缩放）、cssBaseline、fontResolution、isTableCell、originalText
 * 暂不在 Editor Core 建模；其中 originalText / isTableCell 影响 export 语义，
 * 通过 ImportResult.warnings 明确提示（§65 保真要求：不静默降级）。
 */

import type { Segment } from "../../editor-engine/types";
import type { ParagraphAlignment, TextSourceBinding } from "../core/document/types";
import {
  materializeImport,
  splitParagraphs,
  toTextStyle,
  type ImportBoxDraft,
  type ImportOptions,
  type ImportResult,
} from "./common";

/** Segment.textAlign 的取值与 ParagraphAlignment 一致，仅做收窄 */
function toAlignment(value: Segment["textAlign"]): ParagraphAlignment {
  return value === "right" || value === "justify" ? value : "left";
}

export function segmentsToEditorDocument(
  segments: Segment[],
  options: ImportOptions = {}
): ImportResult {
  const warnings: string[] = [];
  const boxes: ImportBoxDraft[] = [];

  let withoutProvenance = 0;
  let withGlyphRange = 0;
  let tableCells = 0;

  for (const seg of segments) {
    const runSource: TextSourceBinding | undefined = seg.source
      ? {
          kind: "pdf-native",
          blockId: seg.source.blockId,
          lineId: seg.source.lineId,
          lineIdx: seg.source.lineIdx,
          startGlyphIndex: seg.source.startGlyphIndex,
          endGlyphIndex: seg.source.endGlyphIndex,
        }
      : undefined;

    if (runSource) {
      withGlyphRange += 1;
    } else {
      withoutProvenance += 1;
    }
    if (seg.isTableCell) tableCells += 1;

    // 对象级 source 只承载 blockId（对象来自哪个 PDF block）；glyph 区间在 run 上
    const boxSource: TextSourceBinding | undefined = seg.source
      ? { kind: "pdf-native", blockId: seg.source.blockId }
      : undefined;

    const style = toTextStyle(
      {
        fontFamily: seg.font?.family,
        fontSize: seg.font?.size,
        fontWeight: seg.font?.weight,
        fontStyle: seg.font?.style,
        color: seg.font?.color,
        // FontMeta.lineHeight 是「行高 ÷ 字号」的倍数（见 SegmentBuilder: font.lineHeight = css.h / font.size）
        lineHeight: seg.font?.lineHeight,
        lineHeightIsRatio: true,
        sourceFontName: seg.font?.rawFontName,
      },
      options
    );

    boxes.push({
      x: seg.cssX,
      y: seg.cssY,
      width: seg.cssW,
      height: seg.cssH,
      rotation: 0, // Segment 无旋转字段（旋转在 document-model 层，属于 PDF Binding）
      source: boxSource,
      paragraphs: splitParagraphs(seg.text ?? "").map((text) => ({
        runs: [{ text, style, source: runSource }],
        alignment: toAlignment(seg.textAlign),
      })),
    });
  }

  if (withoutProvenance > 0) {
    warnings.push(
      `${withoutProvenance}/${segments.length} 个 Segment 缺少 source binding → 对应 run 无 provenance（不伪造 blockId/lineId/glyphIndex）`
    );
  }
  if (withGlyphRange > 0) {
    warnings.push(
      `${withGlyphRange} 个 run 携带 glyph 区间 provenance（仅供 PDF Binding 使用，不是 Editor 位置模型）`
    );
  }
  if (tableCells > 0) {
    warnings.push(`${tableCells} 个 Segment 标记为表格 cell；Editor Core 暂未建模表格语义`);
  }
  warnings.push(
    "未建模字段（本阶段显式丢弃）：hz(Tz 水平缩放)、cssBaseline、fontResolution、originalText"
  );

  const pages = [
    {
      index: options.pageIndex ?? 1,
      width: options.pageWidth ?? 0,
      height: options.pageHeight ?? 0,
      boxes,
    },
  ];
  return materializeImport(pages, options, warnings);
}
