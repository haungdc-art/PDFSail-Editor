/**
 * editor/binding/pdf-metrics.ts — EDITOR-CORE-012-A（Phase A2）
 *
 * 把 legacy `EditableGlyph.metrics.pdfAdvance ?? advanceWidth`（**PDF 内容流有效推进量**）
 * 接入 `FontMetricsProvider` 的 **§18 L2** 路径。
 *
 * ── 为什么必须走 L2，而不是 canvas 兜底 ────────────────────────────
 *
 *     EditableGlyph.metrics.pdfAdvance（PDF 内容流有效 advance，优先）
 *     EditableGlyph.metrics.advanceWidth（字体名义 advance，回退）
 *          ↓ pdfsailGlyphMetrics（§18 L2）
 *     FontMetricsProvider
 *          ↓
 *     GlyphLayout.advance  →  GlyphLayout.box.x  →  RenderCommand.x
 *
 * 这样横向位置由**原 PDF 推进量**决定，而不是在浏览器里重新测量原 glyph。
 * canvas 只在 L2 缺失时才兜底（`advanceSource` 会如实标成 `"canvas"`），
 * 因此任何保真度缺口都是**可观测**的（§18 证据链）。
 *
 * ── 为什么一个 TextBox 一个 provider ───────────────────────────────
 * `visual-line` 粒度下 1 TextBox = 1 视觉行 = 1 Paragraph，
 * 因此 `query.textIndex` 就是**该行文本**的 UTF-16 偏移，可直接查表定位 glyph。
 * 逐行构造 provider 还能顺带做到"每个 glyph 用自己的 advance"。
 *
 * ── 依赖边界 ───────────────────────────────────────────────────────
 * 允许 import：Editor Core `../core/layout`、legacy 类型 `../../document-model/types`。
 * 不 import React / DOM / 旧 renderer 实现。
 */

import type { EditableGlyph, EditableLine } from "../../document-model/types";
import { createFontMetricsProvider } from "../core/layout";
import type { FontMetricsProvider } from "../core/layout";

export interface LegacyLineMetricsOptions {
  /**
   * 是否把 `GlyphMetrics.charSpacing`（PDF Tc）计入 advance。缺省 **true**。
   * 计入后 Core 的 `GlyphLayout.advance` = 该字符在 PDF 里的**有效**推进量，
   * 因此调用方必须把 Core 的 `TextStyle.letterSpacing` 置 0（见 legacy adapter 的 visual-line 模式），
   * 否则会双重计入。
   */
  includeCharSpacing?: boolean;
}

export interface LegacyLineMetricsStats {
  /** 该行 glyph 数 */
  glyphs: number;
  /** 命中 L2（拿到有效 advanceWidth）的 glyph 数 */
  withAdvance: number;
  /** 未命中 L2、退回兜底估算的 glyph 数（>0 时 advanceSource 会是 "canvas"） */
  withoutAdvance: number;
}

export interface LegacyLineMetricsResult {
  metrics: FontMetricsProvider;
  /** 行内 UTF-16 偏移 → glyph（与 `line.glyphs.map(g => g.char).join("")` 的偏移一致） */
  textIndexToGlyph: ReadonlyMap<number, EditableGlyph>;
  stats: LegacyLineMetricsStats;
  warnings: string[];
}

/** 行文本（与 legacy adapter 的 `lineText` 完全同一规则，保证偏移对齐） */
function lineText(line: EditableLine): string {
  return line.glyphs.map((g) => g.char ?? "").join("");
}

/**
 * 为**一个视觉行**构造度量提供者（只配置 L2；不配置 L1/L3）。
 *
 * `query.textIndex` → `line.glyphs` 的映射按**累积 UTF-16 长度**建立，
 * 与 `lineText(line)` 的字符序列严格一致（代理对按 2 个 code unit 计）。
 */
export function createLegacyLineMetrics(
  line: EditableLine,
  options: LegacyLineMetricsOptions = {}
): LegacyLineMetricsResult {
  const includeCharSpacing = options.includeCharSpacing ?? true;
  const warnings: string[] = [];

  const textIndexToGlyph = new Map<number, EditableGlyph>();
  let offset = 0;
  let withAdvance = 0;
  for (const glyph of line.glyphs) {
    const char = glyph.char ?? "";
    textIndexToGlyph.set(offset, glyph);
    const advance = glyph.metrics?.pdfAdvance ?? glyph.metrics?.advanceWidth;
    if (typeof advance === "number" && Number.isFinite(advance) && advance >= 0) {
      withAdvance += 1;
    }
    offset += char.length;
  }

  const text = lineText(line);
  const withoutAdvance = line.glyphs.length - withAdvance;

  const metrics = createFontMetricsProvider({
    // §18 L2：PDFSail 已提取的 glyph metrics
    pdfsailGlyphMetrics: (query) => {
      const glyph = textIndexToGlyph.get(query.textIndex);
      const raw = glyph?.metrics?.pdfAdvance ?? glyph?.metrics?.advanceWidth;
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return undefined;
      const spacing = includeCharSpacing ? glyph?.metrics?.charSpacing : undefined;
      return raw + (typeof spacing === "number" && Number.isFinite(spacing) ? spacing : 0);
    },
    // 逐 glyph 注入原始度量 → 缓存键必须含位置，否则同形字符会复用第一个值
    // （PDF 里不同 text object 的 Tc/Tz 可能不同）
    cacheIncludesTextIndex: true,
  });

  if (withoutAdvance > 0) {
    warnings.push(
      `line ${line.id}: ${withoutAdvance}/${line.glyphs.length} 个 glyph 无 PDF advanceWidth → 退回兜底估算（advanceSource 会标成 "canvas"），横向位置可能不保真`
    );
  }
  if (line.glyphs.length > 0 && text.length === 0) {
    warnings.push(`line ${line.id}: glyph 非空但折叠文本为空（glyph.char 全为空串）`);
  }

  return {
    metrics,
    textIndexToGlyph,
    stats: { glyphs: line.glyphs.length, withAdvance, withoutAdvance },
    warnings,
  };
}
