/**
 * PipelineExecutor — OCR Post Processing Pipeline V1（Sprint-47/48 Architecture Freeze）
 *
 * 谁驱动：Executor 编排整个 Pipeline（Geometry → Semantic → Normalization）。
 * 不实现业务逻辑，只负责顺序 / Stop / Error / Debug Timeline。
 */
import type { PipelineContext, StopAction, ErrorSeverity, TraceNode } from "./context";
import { Stage, trace } from "./context";
import { PipelineRegistry } from "./registry";

/** Geometry Pipeline 钩子（当前项目已有 geometry-detector，可在此编排） */
export type GeometryRunner = (ctx: PipelineContext) => void;

/** 执行结果 */
export interface PipelineExecutionResult {
  blocks: PipelineContext["blocks"];
  timeline: TraceNode[];
  aborted: boolean;
}

/**
 * PipelineExecutor — 编排 Geometry → Semantic → Normalization。
 *
 * 用法：
 *   const registry = new PipelineRegistry();
 *   registry.registerDetector(signatureDetector);
 *   registry.registerNormalizer(splitNormalizer);
 *   const executor = new PipelineExecutor(registry);
 *   const result = executor.execute(ctx);
 */
export class PipelineExecutor {
  constructor(
    private readonly registry: PipelineRegistry,
    private readonly geometryRunner?: GeometryRunner,
  ) {}

  execute(ctx: PipelineContext): PipelineExecutionResult {
    ctx.stage = Stage.Geometry;
    if (this.geometryRunner) {
      try {
        this.geometryRunner(ctx);
      } catch (e) {
        // Error Policy（Recoverable）：Geometry 失败 → 保留原 block，继续
        trace(ctx, "*", Stage.Geometry, `Geometry error (recoverable): ${(e as Error).message}`);
      }
    }

    // Semantic
    ctx.stage = Stage.Semantic;
    let action: StopAction;
    try {
      action = this.registry.runDetectors(ctx);
    } catch (e) {
      trace(ctx, "*", Stage.Semantic, `Semantic error: ${(e as Error).message}`);
      action = "Continue";
    }
    if (action === "Abort") {
      return { blocks: ctx.blocks, timeline: ctx.debug.timeline, aborted: true };
    }

    // Normalization
    ctx.stage = Stage.Normalize;
    try {
      action = this.registry.runNormalizers(ctx);
    } catch (e) {
      trace(ctx, "*", Stage.Normalize, `Normalizer error: ${(e as Error).message}`);
      action = "Continue";
    }
    if (action === "Abort") {
      return { blocks: ctx.blocks, timeline: ctx.debug.timeline, aborted: true };
    }

    ctx.stage = Stage.Editable;
    return { blocks: ctx.blocks, timeline: ctx.debug.timeline, aborted: false };
  }
}
