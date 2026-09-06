/**
 * semantic-run-builder.ts — SemanticRunBuilder（独立模块）
 *
 * Sprint-60 Task-001：Semantic Run Model
 *
 * 职责：把 OCR Block 构建成 SemanticDocumentV2（Run 为第一公民）。
 * Builder 是独立模块，不写进 OCR Adapter。
 *
 * Architecture（ADR-002/003）：
 *   OCR → SemanticRunBuilder → SemanticDocumentV2(Run) → Renderer
 *
 * Merge Gates：
 *   - 输出 Immutable（Readonly）——Builder 完成后不可修改
 *   - schemaVersion = 1
 *   - Run 内只保存稳定 ID（backgroundRegionId / sourceId），不保存 OCR 对象引用
 *
 * 第一版（Happy Path）：
 *   - 每个 OcrTextBlock → 一个 Paragraph
 *   - block.text 按换行拆成多个 Line，每 Line 一个 Run
 *   - Run 含 glyphs（逐字符，bbox 按比例分配）、visualBounds、rotation
 *   - metrics / style 空对象
 */

import type { OcrTextBlock } from "../ocr/ocr-storage";
import {
  SEMANTIC_DOCUMENT_SCHEMA_VERSION,
} from "./semantic-run";
import type {
  SemanticDocumentV2,
  SemanticRunV2,
  RunGlyph,
  RunMetrics,
  VisualCoverage,
} from "./semantic-run";

/** 构建选项 */
export interface SemanticRunBuildOptions {
  /** 文档 id（默认 "doc-<timestamp>"） */
  documentId?: string;
  /** 来源标记（默认 "ocr"） */
  source?: "ocr" | "pdf_native" | "hybrid";
}

/** 每字符 bbox 的估算函数（第一版：按字符数均分行宽） */
function splitTextIntoLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.length > 0);
}

/** 为一行文本分配 glyph bbox（第一版：均分行宽，行高 = block.h） */
function buildGlyphs(
  lineText: string,
  lineTop: number,
  blockX: number,
  blockWidth: number,
  lineHeight: number,
): RunGlyph[] {
  const chars = Array.from(lineText);
  const charWidth = chars.length > 0 ? blockWidth / chars.length : 0;
  return chars.map((char, i) => ({
    char,
    originalChar: char,
    bbox: {
      x: blockX + i * charWidth,
      y: lineTop,
      width: charWidth,
      height: lineHeight,
    },
  }));
}

/**
 * 估算 RunMetrics（Typography，Sprint-61，第一版 Happy Path）。
 *
 * 估算规则（不求精度，只建 Pipeline）：
 *   - fontSize   ≈ bbox.height
 *   - lineHeight ≈ fontSize * 1.2
 *   - baseline   ≈ fontSize * 0.8（相对行顶）
 *   - ascent     ≈ fontSize * 0.8
 *   - descent    ≈ fontSize * 0.2
 *   - advanceWidth ≈ bbox.width / 字符数
 *   - letterSpacing ≈ 0
 *
 * 字段归属：全部 Typography（ADR-004）。
 * 与 OCR 解耦：只依赖 block 的 bbox / text，不依赖 OCR 内部字段。
 */
function estimateMetrics(
  text: string,
  blockWidth: number,
  lineHeight: number,
): RunMetrics {
  const fontSize = lineHeight;
  const chars = Array.from(text).length || 1;
  return {
    fontSize,
    lineHeight: fontSize * 1.2,
    baseline: fontSize * 0.8,
    ascent: fontSize * 0.8,
    descent: fontSize * 0.2,
    advanceWidth: blockWidth / chars,
    letterSpacing: 0,
  };
}

/**
 * 从 OCR block 构建 SemanticDocumentV2（Immutable 输出）。
 *
 * @param blocks OCR block 列表（同一页）
 * @param pageIndex 页索引（1-based，与 OCR 一致）
 * @param pageWidth 页宽（CSS px）
 * @param pageHeight 页高（CSS px）
 * @param options 构建选项
 */
