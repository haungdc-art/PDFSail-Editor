/**
 * Text Measurement Engine — Task 2
 *
 * 用 measureText() 替代按字符平均宽度。
 *
 * 输入：text + style
 * 输出：glyph width（每个字符的精确宽度）
 *
 * 支持：fontFamily / fontSize / fontWeight / fontStyle / letterSpacing
 *
 * 实现：
 *   - 使用 Canvas 2D Context 的 measureText() API
 *   - 共享 canvas 实例避免重复创建
 *   - 缓存测量结果（相同 text + style → 同一宽度）
 *
 * 测量策略：
 *   - 逐字符测量（精确到每个字符）
 *   - 支持字间距（letterSpacing 在每个字符宽度上累加）
 *   - 支持中英文混排（中文等宽，英文变宽）
 */

import type { EditableStyle, EditableGlyph } from "./types";

/** 共享 canvas，避免每次创建 */
let _measureCanvas: HTMLCanvasElement | null = null;

function getMeasureCtx(): CanvasRenderingContext2D {
  if (!_measureCanvas) {
    _measureCanvas = document.createElement("canvas");
  }
  return _measureCanvas.getContext("2d")!;
}

/** 构建 CSS font 字符串 */
function buildFontString(style: EditableStyle): string {
  const weight = style.fontWeight || "normal";
  const size = style.fontSize || 14;
  const fontStyle = style.fontStyle || "normal";
  // 优先使用 PDF 原字体名；若不可用（或浏览器无法加载）则回退到 CSS fallback。
  // 这样测量结果更接近原 PDF 字形宽度，减少编辑/导出后的漂移。
  const family =
    style.pdfjsFontFamily ||
    style.fontFamily ||
    "'Noto Sans SC', 'Microsoft YaHei', 'PingFang SC', sans-serif";
  return `${fontStyle} ${weight} ${size}px ${family}`;
}

/** 测量缓存键 */
function cacheKey(text: string, style: EditableStyle): string {
  return `${text}|${buildFontString(style)}|${style.letterSpacing || 0}`;
}

/** 测量结果缓存（避免重复 measureText 调用） */
const measureCache = new Map<string, number>();

/** 缓存上限（防止内存膨胀） */
const CACHE_LIMIT = 10000;

/**
 * 测量单个字符的宽度（含字间距）
 *
 * @param char 单个字符
 * @param style 样式
 * @returns 字符宽度（px，含 letterSpacing）
 */
export function measureCharWidth(char: string, style: EditableStyle): number {
  const key = cacheKey(char, style);
  const cached = measureCache.get(key);
  if (cached !== undefined) return cached;

  const ctx = getMeasureCtx();
  ctx.font = buildFontString(style);
  const width = ctx.measureText(char).width + (style.letterSpacing || 0);

  // 缓存管理
  if (measureCache.size >= CACHE_LIMIT) {
    // 简单 LRU：清空一半缓存
    const keys = measureCache.keys();
    let count = 0;
    for (const k of keys) {
      measureCache.delete(k);
      count++;
      if (count >= CACHE_LIMIT / 2) break;
    }
  }
  measureCache.set(key, width);

  return width;
}

/**
 * 测量一段文本的总宽度
 *
 * @param text 文本
 * @param style 样式
 * @returns 总宽度（px）
 */
export function measureTextWidth(text: string, style: EditableStyle): number {
  const ctx = getMeasureCtx();
  ctx.font = buildFontString(style);
  const baseWidth = ctx.measureText(text).width;
  const letterSpacing = style.letterSpacing || 0;
  // letterSpacing 应用到每个字符间隙
  return baseWidth + letterSpacing * Math.max(0, text.length - 1);
}

/**
 * 测量文本并返回每个字符的宽度数组
 *
 * 用于 Glyph Positioning（Task 4）：
 *   每个字符有精确宽度，不均分 bbox。
 *
 * @param text 文本
 * @param style 样式
 * @returns 每个字符的宽度数组（与 text 的字符一一对应）
 */
export function measureCharWidths(
  text: string,
  style: EditableStyle
): number[] {
  const chars = Array.from(text); // 正确处理 surrogate pair
  return chars.map((ch) => measureCharWidth(ch, style));
}

/**
 * 计算文本从指定起始位置到结束位置的累积宽度
 *
 * 用于换行判断：逐步累加字符宽度，超出 maxWidth 时断行。
 *
 * @param text 文本
 * @param style 样式
 * @param maxWidth 最大宽度
 * @returns { lines: 每行的字符索引范围 [start, end), widths: 每行的总宽度 }
 */
export function breakTextIntoLines(
  text: string,
  style: EditableStyle,
  maxWidth: number
): { lines: Array<{ start: number; end: number; width: number }>; totalWidth: number } {
  const chars = Array.from(text);
  const widths = chars.map((ch) => measureCharWidth(ch, style));

  const lines: Array<{ start: number; end: number; width: number }> = [];
  let lineStart = 0;
  let lineWidth = 0;
  let totalWidth = 0;

  for (let i = 0; i < chars.length; i++) {
    const charWidth = widths[i];
    const testWidth = lineWidth + charWidth;

    if (testWidth > maxWidth && lineWidth > 0) {
      // 当前行已满，保存并开始新行
      lines.push({ start: lineStart, end: i, width: lineWidth });
      totalWidth += lineWidth;
      lineStart = i;
      lineWidth = charWidth;
    } else {
      lineWidth = testWidth;
    }
  }

  // 最后一行
  if (lineWidth > 0 || lineStart < chars.length) {
    lines.push({ start: lineStart, end: chars.length, width: lineWidth });
    totalWidth += lineWidth;
  }

  return { lines, totalWidth };
}

