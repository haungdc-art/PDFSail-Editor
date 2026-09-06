/**
 * Layout Engine — 文本换行引擎
 *
 * 类似浏览器 measureText + wrap 的逻辑：
 * 输入文本 + 样式 + 最大宽度 → 输出每行文本及其宽度
 *
 * 核心用途：
 *   1. Line Detection: 把 OCR 段落拆成行级 TextBlock
 *   2. Text Replacement: 用户修改文本后重新换行
 */

import type { LineInfo, TextStyle } from "./types";

/** 共享 canvas，避免每次创建 */
let _measureCanvas: HTMLCanvasElement | null = null;

function getMeasureCtx(): CanvasRenderingContext2D {
  if (!_measureCanvas) {
    _measureCanvas = document.createElement("canvas");
  }
  return _measureCanvas.getContext("2d")!;
}

/**
 * 构建字体字符串
 */
function fontString(style: TextStyle): string {
  const weight = style.fontWeight || "normal";
  const size = style.fontSize;
  const family = style.fontFamily || '"Noto Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif';
  return `${weight} ${size}px ${family}`;
}

/**
 * 测量文本宽度
 */
export function measureText(text: string, style: TextStyle): number {
  const ctx = getMeasureCtx();
  ctx.font = fontString(style);
  return ctx.measureText(text).width;
}

/**
 * 把文本按 maxWidth 换行，返回行列表
 *
 * 算法：
 *   1. 先按换行符分割（保留原始换行）
 *   2. 对每段，逐字符/逐词测量，超出 maxWidth 时断行
 *   3. 中文逐字断行，英文按空格断行
 *
 * @param text 原始文本
 * @param style 字体样式
 * @param maxWidth 最大宽度（CSS px）
 * @returns LineInfo[] 每行的文本和宽度
 */
export function wrapText(
  text: string,
  style: TextStyle,
  maxWidth: number
): LineInfo[] {
  if (!text || maxWidth <= 0) return [];

  const ctx = getMeasureCtx();
  ctx.font = fontString(style);
  const lineHeight = style.lineHeight || style.fontSize * 1.3;

  const lines: LineInfo[] = [];

  // Step 1: 按换行符分割
  const paragraphs = text.split("\n");

  for (const para of paragraphs) {
    if (!para) {
      // 空行
      lines.push({ text: "", width: 0, x: 0, y: 0, height: lineHeight });
      continue;
    }

    // Step 2: 逐字符测量断行
    let currentLine = "";
    let currentWidth = 0;

    for (let i = 0; i < para.length; i++) {
      const ch = para[i];
      const testLine = currentLine + ch;
      const testWidth = ctx.measureText(testLine).width;

      if (testWidth > maxWidth && currentLine) {
        // 当前行已满，保存并开始新行
        lines.push({
          text: currentLine,
          width: currentWidth,
          x: 0,
          y: 0,
          height: lineHeight,
        });
        currentLine = ch;
        currentWidth = ctx.measureText(ch).width;
      } else {
        currentLine = testLine;
        currentWidth = testWidth;
      }
    }

    // 最后一行
    if (currentLine) {
      lines.push({
        text: currentLine,
        width: currentWidth,
        x: 0,
        y: 0,
        height: lineHeight,
      });
    }
  }

  return lines;
}

/**
 * 估算段落包含的行数
 */
export function estimateLineCount(
  text: string,
  style: TextStyle,
  maxWidth: number
): number {
  return wrapText(text, style, maxWidth).length;
}
