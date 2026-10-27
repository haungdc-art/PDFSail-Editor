/**
 * F3B-6.17-A — Segment → Core Range Adapter（纯函数）
 *
 * 职责：**只**解决一件事
 *   (blockId, lineId, startGlyphIndex, endGlyphIndex)  →  Core 文本对象 + UTF-16 区间
 *
 * ── 硬约束 ──────────────────────────────────────────────────────────
 *   · 复用既有 `glyphRangeToUtf16Range`（6.5-C），**禁止** `text.length === glyphCount`
 *   · **禁止**新增 glyph ID
 *   · provenance（blockId/lineId）**只用于定位 Core 文本对象**，
 *     不得把 PDF fidelity 写进 Core / EditorDocument
 *   · Core Command 不认识 Segment / glyphIndex / EditableDocument / docBlocks
 */

import type { EditableGlyph } from "../../document-model/types";
import { glyphRangeToUtf16Range } from "../../document-model/glyph-mapping";
import type { EditorDocument } from "../core/document/types";

/** Segment.source 的坐标部分（与 `editor-engine/types.ts` 一致） */
export interface SegmentSourceRef {
  blockId: string;
  lineId: string;
  lineIdx?: number;
  /** inclusive glyph 下标 */
  startGlyphIndex: number;
  endGlyphIndex: number;
}

/** 解析结果：Core 文本对象 + run 内 UTF-16 区间 */
export interface CoreTextRangeRef {
  textBoxId: string;
  paragraphId: string;
  runId: string;
  /** UTF-16 区间 [start, end)，位于 `runId` 所在 run 内 */
  start: number;
  end: number;
}

export interface ResolveSegmentRangeInput {
  /** Core document（EditorDocument） */
  document: EditorDocument;
  source: SegmentSourceRef;
  /**
   * 该行 import-time glyph 序列（按 glyph index 有序）。
   * 用 `originalChar`（原文字符）累加 UTF-16 长度 —— 与 `glyphRangeToUtf16Range` 同口径。
   */
  glyphs: ReadonlyArray<{ char?: string; originalChar?: string }>;
}

/**
 * 把 Segment 坐标解析为 Core 文本区间。
 *
 * 定位方式：遍历 Core document，找出 `run.source.blockId/lineId` 与 Segment 匹配的 run。
 * 未命中（无 provenance / 文档不含该行）→ 返回 `null`，由**调用方**走 Legacy fallback
 * （本模块不做 fallback，遵守「eligibility 决定路径」）。
 */
export function resolveSegmentToCoreRange(
  input: ResolveSegmentRangeInput
): CoreTextRangeRef | null {
  const { document, source, glyphs } = input;
  if (!source?.blockId || !source?.lineId) return null;

  for (const page of document.pages ?? []) {
    for (const object of page.objects ?? []) {
      if (object.type !== "text") continue; // F3B-6.24-B3：图片对象无段落
      for (const paragraph of object.paragraphs ?? []) {
        for (const run of paragraph.runs ?? []) {
          const blockId = run.source?.blockId;
          const lineId = run.source?.lineId;
          if (blockId !== source.blockId || lineId !== source.lineId) continue;

          const { start, end } = glyphRangeToUtf16Range(
            glyphs as ReadonlyArray<EditableGlyph>,
            source.startGlyphIndex,
            source.endGlyphIndex
          );
          return {
            textBoxId: object.id,
            paragraphId: paragraph.id,
            runId: run.id,
            start,
            end,
          };
        }
      }
    }
  }

  return null;
}