/**
 * 判断字符是否为 CJK（中日韩）字符
 *
 * CJK 字符逐字断行，非 CJK 字符按 word 断行。
 */
function isCJKChar(char: string): boolean {
  const code = char.codePointAt(0);
  if (code === undefined) return false;
  // CJK Unified Ideographs、CJK 扩展、日文假名、韩文音节等
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||   // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4dbf) ||   // CJK Extension A
    (code >= 0x3040 && code <= 0x30ff) ||   // Hiragana + Katakana
    (code >= 0xac00 && code <= 0xd7af) ||   // Hangul Syllables
    (code >= 0xff00 && code <= 0xffef)      // Fullwidth Forms
  );
}

/**
 * 把文本按 word wrapping 换行（英文按 word，中文按 character）
 *
 * 规则：
 *   - 英文/拉丁文本：按空格分词，不拆 word
 *   - CJK 文本：逐字断行（CJK 无 word 概念）
 *   - 混排：CJK 字符作为独立断行单元，英文 word 整体不拆
 *
 * @param text 文本
 * @param style 样式
 * @param maxWidth 最大可用宽度
 * @returns { lines: 每行的字符索引范围 [start, end), widths: 每行的总宽度 }
 */
export function breakTextIntoLinesByWords(
  text: string,
  style: EditableStyle,
  maxWidth: number
): { lines: Array<{ start: number; end: number; width: number }>; totalWidth: number } {
  const chars = Array.from(text);
  const widths = chars.map((ch) => measureCharWidth(ch, style));

  // 把文本拆成 token：CJK 字符为单字 token，连续非空格非 CJK 字符为 word token，空格为 space token
  interface Token {
    start: number; // chars 数组索引
    end: number;   // end exclusive
    width: number; // token 总宽度
    type: "cjk" | "word" | "space";
  }
  const tokens: Token[] = [];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (isCJKChar(ch)) {
      tokens.push({ start: i, end: i + 1, width: widths[i], type: "cjk" });
      i++;
    } else if (/\s/.test(ch)) {
      // 合并连续空格
      let j = i + 1;
      let w = widths[i];
      while (j < chars.length && /\s/.test(chars[j])) {
        w += widths[j];
        j++;
      }
      tokens.push({ start: i, end: j, width: w, type: "space" });
      i = j;
    } else {
      // word：连续非空格非 CJK 字符
      let j = i + 1;
      let w = widths[i];
      while (j < chars.length && !/\s/.test(chars[j]) && !isCJKChar(chars[j])) {
        w += widths[j];
        j++;
      }
      tokens.push({ start: i, end: j, width: w, type: "word" });
      i = j;
    }
  }

  // 按 token 逐个放入行，超出 maxWidth 时换行
  const lines: Array<{ start: number; end: number; width: number }> = [];
  let lineStart = -1; // chars 索引，-1 表示还没开始
  let lineWidth = 0;
  let totalWidth = 0;

  for (const token of tokens) {
    if (token.type === "space" && lineStart === -1) {
      // 行首空格跳过
      continue;
    }

    const testWidth = lineWidth + token.width;

    if (testWidth > maxWidth && lineStart !== -1) {
      // 当前行已满，保存并开始新行
      lines.push({ start: lineStart, end: token.start, width: lineWidth });
      totalWidth += lineWidth;

      // 新行从当前 token 开始（跳过行首空格）
      if (token.type === "space") {
        lineStart = -1;
        lineWidth = 0;
      } else {
        lineStart = token.start;
        lineWidth = token.width;
      }
    } else {
      if (lineStart === -1) {
        lineStart = token.start;
      }
      lineWidth = testWidth;
    }
  }

  // 最后一行
  if (lineStart !== -1) {
    lines.push({ start: lineStart, end: chars.length, width: lineWidth });
    totalWidth += lineWidth;
  }

  // 边界情况：文本全是空格或为空
  if (lines.length === 0 && chars.length > 0) {
    lines.push({ start: 0, end: chars.length, width: 0 });
  }

  return { lines, totalWidth };
}

/**
 * 获取 glyph 的显示宽度（M7.5-IMPLEMENT-001）。
 *
 * 优先使用 PDF 原始 advanceWidth（metrics.advanceWidth），
 * 无 metrics 时回退到 canvas measureText。
 *
 * 用于：
 *   - 编辑态字符定位（精确匹配 PDF 原始 spacing）
 *   - 新插入字符（无 metrics）的 fallback 测量
 *
 * @param glyph 可编辑字符
 * @param style 样式
 * @returns 字符宽度（CSS px，含 letterSpacing）
 */
export function getGlyphDisplayWidth(
  glyph: Pick<EditableGlyph, "metrics" | "char">,
  style: EditableStyle
): number {
  return glyph.metrics?.advanceWidth ?? measureCharWidth(glyph.char, style);
}

/**
 * 清空测量缓存（测试或内存紧张时用）
 */
export function clearMeasureCache(): void {
  measureCache.clear();
}
