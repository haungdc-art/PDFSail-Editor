/**
 * SplitNormalizer — OCR Post Processing Pipeline V1（Sprint-48 Migration Foundation）
 *
 * Task-004：把 normalizeSignatureLayout 包装为 Pipeline Normalizer 插件。
 * 【只搬家不改逻辑 / Adapter，不复制代码】——内部调用现有 normalizeSignatureLayout，行为完全一致。
 *
 * 行为一致保障（Zero Behavior Change）：
 *   - 对 ctx.blocks 中每个 block 调用 normalizeSignatureLayout(block, pageHeight, ocrRatio)
 *   - changed=true → 用返回的新 blocks 替换（flatMap 模式，旧 block 不进入下一步）
 *   - changed=false → 保留原 block
 *
 * ⚠️ 不修改 normalizeSignatureLayout 的任何逻辑。判定仍由其内部完成（本轮不实现 Detector）。
 */
import type { OcrTextBlock } from "../../ocr/ocr-storage";
import { normalizeSignatureLayout } from "../signature-layout-normalizer";
import type { PipelineNormalizer } from "./registry";
import type { PipelineContext, StopAction } from "./context";
import { Stage, trace } from "./context";

export interface SplitNormalizerOptions {
  /** 页面高度（scale=1.5 空间） */
  pageHeight: number;
  /** OCR ratio（2.0/1.5），normalizeSignatureLayout 用它转 _ocrCanvasBbox */
  ocrRatio: number;
  /** 是否启用。false 时 Normalizer 直接跳过（Feature Flag 灰度用） */
  enabled?: boolean;
  /** 是否打印 Debug Trace（最小版，Task-005） */
  debug?: boolean;
}

/**
 * 包装 normalizeSignatureLayout 为 SplitNormalizer（Adapter）。
 *
 * 与原 PDFEditor 调用完全一致：
 *   const r = normalizeSignatureLayout(b, pageHeightEditor, ocrRatio);
 *   if (r.changed) { ... }
 *   normalizedBlocks.push(...r.blocks);
 */
export class SplitNormalizer implements PipelineNormalizer {
  id = "split";
  priority = 10;
  stage = "normalize" as const;

  constructor(private readonly options: SplitNormalizerOptions) {}

  process(ctx: PipelineContext): StopAction {
    if (this.options.enabled === false) return "Continue";

    const debug = this.options.debug ?? false;
    if (debug) console.log("[Pipeline] Run SplitNormalizer");

    const out: OcrTextBlock[] = [];
    for (const b of ctx.blocks) {
      const r = normalizeSignatureLayout(b, this.options.pageHeight, this.options.ocrRatio);
      if (debug) {
        console.log(`[Pipeline]   Block: ${b.text.slice(0, 30)}...  Result: ${r.changed ? "Split(" + r.blocks.length + ")" : "Keep"}`);
      }
      if (r.changed) {
        trace(ctx, b.id, Stage.Normalize, `Split into ${r.blocks.length} blocks`);
      }
      out.push(...r.blocks);
    }
    ctx.blocks = out;

    if (debug) console.log("[Pipeline] Done");
    return "Continue";
  }
}
