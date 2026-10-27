/**
 * 2d-1-B — OCR Projection Geometry Preservation
 *
 * OCR 投影文本块（block.source?.kind === "ocr"）由 Core 文档经 docBlocks 投影层
 * 渲染为 DOM。OCR 已通过检测确定每段文字的 x/y/width/height/文本，这些坐标就是
 * 最终视觉语义；若交给浏览器按 white-space: normal / word wrapping 重新排版，会与
 * OCR 已定位语义冲突（错误换行、行高错位、字距漂移）。
 *
 * 修复范围（用户裁决，方案 1）：只在投影渲染层做 line-level preserve，禁止浏览器
 * 重排版；不修改 Core schema / OCR migration / export / GlyphRenderer。
 * 判据：block.source?.kind === "ocr"。普通文本（pdf-native 投影 / 用户创作）保持原 CSS。
 *
 * 设计边界：
 *   - 采用 line-level preserve + CSS letter-spacing（不拆 span，避免 5000 字符下的
 *     selection/diff/scroll 性能问题）。
 *   - charCount 用 Array.from(text).length（UTF-16 安全，emoji/CJK 扩展字符不被
 *     算成 2 个字符），与 Core 坐标体系一致（禁止重新引入 text.length 的码元计数错误）。
 *   - letterSpacing 由离屏 canvas 测量自然宽度后推算；canvas 字体必须与 DOM 渲染
 *     字体（含 fontWeight）一致，否则 naturalWidth 有偏差。
 *   - 溢出策略用 overflow: visible（OCR 检测框本身即 approximate，裁剪文字更严重；
 *     相邻 block 由外层绝对定位 x/y/w/h 隔离，互不侵入）。
 */

import type { CSSProperties } from "react";
import type { TextBlock } from "../types";

/** 判定一个文本块是否为 OCR 投影块（需禁止浏览器重排版）。 */
export function isOcrProjectionBlock(block: TextBlock): boolean {
  return block.type === "text" && block.source?.kind === "ocr";
}

function resolveBlockFontSize(block: TextBlock): number {
  return block.fontSize || Math.max(Math.min(block.h * 0.65, block.h - 6), 12);
}

function resolveBlockFontFamily(block: TextBlock): string {
  return block.fontFamily || "'Arial','Helvetica','SimSun','Noto Serif CJK SC',sans-serif";
}

function resolveBlockFontWeight(block: TextBlock): string {
  return block.bold ? "700" : "400";
}

/**
 * UTF-16 安全的字符计数（emoji / CJK 扩展字符算 1 个视觉字符，而非 2 个码元）。
 * 导出以便单测直接锁定「禁止用 text.length（码元计数）」的契约（用户 2d-1-B 点 3）。
 */
export function visualCharCount(text: string): number {
  return Array.from(text).length;
}

let ocrMeasureCanvas: HTMLCanvasElement | null = null;

/**
 * 用离屏 canvas 测量一段文本在给定字号/字体/字重下的自然像素宽度。
 * 字体描述必须与 DOM 渲染完全一致（含 fontWeight），否则 naturalWidth 有偏差。
 * 失败或无 DOM 环境返回 0（调用方退化为 letterSpacing = "normal"）。
 */
function measureTextWidth(
  text: string,
  fontSize: number,
  fontFamily: string,
  fontWeight: string,
): number {
  if (typeof document === "undefined") return 0;
  try {
    if (!ocrMeasureCanvas) ocrMeasureCanvas = document.createElement("canvas");
    const ctx = ocrMeasureCanvas.getContext("2d");
    if (!ctx) return 0;
    ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
    return ctx.measureText(text).width;
  } catch {
    return 0;
  }
}

/**
 * 计算 OCR 投影文本的 DOM 样式：
 *   - white-space: nowrap + word-break: keep-all → 禁止浏览器重排版（保持单行）。
 *   - 固定 lineHeight = block.h → 行高与 OCR 检测行高一致。
 *   - letter-spacing：将文本宽度按 (targetWidth - naturalWidth) / charCount 摊开，
 *     使文本视觉宽度贴合 OCR 检测宽度（不拆 span，避免 5000 字符的性能问题）。
 *   - overflow: visible → 溢出不裁剪（OCR 检测框即 approximate，裁剪更严重）。
 *   - 测量不可用时 letter-spacing 退化为 "normal"（nowrap 仍保证单行）。
 */
export function getOcrProjectionStyle(block: TextBlock): CSSProperties {
  const fontSize = resolveBlockFontSize(block);
  const fontFamily = resolveBlockFontFamily(block);
  const fontWeight = resolveBlockFontWeight(block);
  const lineHeight = `${block.h}px`;
  const count = visualCharCount(block.text);

  let letterSpacing: string = "normal";
  if (count > 0) {
    const naturalWidth = measureTextWidth(block.text, fontSize, fontFamily, fontWeight);
    if (naturalWidth > 0) {
      const ls = (block.w - naturalWidth) / count;
      // 仅在合理范围内应用（防止负值过大导致字符重叠或正值过大导致溢出过远）。
      if (Number.isFinite(ls) && ls > -fontSize * 0.5) {
        letterSpacing = `${ls}px`;
      }
    }
  }

  return {
    width: "100%",
    minHeight: "100%",
    padding: 0,
    fontSize,
    fontWeight,
    lineHeight,
    fontFamily,
    background: "#fff",
    whiteSpace: "nowrap",
    overflow: "visible",
    wordBreak: "keep-all",
    letterSpacing,
    color: block.color || "#000000",
  };
}

/**
 * 非 OCR 投影文本的 DOM 样式（pdf-native 投影 / 用户创作）：保持原 pre-wrap 行为，
 * 不受 OCR line-preserve 影响。与 getOcrProjectionStyle 共享 fontSize/fontFamily 派生逻辑。
 */
export function getDefaultBlockTextStyle(block: TextBlock): CSSProperties {
  return {
    width: "100%",
    minHeight: "100%",
    padding: 0,
    fontSize: resolveBlockFontSize(block),
    lineHeight: 1.3,
    fontFamily: resolveBlockFontFamily(block),
    background: "#fff",
    whiteSpace: "pre-wrap",
    overflow: "visible",
    wordBreak: "break-word",
    color: block.color || "#000000",
  };
}
