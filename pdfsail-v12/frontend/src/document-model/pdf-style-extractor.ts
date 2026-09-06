/**
 * PDF Native Style Extractor — Task 2
 *
 * 从 pdf.js TextContent 提取精确的样式信息。
 *
 * 输入：pdf.js TextContent（items[]）
 * 输出：EditableStyle（含 fontFamily/fontSize/fontWeight/fontStyle/color/transform/lineHeight）
 *
 * 提取来源：
 *   1. fontName：item.fontName（如 "ABCDEF+Helvetica-Bold"）
 *   2. fontSize：item.fontSize 或 transform[0]（水平缩放）
 *   3. transform：item.transform [a, b, c, d, e, f]
 *   4. color：graphics state（rgb/g 操作符）—— pdf.js 不直接暴露，需解析 operator list
 *
 * 颜色提取策略：
 *   pdf.js 的 TextContent 不包含颜色信息（颜色在 graphics state 中）。
 *   Sprint 2 采用启发式：
 *     - 默认黑色 #000000（PDF 默认 fill color）
 *     - 从字体名推断（如 "RedText" → 红色，罕见）
 *     - Sprint 3 可用 page.getOperatorList() 解析颜色操作符
 *
 * 不修改现有 editor-engine：
 *   本模块独立于 editor-engine/FontAnalyzer，只读取 pdf.js 原始数据。
 *   FontAnalyzer 继续用于 segments 渲染（保持不变）。
 *   本模块输出更完整的 EditableStyle（含 fontStyle/transform/letterSpacing）。
 */

import type { EditableStyle } from "./types";
import type { PdfTextItem } from "../editor-engine/types";

/**
 * M7.7-009B-2A: Font Identity — 从 pdf.js FontFaceObject 提取的字体身份信息。
 *
 * 通过 commonObjs.get(fontName) 获取 FontFaceObject 后，从 name 字段提取：
 *   - rawName: "BAAAAA+DejaVuSans-Bold"（FontFaceObject.name 原始值）
 *   - normalizedName: "DejaVuSans-Bold"（去掉 subset 前缀）
 *   - fontWeight: 700（从字体名推断）
 */
export interface FontFaceIdentity {
  rawName: string;
  normalizedName: string;
  fontWeight: number;
}

/** 模块级字体身份缓存，由 PDFEditor（或任何有 commonObjs 访问权的调用方）填充 */
let fontIdentityCache: Map<string, FontFaceIdentity> | null = null;

/** 设置字体身份缓存（每个文档加载时调用一次） */
export function setFontIdentityCache(map: Map<string, FontFaceIdentity>): void {
  fontIdentityCache = map;
}

/** 清理字体身份缓存 */
export function clearFontIdentityCache(): void {
  fontIdentityCache = null;
}

/** 按 pdf.js 内部字体名查找字体身份 */
function getFontIdentity(fontName: string): FontFaceIdentity | undefined {
  return fontIdentityCache?.get(fontName);
}

/** 去掉 subset 前缀（如 "BAAAAA+"） */
export function normalizePdfFontName(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, "");
}

/** 从字体名推断 CSS font-weight */
export function inferFontWeight(fontName: string): number {
  const lower = fontName.toLowerCase();
  if (lower.includes("black") || lower.includes("heavy")) return 900;
  if (lower.includes("bold")) return 700;
  if (lower.includes("medium")) return 500;
  if (lower.includes("light")) return 300;
  if (lower.includes("thin")) return 200;
  if (lower.includes("regular") || lower.includes("normal")) return 400;
  return 400;
}

/** 从字体名推断是否 italic */
function inferItalic(fontName: string): boolean {
  const lower = fontName.toLowerCase();
  return lower.includes("italic") || lower.includes("oblique");
}

/**
 * 将加字体重/italic 后缀的字体名转换为 CSS font-family。
 * 例如 "DejaVuSans-Bold" → "'DejaVu Sans', Arial, Helvetica, sans-serif"
 */
