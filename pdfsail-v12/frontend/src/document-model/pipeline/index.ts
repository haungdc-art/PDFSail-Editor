/**
 * OCR Post Processing Pipeline V1 — 统一入口（Sprint-48 Migration Foundation）
 *
 * 原则：Zero Behavior Change（行为零变化）。
 *   - Pipeline 骨架立起来，但内部全部调用旧函数，不重写。
 *   - normalizeSignatureLayout / Rule2 / detectGeometry 逻辑不变。
 *   - 本轮只注册 SplitNormalizer（包装 normalizeSignatureLayout），不实现任何 Detector。
 *
 * Feature Flag：
 *   OCR_PIPELINE_V2=false（默认）→ 旧流程
 *   OCR_PIPELINE_V2=true       → 新 Pipeline（目前仅 SplitNormalizer 包装，行为一致）
 */
import type { OcrTextBlock } from "../../ocr/ocr-storage";
import { createPipelineContext } from "./context";
import { PipelineRegistry } from "./registry";
import { PipelineExecutor } from "./executor";
import { SplitNormalizer } from "./split-normalizer";
export { createPipelineContext, Stage, trace } from "./context";
export type { PipelineContext, StopAction, ErrorSeverity, GeometryInfo, SemanticResult, TraceNode } from "./context";
export { PipelineRegistry } from "./registry";
export type { PipelineDetector, PipelineNormalizer } from "./registry";
export { PipelineExecutor } from "./executor";
export type { PipelineExecutionResult, GeometryRunner } from "./executor";
export { SplitNormalizer } from "./split-normalizer";
export type { SplitNormalizerOptions } from "./split-normalizer";

/**
 * Feature Flag（Sprint-48 Task-006）
 *   false（默认）：旧流程
 *   true（灰度）：新 Pipeline（当前仅 SplitNormalizer 包装 normalizeSignatureLayout，行为一致）
 * 任何时刻可回滚。
 */
export const OCR_PIPELINE_V2: boolean = false;

/**
 * 组装新 Pipeline 的工厂。
 * 本轮只注册 SplitNormalizer（Task-003），不实现 Detector。
 */
export function createPipeline(pageHeight: number, ocrRatio: number) {
  const registry = new PipelineRegistry();
  registry.registerNormalizer(new SplitNormalizer({ pageHeight, ocrRatio, enabled: OCR_PIPELINE_V2 }));
  return new PipelineExecutor(registry);
}

/**
 * Sprint-49A 接线辅助：通过 Pipeline（SplitNormalizer）对 OCR blocks 执行签名归一。
 *
 * 等价于 PDFEditor 旧 flatMap 循环（行为完全一致，因为 SplitNormalizer 内部调用 normalizeSignatureLayout）：
 *   const normalizedBlocks = [];
 *   for (const b of blocks) {
 *     const r = normalizeSignatureLayout(b, pageHeight, ocrRatio);
 *     normalizedBlocks.push(...r.blocks);
 *   }
 *
 * ⚠️ 只供 OCR_PIPELINE_V2=true 时使用。false 时 PDFEditor 仍走旧流程。
 */
export function normalizeSignatureBlocks(
  blocks: OcrTextBlock[],
  pageHeight: number,
  ocrRatio: number,
): OcrTextBlock[] {
  const ctx = createPipelineContext({ index: 0, width: 0, height: pageHeight }, blocks);
  const registry = new PipelineRegistry();
  registry.registerNormalizer(new SplitNormalizer({ pageHeight, ocrRatio, enabled: true }));
  const executor = new PipelineExecutor(registry);
  const result = executor.execute(ctx);
  return result.blocks;
}
