/**
 * editor/core/render/frame.ts — EDITOR-CORE-010-B
 *
 * buildRenderFrame —— 把 TextLayout 的几何与 EditorDocument 的字符/样式 join 成
 * EditorRenderFrame。
 *
 * ── 唯一职责 ────────────────────────────────────────────────────────
 *     GlyphLayout（几何 / advance / baseline / advanceSource）
 *          +
 *     TextRun（char / style）
 *          ↓  join by (runId, textIndex)
 *     EditorRenderFrame
 *
 * ── 三件绝对不做的事 ────────────────────────────────────────────────
 *   1. **不重新测量**：`advance` / `box` / `baseline` 一律直接取自 `GlyphLayout`，
 *      本文件不出现任何度量调用、也不接触字体度量提供者（§18：度量在 006 完成）。
 *   2. **不重算 caret / selection**：直接复用 006-B 传入的对象（**同一引用**），
 *      因此本层不可能产生第二套插入线 / 选区几何。
 *   3. **不解释 `RunLayout.textStart`**：它是「本行可见切片」的段落内区间，
 *      不是 run 的段落起点（007 已确定）。run 的真实段落起点一律由
 *      `getRunStartOffsetInParagraph` 从 **Document** 计算。
 *
 * ── Document 是文本权威 ─────────────────────────────────────────────
 * 字符一律从 `TextRun.text` 取；layout 只提供「哪个 run、哪个段落偏移、多长」。
 * 若 layout 与文档文本对不上 → **记警告并跳过该 glyph**，不静默产出错字符（§65）。
 *
 * ── 依赖边界 ────────────────────────────────────────────────────────
 * 只 import Core 内部（../document / ../layout / ../position）与 node 内建无关。
 * 不 import 旧 renderer 栈、legacy、PDF、DOM、React。
 * 不修改入参（规范 §50：layout / renderer 均不得 mutate document）。
 */

import { findParagraph, findTextBox } from "../document";
import type { EditorDocument, Paragraph, TextBoxObject } from "../document/types";
import type { LiveReflowResult, ParagraphLayout, TextLayout } from "../layout";
import { getRunStartOffsetInParagraph } from "../position";
import {
  FRAME_WARNING_CARET_TEXT_BOX_MISMATCH,
  FRAME_WARNING_GLYPH_TEXT_MISMATCH,
  FRAME_WARNING_MISSING_PARAGRAPH,
  FRAME_WARNING_MISSING_RUN,
  FRAME_WARNING_MISSING_TEXT_BOX,
  FRAME_WARNING_STALE_LAYOUT,
  type BuildRenderFrameOptions,
  type EditorGlyphBox,
  type EditorRenderFrame,
} from "./types";

// ─────────────────────────────────────────────────────────────────────
//  主入口
// ─────────────────────────────────────────────────────────────────────

/**
 * 生成渲染帧。
 *
 * 纯函数：不修改 `document` 与 `layout`；输出中所有对象都是**新对象**，
 * 但其字段值/引用来自入参（`box` / `style` 直接引用，`caret` / `selection` 原样透传）。
 *
 * @param document 文档权威（字符与样式从这里取）
 * @param layout   该 TextBox 的布局（几何从这里取，**不重算**）
 * @param options  可选的 caret / selection 几何（来自 006-B，原样透传）
 */
export function buildRenderFrame(
  document: EditorDocument,
  layout: TextLayout,
  options: BuildRenderFrameOptions = {}
): EditorRenderFrame {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const warn = (message: string): void => {
    if (seen.has(message)) return;
    seen.add(message);
    warnings.push(message);
  };

  // §66：document.version 是权威；layout 若来自旧版本，如实报告（不静默使用）
  if (layout.documentVersion !== document.version) {
    warn(
      `${FRAME_WARNING_STALE_LAYOUT}: layout.documentVersion=${layout.documentVersion} document.version=${document.version}`
    );
  }

  const caret = options.caret ?? null;
  const selection = options.selection ?? null;

  const textBox = findTextBox(document, layout.textBoxId);
  if (!textBox) {
    warn(`${FRAME_WARNING_MISSING_TEXT_BOX}: ${layout.textBoxId}`);
    return {
      textBoxId: layout.textBoxId,
      documentVersion: document.version,
      glyphs: [],
      caret,
      selection,
      warnings,
    };
  }

  const glyphs: EditorGlyphBox[] = [];
  for (const paragraphLayout of layout.paragraphs) {
    joinParagraph(paragraphLayout, textBox, warn, glyphs);
  }

  if (caret && caret.position.textBoxId !== layout.textBoxId) {
    warn(
      `${FRAME_WARNING_CARET_TEXT_BOX_MISMATCH}: caret.textBoxId=${caret.position.textBoxId} layout.textBoxId=${layout.textBoxId}`
    );
  }

  return {
    textBoxId: layout.textBoxId,
    documentVersion: document.version,
    glyphs,
    caret,
    selection,
    warnings,
  };
}

