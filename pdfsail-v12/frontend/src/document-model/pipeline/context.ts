/**
 * PipelineContext — OCR Post Processing Pipeline V1（Sprint-47/48 Architecture Freeze）
 *
 * 统一数据结构：各层不自行拼参数，统一读写 Context。
 *
 * 职责边界：
 *   - Detector   写 ctx.semantic[blockId]，不改 blocks
 *   - Normalizer 读 ctx.semantic[blockId] + 改 ctx.blocks
 *   - Geometry   写 ctx.cache.geometry
 *   - Debug      各层追加 ctx.debug.timeline
 */
import type { OcrTextBlock } from "../../ocr/ocr-storage";

/** 执行阶段 */
export enum Stage {
  OCR = "OCR",
  Geometry = "Geometry",
  Semantic = "Semantic",
  Normalize = "Normalize",
  Editable = "Editable",
}

/** 停止语义：Continue 继续下一插件 / Skip 跳过本 block 后续 / Abort 中止整个 Pipeline */
export type StopAction = "Continue" | "Skip" | "Abort";

/** 错误语义：Recoverable 保留原 block 继续 / Fatal 中止整个 Pipeline */
export type ErrorSeverity = "Recoverable" | "Fatal";

/** 几何信息（Geometry Pipeline 产出） */
export interface GeometryInfo {
  angle: number;
  transform?: number[];
  rotation?: number;
  bbox?: { x: number; y: number; w: number; h: number };
}

/** 语义结果（Semantic Pipeline 产出） */
export interface SemanticResult {
  type: string; // "signature" | "table" | "stamp" | "header" | "footer" | ...
  score: number;
  threshold: number;
  reasons: string[];
}

/** Trace 节点（Debug Timeline） */
export interface TraceNode {
  blockId: string;
  stage: Stage;
  detail: string;
  ts: number;
}

/** PipelineContext — 整个 Pipeline 共享的数据结构 */
export interface PipelineContext {
  page: { index: number; width: number; height: number };
  blocks: OcrTextBlock[];
  cache: {
    geometry: Record<string, GeometryInfo>;
    semantic: Record<string, SemanticResult>;
  };
  debug: {
    timeline: TraceNode[];
  };
  stage: Stage;
}

/** 创建一个空的 PipelineContext */
export function createPipelineContext(page: PipelineContext["page"], blocks: OcrTextBlock[]): PipelineContext {
  return {
    page,
    blocks,
    cache: { geometry: {}, semantic: {} },
    debug: { timeline: [] },
    stage: Stage.OCR,
  };
}

/** 追加 Debug Trace */
export function trace(ctx: PipelineContext, blockId: string, stage: Stage, detail: string): void {
  ctx.debug.timeline.push({ blockId, stage, detail, ts: Date.now() });
}
