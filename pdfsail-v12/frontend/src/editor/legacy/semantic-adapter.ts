/**
 * editor/legacy/semantic-adapter.ts — EDITOR-CORE-005
 *
 *   document-model-v2 SemanticDocumentV2  →  EditorDocument
 *
 * ── 映射策略 ────────────────────────────────────────────────────────
 * SemanticDocumentV2 的层级与 Editor Core 目标模型天然同构：
 *
 *     SemanticPageV2      →  EditorPage
 *     SemanticParagraphV2 →  TextBoxObject      （bbox = 其所有 run visualBounds 的并集）
 *     SemanticLineV2      →  Paragraph
 *     SemanticRunV2       →  TextRun
 *     RunGlyph            →  （不持久化；只在 run.source 里保留 glyph 区间 provenance）
 *
 * ── 坐标系（§19）──────────────────────────────────────────────────
 * SemanticRunV2.visualBounds 已是 CSS 显示坐标（见 semantic-run.ts 头部注释），
 * 直接作为 Page Canvas Space 使用，本层不做变换。
 *
 * ── source 映射（不冒充 pdf-native）────────────────────────────────
 *   TextSource "pdf_native" → "pdf-native"
 *   TextSource "ocr"        → "ocr"
 *   TextSource "hybrid"     → "ocr"（含 OCR 成分，绝不冒充原生）
 *   run.sourceId            → TextSourceBinding.blockId（稳定 ID，不是对象引用）
 *
 * RunGlyph[] 不落成 Editor 对象；glyph 区间以 [0, glyphs.length-1] 写入 run.source，
 * 仅供 PDF Binding 使用（V7：glyph 索引不得成为 Position/Selection）。
 */

import type { SemanticDocumentV2, SemanticRunV2 } from "../../document-model-v2/semantic-run";
import type { TextSourceBinding } from "../core/document/types";
import {
  materializeImport,
  toSourceKind,
  toTextStyle,
  unionRect,
  type ImportBoxDraft,
  type ImportOptions,
  type ImportParagraphDraft,
  type ImportResult,
  type Rect,
} from "./common";

/** SemanticRunV2.style 是 Readonly<Record<string, unknown>>，逐字段安全读取 */
function strField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = record[key];
  return typeof v === "string" ? v : undefined;
}

function numField(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const v = record[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function runRect(run: SemanticRunV2): Rect {
  return {
    x: run.visualBounds.x,
    y: run.visualBounds.y,
    width: run.visualBounds.width,
    height: run.visualBounds.height,
  };
}

export function semanticDocumentToEditorDocument(
  semantic: SemanticDocumentV2,
  options: ImportOptions = {}
): ImportResult {
  const warnings: string[] = [];
  let runCount = 0;
  let glyphBearingRuns = 0;
  let emptyRuns = 0;

  const pages = semantic.pages.map((page) => {
    const boxes: ImportBoxDraft[] = page.paragraphs.map((paragraph) => {
      const paragraphDrafts: ImportParagraphDraft[] = paragraph.lines.map((line) => {
        const runs = line.runs.map((run) => {
          runCount += 1;
          if (run.text.length === 0) emptyRuns += 1;
          if (run.glyphs.length > 0) glyphBearingRuns += 1;

          const source: TextSourceBinding = { kind: toSourceKind(run.source) };
          if (run.sourceId !== undefined) source.blockId = run.sourceId;
          if (run.backgroundRegionId !== undefined) source.lineId = run.backgroundRegionId;
          if (run.glyphs.length > 0) {
            source.startGlyphIndex = 0;
            source.endGlyphIndex = run.glyphs.length - 1;
          }

          return {
            text: run.text,
            style: toTextStyle(
              {
                fontFamily: strField(run.style, "fontFamily"),
                fontSize: run.metrics.fontSize,
                fontWeight: numField(run.style, "fontWeight") ?? strField(run.style, "fontWeight"),
                fontStyle: strField(run.style, "fontStyle"),
                color: strField(run.style, "color"),
                lineHeight: run.metrics.lineHeight,
                letterSpacing: run.metrics.letterSpacing,
                sourceFontName: strField(run.style, "pdfFontName") ?? strField(run.style, "rawFontName"),
              },
              options
            ),
            source,
          };
        });
        return { runs };
      });

      const allRuns = paragraph.lines.flatMap((l) => l.runs);
      const bounds = unionRect(allRuns.map(runRect));
      const rotation = allRuns.length > 0 ? allRuns[0].rotation : 0;

      return {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        rotation,
        paragraphs: paragraphDrafts,
      };
    });

    return {
      index: page.index,
      width: options.pageWidth ?? page.width,
      height: options.pageHeight ?? page.height,
      boxes,
    };
  });

  warnings.push(
    `RunGlyph[] 不落成 Editor 对象：${glyphBearingRuns}/${runCount} 个 run 的 glyph 区间写入 run.source（provenance only）`
  );
  if (emptyRuns > 0) warnings.push(`${emptyRuns} 个 run 文本为空`);
  warnings.push("未建模字段（显式丢弃）：visualCoverage、backgroundRegionId 语义、RunGlyph 逐字符 bbox");

  return materializeImport(pages, options, warnings);
}