/**
 * 便捷入口：用 009 的 `LiveReflowResult` 直接生成渲染帧。
 *
 * 009 已经在同一次调用里给出「after document + layout + caret/selection 几何」，
 * 因此这里不再要求调用方手工拆四个字段；`result.warnings` 一并并入 frame。
 */
export function renderFrameFromLiveReflow(
  result: LiveReflowResult,
  options: BuildRenderFrameOptions = {}
): EditorRenderFrame {
  const frame = buildRenderFrame(result.document, result.layout, {
    caret: options.caret !== undefined ? options.caret : result.caretGeometry,
    selection: options.selection !== undefined ? options.selection : result.selectionGeometry,
  });

  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const message of [...frame.warnings, ...result.warnings]) {
    if (seen.has(message)) continue;
    seen.add(message);
    warnings.push(message);
  }
  return { ...frame, warnings };
}

// ─────────────────────────────────────────────────────────────────────
//  join（段落 → 行 → run → glyph）
// ─────────────────────────────────────────────────────────────────────

/**
 * 把一个段落的全部 glyph join 出来。
 *
 * runId 来自 `RunLayout`（`GlyphLayout` 自身不带 runId），
 * 字符与样式一律回到 **Document** 取。
 */
function joinParagraph(
  paragraphLayout: ParagraphLayout,
  textBox: TextBoxObject,
  warn: (message: string) => void,
  out: EditorGlyphBox[]
): void {
  const paragraph = findParagraph(textBox, paragraphLayout.paragraphId);
  if (!paragraph) {
    warn(`${FRAME_WARNING_MISSING_PARAGRAPH}: ${paragraphLayout.paragraphId}`);
    return;
  }

  for (const line of paragraphLayout.lines) {
    for (const runLayout of line.runs) {
      const runIndex = indexOfRun(paragraph, runLayout.runId);
      if (runIndex < 0) {
        warn(
          `${FRAME_WARNING_MISSING_RUN}: ${runLayout.runId} (paragraph ${paragraph.id})`
        );
        continue;
      }

      const run = paragraph.runs[runIndex];
      // §5：run 的段落起点由 Document 计算，绝不使用 RunLayout.textStart
      const runStartInParagraph = getRunStartOffsetInParagraph(paragraph, runIndex);

      for (const glyph of runLayout.glyphs) {
        const runOffset = glyph.textIndex - runStartInParagraph;
        const char = sliceRunChar(run.text, runOffset, glyph.length);
        if (char === null) {
          warn(
            `${FRAME_WARNING_GLYPH_TEXT_MISMATCH}: run=${run.id} paragraphOffset=${glyph.textIndex} length=${glyph.length}`
          );
          continue;
        }
        out.push({
          runId: run.id,
          paragraphId: paragraph.id,
          char,
          textIndex: glyph.textIndex,
          textLength: glyph.length,
          box: glyph.box,
          advance: glyph.advance,
          baseline: glyph.baseline,
          style: run.style,
          advanceSource: glyph.advanceSource,
        });
      }
    }
  }
}

/** run 在段落中的序号；找不到返回 -1 */
function indexOfRun(paragraph: Paragraph, runId: string): number {
  for (let i = 0; i < paragraph.runs.length; i++) {
    if (paragraph.runs[i].id === runId) return i;
  }
  return -1;
}

/**
 * 从 run 文本里切出该 glyph 的字符。
 *
 * 越界或长度对不上 → 返回 null（调用方记警告并跳过），
 * **绝不**返回半截字符或占位符冒充成功。
 */
function sliceRunChar(text: string, runOffset: number, length: number): string | null {
  if (runOffset < 0 || length <= 0) return null;
  if (runOffset + length > text.length) return null;
  const char = text.slice(runOffset, runOffset + length);
  return char.length === length ? char : null;
}
