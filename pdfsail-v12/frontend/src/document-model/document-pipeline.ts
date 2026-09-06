/**
 * DocumentPipeline — Sprint36 · Commit 2B-1 / 2B-3 / 2C（Revised）
 *
 * 【One Business Entry Rule】
 *   整个业务只有一个入口：Document Pipeline。
 *
 *   - Document Pipeline 是【业务入口】，不是技术入口（非 Geometry/OCR/Export Pipeline）。
 *   - PDFEditor 只触发 Pipeline，不拥有 Pipeline 内部逻辑。
 *   - OCR / Rule / Geometry / Renderer / Export 都从这里开始。
 *
 * 【Ownership（CTO Commit 2C 修正）】
 *   - DocumentPipeline        ：Business Flow Owner
 *   - GeometryDecisionAdapter ：Geometry Language Owner（产出 GeometryRequest）
 *   - FakeGeometry / Geometry ：Geometry Consumer
 *
 *   DocumentPipeline 只 orchestrate，不拥有 GeometryRequest。
 *   GeometryRequest 是 Geometry 世界的语言，不属于 DocumentPipelineOutput。
 *
 * 【Commit 2B-3】Document Pipeline 第一次成功产出 ProcessingDecisionList。
 * 【Commit 2C】协调 GeometryDecisionAdapter，把 GeometryRequest 交给 Geometry Consumer。
 *
 *   DocumentPipelineInput
 *        ↓
 *   VisualSemanticMapper → VisualSemantic → DecisionContext
 *        ↓
 *   DecisionResolver → ProcessingDecisionList
 *        ↓
 *   GeometryDecisionAdapter → GeometryRequest[]
 *        ↓
 *   Geometry Consumer（Fake/Real Geometry）
 */

import type { OcrTextBlock } from "../ocr/ocr-storage";
import type { VisualSemanticMapper } from "./visual-semantic-mapper";
import { DefaultVisualSemanticMapper } from "./visual-semantic-mapper";
import type { ProcessingDecisionResolver } from "./resolver/processing-decision-resolver";
import { DefaultProcessingDecisionResolver } from "./resolver/default-processing-decision-resolver";
import { IgnoreUnknownRule } from "./resolver/ignore-unknown-rule";
import { SignatureRule } from "./resolver/signature-rule";
import type { ProcessingDecisionList } from "./processing-decision";
import type { EngineCapability } from "./engine-capability";
import { DefaultCapabilityProfile } from "./engine-capability";
import { VisualObjectType } from "./visual-semantic";
import {
  GeometryDecisionAdapter,
  GeometryTargetKind,
  type GeometryRequest,
  type DecisionWithContext,
} from "./geometry-decision-adapter";

/**
 * Document Pipeline 输入 — 业务入口的输入。
 *
 * ⚠️ Sprint36 Vertical Slice only. Business model will be introduced later.
 *    这是【Temporary Vertical Slice Input】，不是已冻结的 Business Model。
 *
 * 当前用 ocrBlocks（Mapper 的原料）验证链路；未来真正的 Business Input
 * 可能是 Upload / Clipboard / Database / Workflow / API / Agent。
 * 不要让类型名字冻结未来 —— Document Pipeline 是 Business Entry，不是 OCR Entry。
 */
export interface DocumentPipelineInput {
  /** OCR blocks（当前 Vertical Slice 临时原料来源） */
  ocrBlocks: OcrTextBlock[];
}

/**
 * Document Pipeline 输出 — 业务入口的业务结果。
 *
 * 只包含 Document 世界的业务结果（decisions）。
 * GeometryRequest 属于 Geometry 世界，由 Geometry Consumer 消费，
 * 【不】出现在本 Output 中（Ownership 边界）。
 */
export interface DocumentPipelineOutput {
  /** 处理决策列表（Document 业务结果） */
  decisions: ProcessingDecisionList;
}

/**
 * Geometry Batch — 一批 GeometryRequest（含未来扩展位）。
 *
 * 用 Batch 而非裸数组，避免未来参数膨胀：
 *   consume(requests, page, trace, ...)   ← 禁止
 *   consume(batch)                        ← 正确
 *
 * 未来可扩展：pageNumber / documentId / traceId / requestId ...
 * （作为 Geometry 世界的 Batch 元数据，而非回调参数）
 */
