/**
 * editor/legacy/line-group-adapter.ts — EDITOR-CORE-005
 *
 *   editor-engine LineGroup[]（RawGlyph / PDF.js 提取管线）  →  EditorDocument
 *
 * ── 为什么不重复实现 extractGlyphs / groupIntoLines ────────────────
 * RawGlyph → LineGroup 的提取与分行属于既有 PDF Core 能力
 * （editor-engine/TextExtractor、SegmentBuilder，已被 pdf-importer 使用）。
 * 本 adapter **不重新实现**这两步，调用方按既有方式先跑：
 *
 *     const glyphs = extractGlyphs(page.getTextContent())
 *     const lines  = groupIntoLines(glyphs)
 *     const result = lineGroupsToEditorDocument(lines, mapper, opts)
 *
 * ── 为什么需要注入 mapper（架构地图 V4）───────────────────────────
 * LineGroup 的 pdfX/pdfY 是 PDF pt（左下原点），而 Editor Core 使用
 * Page Canvas Space（左上原点、px）。这个换算**只能有一处实现**——
 * 即既有的 `editor-engine/CoordinateMapper`。若在本层自己写一套
 * `pageHeight - y` 翻转，就会制造第 5 套并行坐标系（架构地图 V4 / 规范 §19）。
 * 因此这里只接受调用方注入的 pdfToCanvas 函数，自己不做任何几何变换。
 *
 * ── glyph 索引归属（V7）────────────────────────────────────────────
 * 每行的字符索引写入 run.source（provenance），绝不进入 Position/Selection。
 */

import type { LineGroup } from "../../editor-engine/types";
import type { TextSourceBinding } from "../core/document/types";
import {
  materializeImport,
  toTextStyle,
  type ImportBoxDraft,
  type ImportOptions,
  type ImportResult,
} from "./common";

/**
 * PDF pt → Page Canvas Space 的映射函数。
 *
 * 实现方应当是既有 CoordinateMapper（`pdfToCss`），而不是新写的坐标变换。
 */
export interface PdfToCanvasMapper {
  pdfToCanvas(
    pdfX: number,
    pdfY: number,
    pdfWidth: number,
    pdfHeight: number
  ): { x: number; y: number; width: number; height: number };
}

export interface LineGroupImportOptions extends ImportOptions {
  /** 源 blockId（用于 run.source.lineId = `pdf_${blockId}_l${lineIdx}`，与 SegmentBuilder 约定一致） */
  sourceBlockId?: string;
}

/** PDF.js 文本项颜色 [r,g,b(,a)] → CSS。与 editor-engine/SegmentBuilder.toCssColor 同一约定
 *  （该函数未导出，故此处内联同语义实现；颜色归一化不属于坐标系/几何算法） */
export function pdfColorToCss(color?: number[]): string | undefined {
  if (!color || color.length < 3) return undefined;
  const max = Math.max(color[0], color[1], color[2]);
  const scale = max > 1 ? 255 : 1;
  const r = Math.round((color[0] / scale) * 255);
  const g = Math.round((color[1] / scale) * 255);
  const b = Math.round((color[2] / scale) * 255);
  if ([r, g, b].some((v) => Number.isNaN(v))) return undefined;
  const a = color.length > 3 ? Math.round((color[3] / (scale === 1 ? 1 : 255)) * 255) / 255 : 1;
  return a < 1 ? `rgba(${r}, ${g}, ${b}, ${a})` : `rgb(${r}, ${g}, ${b})`;
}

/** LineGroup 展开成逐字符后的总长度（代理对按 2 个 UTF-16 单元计，与 EditableLine.glyphs 约定一致） */
function glyphCount(line: LineGroup): number {
  let n = 0;
  for (const g of line.glyphs) n += Array.from(g.str).length;
  return n;
}

export function lineGroupsToEditorDocument(
  lines: LineGroup[],
  mapper: PdfToCanvasMapper,
  options: LineGroupImportOptions = {}
): ImportResult {
  const warnings: string[] = [];
  const boxes: ImportBoxDraft[] = [];
  const blockId = options.sourceBlockId;

  lines.forEach((line, lineIdx) => {
    const rect = mapper.pdfToCanvas(line.pdfX, line.pdfY, line.width, line.height);

    const source: TextSourceBinding = { kind: "pdf-native" };
    if (blockId !== undefined) {
      source.blockId = blockId;
      source.lineId = `pdf_${blockId}_l${lineIdx}`;
      source.lineIdx = lineIdx;
    }
    const chars = glyphCount(line);
    if (chars > 0) {
      source.startGlyphIndex = 0;
      source.endGlyphIndex = chars - 1;
    }

    const style = toTextStyle(
      {
        fontFamily: line.fontName,
        fontSize: line.fontSize,
        color: pdfColorToCss(line.color),
        lineHeight: line.fontSize > 0 ? line.height / line.fontSize : undefined,
        lineHeightIsRatio: true,
        sourceFontName: line.fontName,
      },
      options
    );

    boxes.push({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      rotation: 0, // LineGroup 无旋转信息（旋转由 document-model 层的 transform 承载）
      source: blockId !== undefined ? { kind: "pdf-native", blockId } : { kind: "pdf-native" },
      paragraphs: [
        {
          runs: [{ text: line.text, style, source }],
          alignment: line.textAlign ?? "left",
        },
      ],
    });
  });

  if (blockId === undefined) {
    warnings.push(
      "未提供 sourceBlockId：run.source 只有 kind=pdf-native，无 blockId/lineId/glyph 区间（不伪造）"
    );
  }
  warnings.push(
    "坐标由调用方注入的 PdfToCanvasMapper 换算（复用既有 CoordinateMapper，本层不做几何变换）"
  );
  warnings.push("未建模字段（显式丢弃）：hz(Tz)、LineGroup.textAlign 的非 left 语义、line.color 的 alpha 以外分量");

  return materializeImport(
    [
      {
        index: options.pageIndex ?? 1,
        width: options.pageWidth ?? 0,
        height: options.pageHeight ?? 0,
        boxes,
      },
    ],
    options,
    warnings
  );
}