export function buildSemanticDocument(
  blocks: OcrTextBlock[],
  pageIndex: number,
  pageWidth: number,
  pageHeight: number,
  options: SemanticRunBuildOptions = {},
): SemanticDocumentV2 {
  const source = options.source ?? "ocr";
  const id = options.documentId ?? `doc-${Date.now()}`;

  const paragraphs = blocks.map((block) => {
    const lines = splitTextIntoLines(block.text);
    const lineCount = Math.max(lines.length, 1);
    const lineHeight = lines.length > 0 ? block.h / lines.length : block.h;

    const semanticLines = lines.map((lineText, li) => {
      const lineTop = block.y + li * lineHeight;
      const glyphs = buildGlyphs(lineText, lineTop, block.x, block.w, lineHeight);
      const run: SemanticRunV2 = {
        schemaVersion: SEMANTIC_DOCUMENT_SCHEMA_VERSION,
        id: `${block.id}-run-${li}`,
        text: lineText,
        glyphs,
        visualBounds: {
          x: block.x,
          y: lineTop,
          width: block.w,
          height: lineHeight,
        },
        visualCoverage: estimateVisualCoverage(block.x, lineTop, block.w, lineHeight),
        rotation: block.geometry?.angle ?? 0,
        metrics: estimateMetrics(lineText, block.w, lineHeight),
        style: {},
        // Merge Gate 3：只保存稳定 ID，不保存 OCR 对象引用
        backgroundRegionId: block.label,
        sourceId: block.id,
        source,
      };
      return { id: `${block.id}-line-${li}`, runs: [run] };
    });

    return { id: `${block.id}-para`, lines: semanticLines };
  });

  return {
    schemaVersion: SEMANTIC_DOCUMENT_SCHEMA_VERSION,
    id,
    pages: [
      {
        index: pageIndex,
        width: pageWidth,
        height: pageHeight,
        paragraphs,
      },
    ],
  };
}

/**
 * 估算 VisualCoverage（Coverage Domain，Sprint-62，第一版 Happy Path）。
 *
 * 第一版规则：
 *   - maskBounds  = OCR block bbox（原始，盖 OCR 检测到的文字）
 *   - patchBounds = OCR block bbox（原始）
 *   - coverageBounds = 扩展后的范围（按字符高度 padding，盖住 OCR bbox 外的
 *                      衬线/倾斜/笔画延伸 —— 解决 FID-010 覆盖不足）
 *   - confidence = 估算 0.9（Semantic，Sprint 后续可基于像素检测细化）
 *
 * 字段归属：maskBounds/patchBounds/coverageBounds → Geometry；confidence → Semantic。
 */
function estimateVisualCoverage(
  blockX: number,
  blockY: number,
  blockW: number,
  blockH: number,
): VisualCoverage {
  const maskBounds = { x: blockX, y: blockY, width: blockW, height: blockH };
  const patchBounds = { x: blockX, y: blockY, width: blockW, height: blockH };
  // 扩展范围：按字符高度比例 padding（FID-010 覆盖不足的根治，纳入语义模型）
  const padX = blockH * 0.15;
  const padY = blockH * 0.15;
  const coverageBounds = {
    x: blockX - padX,
    y: blockY - padY,
    width: blockW + padX * 2,
    height: blockH + padY * 2,
  };
  return {
    maskBounds,
    patchBounds,
    coverageBounds,
    confidence: 0.9,
  };
}

/** 便捷：从单个 OCR block 构建单个 Run（第一版单一 run） */
export function buildRunFromBlock(
  block: OcrTextBlock,
  source: "ocr" | "pdf_native" | "hybrid" = "ocr",
): SemanticRunV2 {
  const firstLine = splitTextIntoLines(block.text)[0] ?? "";
  const glyphs = buildGlyphs(firstLine, block.y, block.x, block.w, block.h);
  return {
    schemaVersion: SEMANTIC_DOCUMENT_SCHEMA_VERSION,
    id: `${block.id}-run`,
    text: firstLine,
    glyphs,
    visualBounds: { x: block.x, y: block.y, width: block.w, height: block.h },
    visualCoverage: estimateVisualCoverage(block.x, block.y, block.w, block.h),
    rotation: block.geometry?.angle ?? 0,
    metrics: estimateMetrics(firstLine, block.w, block.h),
    style: {},
    backgroundRegionId: block.label,
    sourceId: block.id,
    source,
  };
}

/** 供测试/调试用的纯函数（导出行拆分） */
export function _splitTextIntoLines(text: string): string[] {
  return splitTextIntoLines(text);
}
