/**
 * Style Normalizer — M7.7-006H
 *
 * 单一入口：将 PDF 原生/OCR 原始样式语义标准化为统一的 CSS 绝对单位。
 *
 * 输入线：
 *   - PDF Native（pdf-native-adapter.ts）：lineHeight 为无单位比例（如 1.0 = 1×fontSize）
 *   - OCR（layout-engine.ts）：lineHeight 可能为绝对 px 或比例值
 *
 * 输出：
 *   所有样式字段使用 CSS 绝对单位/pixel 值，确保 EditSession / GlyphRenderer / ExportRenderer
 *   使用同一套最终值，不再各自做二次解释。
 *
 * lineHeight 规则：
 *   (0, 5]   → 无单位比例，normalize 为 px = value × fontSize
 *   ≤ 0 / null / undefined → fontSize × 1.2（fallback）
 *   > 5      → 已为绝对 px，保持原值
 *
 * fontWeight 规则：
 *   "normal" / "400" / 400  → 400
 *   "bold" / "700" / 700    → 700
 *   其他数字字符串 → 解析为 number
 *   undefined             → 400
 *
 * fontSize 规则：
 *   > 0  → 保持
 *   ≤ 0 / null / undefined → 14（fallback）
 */

import type { EditableStyle } from "./types";

/** 标准化后的样式（所有字段为确定值） */
export interface NormalizedStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  fontStyle?: "normal" | "italic" | "oblique";
  color?: string;
  letterSpacing?: number;
  // M7.7-009B: PDF 字体身份（透传，不做标准化）
  pdfjsFontFamily?: string;
  pdfFontName?: string;
}

/**
 * 将 EditableStyle 标准化为 CSS 绝对单位。
 * 不修改 input，返回新对象。
 */
export function normalizeStyle(raw: Partial<EditableStyle>): NormalizedStyle {
  // ── fontSize ──
  let fontSize = raw.fontSize ?? 14;
  if (typeof fontSize !== "number" || fontSize <= 0 || !isFinite(fontSize)) {
    fontSize = 14;
  }

  // ── lineHeight: 比例 → 绝对 px ──
  const rawLh = raw.lineHeight;
  let lineHeight: number;
  if (rawLh == null || rawLh <= 0 || !isFinite(rawLh)) {
    // 无效 / 缺失 → fontSize × 1.2
    lineHeight = fontSize * 1.2;
  } else if (rawLh <= 5) {
    // 无单位比例（PDF 原生常见 1.0 / 1.2）→ px
    lineHeight = fontSize * rawLh;
  } else {
    // 已为绝对 px
    lineHeight = rawLh;
  }

  // ── fontWeight: 统一为 number ──
  const fontWeight = normalizeFontWeight(raw.fontWeight);

  // ── fontFamily ──
  const fontFamily = raw.fontFamily?.trim() || "Arial, sans-serif";

  // ── fontStyle ──
  const fontStyle = raw.fontStyle === "italic" || raw.fontStyle === "oblique"
    ? raw.fontStyle
    : undefined;

  return {
    fontFamily,
    fontSize,
    fontWeight,
    lineHeight: Math.round(lineHeight * 100) / 100, // 2 位小数
    fontStyle,
    color: raw.color,
    letterSpacing: raw.letterSpacing,
    // M7.7-009B: 透传 PDF 字体身份（不做标准化，保留原始值用作 overlay 渲染）
    pdfjsFontFamily: raw.pdfjsFontFamily,
    pdfFontName: raw.pdfFontName,
  };
}

/** 将 fontWeight 统一为 number */
function normalizeFontWeight(fw: string | number | undefined): number {
  if (fw == null) return 400;
  if (typeof fw === "number") {
    if (isFinite(fw) && fw >= 100 && fw <= 900) return Math.round(fw);
    return 400;
  }
  // string
  const lower = fw.toLowerCase().trim();
  if (lower === "normal" || lower === "400") return 400;
  if (lower === "bold" || lower === "700") return 700;
  if (lower === "lighter" || lower === "200") return 200;
  if (lower === "bolder" || lower === "800") return 800;
  if (lower === "medium" || lower === "500") return 500;
  if (lower === "semibold" || lower === "600") return 600;
  if (lower === "heavy" || lower === "black" || lower === "900") return 900;
  if (lower === "light" || lower === "300") return 300;
  // 尝试数字字符串
  const n = parseInt(lower, 10);
  if (!isNaN(n) && n >= 100 && n <= 900) return n;
  return 400;
}