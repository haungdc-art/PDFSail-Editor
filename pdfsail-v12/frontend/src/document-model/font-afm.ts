/**
 * font-afm.ts — M7.5-VERIFY-002A · Ground Truth Font Metrics
 *
 * 用途：为 Standard 14 字体提供逐字符 advance width 的权威 ground truth。
 *
 * 来源：Adobe AFM（Adobe Font Metrics）。
 *   - Standard 14 字体在 PDF 中通常不内嵌 /Widths 数组（由阅读器按 AFM 隐式解析），
 *     因此本表是「PDF Font Dictionary /Widths」的权威等价物。
 *   - 单位：1/1000 em（PDF 标准）。实际 advance(PT) = width/1000 × fontSize(PT)。
 *
 * 纪律：只读 ground truth 数据，不含任何 pdf.js / canvas 的测量结果。
 */

/**
 * 字体的逐字符 advance width 表（字符 → 1/1000 em）。
 * 仅包含本验证 fixture 用到的字符（A-Z、0-9、空格）。
 */
export interface AfmWidthTable {
  /** 字体名（PDF /FontName） */
  name: string;
  /** 是否等宽字距（monospace 直读此值即可） */
  monospace?: boolean;
  /** 字符 → advance（1/1000 em） */
  widths: Record<string, number>;
}

/**
 * Adobe Helvetica AFM（canonical）：
 *   - 大写：A667 B667 C722 D722 E667 F611 G778 H722 I278 J500 K667 L556
 *           M833 N722 O778 P667 Q778 R722 S667 T611 U722 V667 W944 X667 Y667 Z611
 *   - 数字：0-9 均 556
 *   - 空格：278
 */
export const HELVETICA_AFM: AfmWidthTable = {
  name: "Helvetica",
  widths: {
    " ": 278,
    A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778,
    H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722,
    O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722,
    V: 667, W: 944, X: 667, Y: 667, Z: 611,
    "0": 556, "1": 556, "2": 556, "3": 556, "4": 556,
    "5": 556, "6": 556, "7": 556, "8": 556, "9": 556,
  },
};

/**
 * Adobe Times-Roman AFM（canonical，仅本 fixture 用到的字符）。
 */
export const TIMES_ROMAN_AFM: AfmWidthTable = {
  name: "Times-Roman",
  widths: {
    " ": 250,
    A: 722, B: 667, C: 667, D: 722, E: 611, F: 611, G: 722,
    H: 722, I: 333, J: 474, K: 556, L: 556, M: 889, N: 722,
    O: 778, P: 667, Q: 889, R: 722, S: 556, T: 611, U: 722,
    V: 667, W: 944, X: 611, Y: 667, Z: 611,
    "0": 500, "1": 500, "2": 500, "3": 500, "4": 500,
    "5": 500, "6": 500, "7": 500, "8": 500, "9": 500,
  },
};

/**
 * Courier（等宽）：所有字符 advance = 600。
 */
export const COURIER_AFM: AfmWidthTable = {
  name: "Courier",
  monospace: true,
  widths: {
    " ": 600,
    A: 600, B: 600, C: 600, D: 600, E: 600, F: 600, G: 600,
    H: 600, I: 600, J: 600, K: 600, L: 600, M: 600, N: 600,
    O: 600, P: 600, Q: 600, R: 600, S: 600, T: 600, U: 600,
    V: 600, W: 600, X: 600, Y: 600, Z: 600,
    "0": 600, "1": 600, "2": 600, "3": 600, "4": 600,
    "5": 600, "6": 600, "7": 600, "8": 600, "9": 600,
  },
};

/** 全部 Standard 14 ground truth 表（按字体名索引） */
export const AFM_BY_NAME: Record<string, AfmWidthTable> = {
  Helvetica: HELVETICA_AFM,
  "Times-Roman": TIMES_ROMAN_AFM,
  Courier: COURIER_AFM,
};

/**
 * 计算某字符在指定字体、指定字号下的 advance（PDF pt）。
 *
 * @param font 字体 AFM 表
 * @param char 单个字符
 * @param fontSize 字号（pt）
 * @returns advance 宽度（pt）
 */
export function afmAdvancePt(font: AfmWidthTable, char: string, fontSize: number): number {
  const width = font.widths[char];
  if (width === undefined) return NaN;
  return (width / 1000) * fontSize;
}