export interface GeometryBatch {
  /** Geometry 请求列表（只读） */
  requests: readonly GeometryRequest[];
}

/**
 * Geometry Consumer — 消费 Adapter 产出的 Geometry Batch（Infrastructure Port）。
 *
 * 这是【Port】，不是匿名回调。Logging/Real/Worker/Remote Geometry 全部实现 consume()，
 * 保持一致接入方式，避免回调参数膨胀成 Service Locator。
 *
 * 属于 Infrastructure Port，不是 Engine / Domain。
 */
export interface GeometryConsumer {
  /** 消费一批 GeometryRequest */
  consume(batch: GeometryBatch): void;
}

/**
 * Document Pipeline 契约 — 唯一业务入口。
 */
export interface DocumentPipeline {
  /**
   * 处理一份文档（Business Entry）。
   *
   * 把 OCR blocks 映射为 VisualSemantic，经 DecisionResolver 产出
   * ProcessingDecisionList，再协调 GeometryDecisionAdapter 把
   * GeometryRequest 交给 Geometry Consumer。
   */
  process(input: DocumentPipelineInput): DocumentPipelineOutput;
}

/** 依赖注入的 Resolver 工厂（默认使用 DefaultProcessingDecisionResolver） */
export type ProcessingDecisionResolverFactory = () => ProcessingDecisionResolver;

/**
 * 创建默认 Document Pipeline。
 *
 * @param mapper             VisualSemanticMapper（默认 DefaultVisualSemanticMapper）
 * @param resolverFactory    DecisionResolver 工厂（默认组装 SignatureRule + IgnoreUnknownRule）
 * @param capabilityProvider capability 提供（默认 DefaultCapabilityProfile 查表）
 * @param geometryConsumer   GeometryRequest 消费者（默认 console 日志）
 */
export function createDocumentPipeline(
  mapper: VisualSemanticMapper = DefaultVisualSemanticMapper,
  resolverFactory: ProcessingDecisionResolverFactory = () =>
    DefaultProcessingDecisionResolver({
      getRules() {
        return [IgnoreUnknownRule, SignatureRule];
      },
    }),
  capabilityProvider: (objectType: VisualObjectType) => EngineCapability = (ot) =>
    DefaultCapabilityProfile[ot],
  geometryConsumer: GeometryConsumer = {
    // 默认 Port 实现：仅打印（Commit 2D Logging Geometry 可替换）
    consume(batch: GeometryBatch) {
      if (batch.requests.length > 0) {
        console.log("[DocumentPipeline][Geometry]", batch.requests);
      }
    },
  },
): DocumentPipeline {
  const resolver = resolverFactory();

  return {
    process(input: DocumentPipelineInput): DocumentPipelineOutput {
      // DocumentPipeline orchestrates business flow only.
      // Never implement business rules here.
      // Business rules belong to DecisionRule.
      // （禁止在 Pipeline 内写 if(isSignature) / if(decision.type===...)，
      //   否则 Pipeline 会重新长成第二个 PDFEditor。）
      const decisionWithContexts: DecisionWithContext[] = [];

      for (const block of input.ocrBlocks) {
        const semantic = mapper.map(block);
        const capability = capabilityProvider(semantic.objectType);
        const context = { semantic, capability };
        const result = resolver.resolve(context);
        for (const decision of result.decisions) {
          decisionWithContexts.push({
            decision,
            context,
            target: { id: block.id, kind: GeometryTargetKind.Block },
          });
        }
      }

      // Pipeline 协调 Adapter，把 GeometryRequest 装进 Batch 交给 Geometry Consumer（Port）
      // （Pipeline 不拥有 GeometryRequest，只 orchestrate）
      const geometryRequests = GeometryDecisionAdapter.adapt(decisionWithContexts);
      geometryConsumer.consume({ requests: geometryRequests });

      return {
        decisions: { decisions: decisionWithContexts.map((d) => d.decision) },
      };
    },
  };
}

/**
 * 默认 Document Pipeline 实例。
 *
 * 组装：Mapper + Resolver（含 IgnoreUnknownRule + SignatureRule）+ Capability 查表 + Geometry Adapter。
 */
export const DefaultDocumentPipeline: DocumentPipeline = createDocumentPipeline();