function normalizedNameToCssFamily(normalizedName: string): string {
  // 去掉 weight/italic 后缀
  const base = normalizedName
    .replace(/-bold|-heavy|-black|-light|-thin|-medium|-regular|-normal/gi, "")
    .replace(/-italic|-oblique/gi, "")
    .trim();
  if (!base) return "Arial, Helvetica, sans-serif";
  // 查已知字体映射表
  const lower = base.toLowerCase().replace(/[-_]/g, "");
  const mapped = FONT_FAMILY_MAP[lower];
  if (mapped) return mapped;
  // 驼峰转空格（如 "DejaVuSans" → "DejaVu Sans"）
  const spaced = base.replace(/([a-z])([A-Z])/g, "$1 $2");
  return `'${spaced}', Arial, Helvetica, sans-serif`;
}

/** PDF 字体名 → CSS font-family 映射（与 FontAnalyzer 一致，独立维护避免循环依赖） */
const FONT_FAMILY_MAP: Record<string, string> = {
  // 西文
  helvetica: "Helvetica, Arial, sans-serif",
  arial: "Arial, sans-serif",
  times: "'Times New Roman', Times, serif",
  timesnewroman: "'Times New Roman', Times, serif",
  courier: "'Courier New', Courier, monospace",
  verdana: "Verdana, sans-serif",
  georgia: "Georgia, serif",
  calibri: "Calibri, sans-serif",
  tahoma: "Tahoma, sans-serif",
  trebuchetms: "'Trebuchet MS', sans-serif",
  // 中文
  simsun: "'SimSun', 'Songti SC', serif",
  songti: "'Songti SC', 'SimSun', serif",
  stsong: "'STSong', 'SimSun', serif",
  simhei: "'SimHei', 'Heiti SC', sans-serif",
  heiti: "'Heiti SC', 'SimHei', sans-serif",
  stheiti: "'Heiti SC', 'SimHei', sans-serif",
  microsoftyahei: "'Microsoft YaHei', sans-serif",
  msyh: "'Microsoft YaHei', sans-serif",
  kaiti: "'KaiTi', 'STKaiti', serif",
  stkaiti: "'STKaiti', 'KaiTi', serif",
  fangsong: "'FangSong', 'STFangsong', serif",
  stfangsong: "'STFangsong', 'FangSong', serif",
  youyuan: "'YouYuan', sans-serif",
  // 日文
  mincho: "'Hiragino Mincho ProN', 'Yu Mincho', serif",
  gothic: "'Hiragino Sans', 'Yu Gothic', sans-serif",
  // 韩文
  batang: "'Batang', serif",
  dotum: "'Dotum', sans-serif",
};

/** 字体名中的 weight 关键词 */
const WEIGHT_MAP: Record<string, number> = {
  bold: 700,
  heavy: 800,
  black: 900,
  light: 300,
  thin: 200,
  medium: 500,
  regular: 400,
  normal: 400,
};

/**
 * 解析 PDF 字体名，返回 family / weight / italic。
 */
function parseFontName(rawFontName: string): {
  family: string;
  weight: number;
  italic: boolean;
} {
  const cleanName = rawFontName.replace(/^[A-Z]{6}\+/, "");
  const lowerName = cleanName.toLowerCase();

  // 检测 weight
  let weight = 400;
  for (const [keyword, w] of Object.entries(WEIGHT_MAP)) {
    if (lowerName.includes(keyword)) {
      weight = w;
      break;
    }
  }

  // 检测 italic
  const italic = lowerName.includes("italic") || lowerName.includes("oblique");

  // 映射到 CSS family
  const baseName = lowerName
    .replace(/-bold|-heavy|-black|-light|-thin|-medium|-regular|-normal/g, "")
    .replace(/italic|oblique/g, "")
    .replace(/[-_]/g, "")
    .trim();

  let family = FONT_FAMILY_MAP[baseName];
  if (!family) {
    for (const [key, value] of Object.entries(FONT_FAMILY_MAP)) {
      if (baseName.includes(key)) {
        family = value;
        break;
      }
    }
  }
  if (!family) {
    family = baseName.match(/sim|song|hei|kai|fang/)
      ? "'SimSun', 'Songti SC', serif"
      : "Arial, Helvetica, sans-serif";
  }

  return { family, weight, italic };
}

/**
 * 从 pdf.js TextItem 提取 fontSize（pt）。
 *
 * 优先级：
 *   1. item.fontSize（pdf.js 已计算）
 *   2. sqrt(a² + b²)（transform 矩阵的水平+垂直缩放）
 *   3. item.height
 *   4. fallback 12pt
 */
