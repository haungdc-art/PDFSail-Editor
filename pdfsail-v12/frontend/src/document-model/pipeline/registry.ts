/**
 * PipelineRegistry — OCR Post Processing Pipeline V1（Sprint-47/48 Architecture Freeze）
 *
 * 插件注册机制：新增能力 = registerDetector / registerNormalizer，不改 Pipeline 控制流。
 * Detector / Normalizer 按 priority 排序执行。
 */
import type { PipelineContext, StopAction } from "./context";

/** 统一的 Detector 插件接口 */
export interface PipelineDetector {
  id: string; // "signature" | "table" | "stamp" | ...
  priority: number; // 越小越先执行
  stage: "semantic"; // 属于 Semantic Pipeline
  detect(ctx: PipelineContext): StopAction; // 写 ctx.semantic[blockId]
}

/** 统一的 Normalizer 插件接口 */
export interface PipelineNormalizer {
  id: string; // "split" | "merge" | "rotation" | "paragraph" | ...
  priority: number;
  stage: "normalize"; // 属于 Normalization Pipeline
  process(ctx: PipelineContext): StopAction; // 读 semantic + 改 blocks
}

/**
 * PipelineRegistry — 注册与调度 Detector / Normalizer。
 * 不实现业务逻辑，只负责收集插件并按 priority 排序。
 */
export class PipelineRegistry {
  private detectors: PipelineDetector[] = [];
  private normalizers: PipelineNormalizer[] = [];

  registerDetector(d: PipelineDetector): void {
    this.detectors.push(d);
    this.detectors.sort((a, b) => a.priority - b.priority);
  }

  registerNormalizer(n: PipelineNormalizer): void {
    this.normalizers.push(n);
    this.normalizers.sort((a, b) => a.priority - b.priority);
  }

  /** 按 priority 执行所有 Semantic Detector */
  runDetectors(ctx: PipelineContext): StopAction {
    let action: StopAction = "Continue";
    for (const d of this.detectors) {
      const a = d.detect(ctx);
      if (a === "Abort") return "Abort";
      if (a === "Skip") action = "Skip";
    }
    return action;
  }

  /** 按 priority 执行所有 Normalizer */
  runNormalizers(ctx: PipelineContext): StopAction {
    let action: StopAction = "Continue";
    for (const n of this.normalizers) {
      const a = n.process(ctx);
      if (a === "Abort") return "Abort";
      if (a === "Skip") action = "Skip";
    }
    return action;
  }
}
