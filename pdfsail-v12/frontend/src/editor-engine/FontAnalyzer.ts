/**
 * FontAnalyzer — Commit 5
 *
 * Font Fidelity Layer 的核心：把 PDF 字体名映射为 CSS 字体属性。
 *
 * PDF 字体名格式：
 *   - "ABCDEF+Helvetica"（subset 前缀 + 原字体名）
 *   - "g_d0_f1"（部分 PDF 用 CID 字体名）
 *   - "SimSun" / "STSong"（中文）
 *
 * 映射策略（多数产品的做法）：
 *   1. 去掉 subset 前缀（ABCDEF+）
 *   2. 按已知字体名映射到 CSS family
 *   3. 未知的 fallback 到通用字体
 *
 * 字体大小转换：
 *   CSS px = PDF pt × zoom × 96 / 72
 *   （这里只做 pt → px，zoom 在 CoordinateMapper 应用）
 */

import type { FontMeta } from "./types";

/** 已知的 PDF 字体名 → CSS font-family 映射 */
const FONT_MAP: Record<string, string> = {
  // 西文
  "helvetica": "Helvetica, Arial, sans-serif",
  "arial": "Arial, sans-serif",
  "times": "'Times New Roman', Times, serif",
  "timesnewroman": "'Times New Roman', Times, serif",
  "courier": "'Courier New', Courier, monospace",
  "verdana": "Verdana, sans-serif",
  "georgia": "Georgia, serif",
  "calibri": "Calibri, sans-serif",
  "tahoma": "Tahoma, sans-serif",
  "trebuchetms": "'Trebuchet MS', sans-serif",
  // 中文
  "simsun": "'SimSun', 'Songti SC', serif",
  "songti": "'Songti SC', 'SimSun', serif",
  "stsong": "'STSong', 'SimSun', serif",
  "simhei": "'SimHei', 'Heiti SC', sans-serif",
  "heiti": "'Heiti SC', 'SimHei', sans-serif",
  "stheiti": "'Heiti SC', 'SimHei', sans-serif",
  "microsoftyahei": "'Microsoft YaHei', sans-serif",
  "msyh": "'Microsoft YaHei', sans-serif",
  "kaiti": "'KaiTi', 'STKaiti', serif",
  "stkaiti": "'STKaiti', 'KaiTi', serif",
  "fangsong": "'FangSong', 'STFangsong', serif",
  "stfangsong": "'STFangsong', 'FangSong', serif",
  "youyuan": "'YouYuan', sans-serif",
  // 日文
  "mincho": "'Hiragino Mincho ProN', 'Yu Mincho', serif",
  "gothic": "'Hiragino Sans', 'Yu Gothic', sans-serif",
  // 韩文
  "batang": "'Batang', serif",
  "dotum": "'Dotum', sans-serif",
};

/** 字体名中的 weight 关键词 */
const WEIGHT_MAP: Record<string, number> = {
  "bold": 700,
  "heavy": 800,
  "black": 900,
  "light": 300,
  "thin": 200,
  "medium": 500,
  "regular": 400,
  "normal": 400,
};

export class FontAnalyzerImpl implements FontAnalyzer {
  /**
   * 分析 PDF 字体名 + 大小，返回 CSS 字体属性。
   *
   * @param rawFontName PDF 原始字体名（如 "ABCDEF+Helvetica-Bold"）
   * @param fontSizePt 字体大小（pt）
   * @returns FontMeta（CSS 字体属性）
   */
  analyze(rawFontName: string, fontSizePt: number): FontMeta {
    // 1. 去掉 subset 前缀（ABCDEF+）
    const cleanName = rawFontName.replace(/^[A-Z]{6}\+/, "");

    // 2. 检测 weight（从字体名中提取 bold/light 等关键词）
    let weight = 400;
    const lowerName = cleanName.toLowerCase();
    for (const [keyword, w] of Object.entries(WEIGHT_MAP)) {
      if (lowerName.includes(keyword)) {
        weight = w;
        break;
      }
    }
    // italic 检测（不影响 weight，但记录在 family 里）
    const isItalic = lowerName.includes("italic") || lowerName.includes("oblique");

    // 3. 映射到 CSS family
    // 去掉 weight/italic 关键词后查表
    const baseName = lowerName
      .replace(/-bold|-heavy|-black|-light|-thin|-medium|-regular|-normal/g, "")
      .replace(/italic|oblique/g, "")
      .replace(/[-_]/g, "")
      .trim();

    let family = FONT_MAP[baseName];
    if (!family) {
      // 尝试模糊匹配（baseName 包含某个已知字体）
      for (const [key, value] of Object.entries(FONT_MAP)) {
        if (baseName.includes(key)) {
          family = value;
          break;
        }
      }
    }
    if (!family) {
      // fallback：如果是中文 PDF，用 SimSun；否则用通用 sans-serif
      family = baseName.match(/sim|song|hei|kai|fang/) 
        ? "'SimSun', 'Songti SC', serif" 
        : "Arial, Helvetica, sans-serif";
    }

    // 4. pt → px（96/72 = 1.3333）
    // zoom 在 CoordinateMapper 应用，这里只做 pt → px
    const sizePx = fontSizePt * 96 / 72;

    // 5. 颜色（PDF 默认黑色，提取颜色需要解析 graphics state，这里先默认）
    const color = "#000000";

    // 6. line-height（1.3 与原 coord.ts 一致）
    const lineHeight = 1.3;

    return {
      family,
      rawFontName,
      size: sizePx,
      weight,
      style: isItalic ? "italic" : "normal",
      color,
      lineHeight,
    };
  }
}

/** FontAnalyzer 接口（供 SegmentBuilder 依赖注入） */
export interface FontAnalyzer {
  analyze(rawFontName: string, fontSizePt: number): FontMeta;
}