function extractFontSizePt(item: PdfTextItem): number {
  if (item.fontSize && item.fontSize > 0) return item.fontSize;
  const tm = item.transform;
  if (tm && tm.length >= 2) {
    const fromMatrix = Math.sqrt(tm[0] * tm[0] + tm[1] * tm[1]);
    if (fromMatrix > 0) return fromMatrix;
  }
  return item.height || 12;
}

/**
 * 从 TextItem 提取字间距（letterSpacing）。
 *
 * PDF 字间距通过 TJ 操作符的负偏移实现，pdf.js 不直接暴露。
 * 这里从 transform[0]（水平缩放）和 width 推断：
 *   如果 width / str.length ≠ fontSize，可能存在字间距。
 *
 * Sprint 2 返回 0（默认无字间距），Sprint 3 精确化。
 */
function extractLetterSpacing(_item: PdfTextItem): number {
  return 0;
}

/**
 * 从 TextItem 提取完整 EditableStyle。
 *
 * @param item pdf.js TextContent item
 * @param cssScale canvas.clientWidth / canvas.width（pt → CSS px 转换）
 * @param viewportScale PDF 渲染 scale（通常 1.5）
 * @param lineHeightPx 行高（CSS px，由调用方从 bbox 高度计算）
 * @returns EditableStyle（完整字段）
 */
export function extractPdfNativeStyle(
  item: PdfTextItem,
  cssScale: number,
  viewportScale: number,
  lineHeightPx?: number
): EditableStyle {
  const rawFontName = item.fontName || "unknown";
  const fontSizePt = extractFontSizePt(item);

  // M7.7-009B-2a: 诊断——检查入参
  console.log(`[009B-2a] extractPdfNativeStyle called: fontName="${rawFontName}" str="${item.str?.substring(0, 30)}"`);

  // M7.7-009B-2A: 优先使用字体身份缓存（从 FontFaceObject.name 提取的真实字体信息）
  const identity = getFontIdentity(rawFontName);
  let fontFamily: string;
  let fontWeight: number;
  let fontStyle: "normal" | "italic" | "oblique";
  let pdfFontName: string;

  if (identity) {
    // 使用真实字体身份
    fontFamily = normalizedNameToCssFamily(identity.normalizedName);
    fontWeight = identity.fontWeight;
    fontStyle = inferItalic(identity.normalizedName) ? "italic" : "normal";
    pdfFontName = identity.rawName;
    console.log(`[009B-2a] extractPdfNativeStyle: identity found for "${rawFontName}" -> name="${identity.rawName}" weight=${fontWeight} family="${fontFamily}"`);
  } else {
    // 回退到 parseFontName（现有行为）
    const parsed = parseFontName(rawFontName);
    fontFamily = parsed.family;
    fontWeight = parsed.weight;
    fontStyle = parsed.italic ? "italic" : "normal";
    pdfFontName = rawFontName;
  }

  // pt → CSS px：fontSizePt × viewportScale × cssScale
  const fontSizePx = fontSizePt * viewportScale * cssScale;

  // lineHeight：优先用传入的 bbox 行高，否则默认 1.3 × fontSize
  const lineHeight = lineHeightPx ?? fontSizePx * 1.3;

  // transform 保留原始 PDF 矩阵（用于精确还原倾斜/缩放）
  const transform: [number, number, number, number, number, number] | undefined =
    item.transform && item.transform.length >= 6
      ? [
          item.transform[0],
          item.transform[1],
          item.transform[2],
          item.transform[3],
          item.transform[4],
          item.transform[5],
        ]
      : undefined;

  return {
    fontFamily,
    fontSize: fontSizePx,
    fontWeight,
    fontStyle,
    color: "#000000", // 默认黑色，Sprint 3 解析 graphics state
    lineHeight,
    letterSpacing: extractLetterSpacing(item),
    transform,
    // M7.7-009B: PDF 字体身份
    pdfjsFontFamily: rawFontName,  // PDF.js @font-face 名（如 "g_d0_f1"）
    pdfFontName,                     // 原始 PDF 字体名（如 "BAAAAA+DejaVuSans-Bold"）
  };
}

/**
 * 批量提取：从 TextContent items 提取样式数组。
 *
 * 用于 StyleResolver 注册前的预处理。
 */
export function extractStylesFromTextContent(
  items: PdfTextItem[],
  cssScale: number,
  viewportScale: number
): EditableStyle[] {
  return items.map((item) => extractPdfNativeStyle(item, cssScale, viewportScale));
}
