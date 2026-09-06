/**
 * GeometryDecisionAdapter — Sprint36 · Story-1 Commit 1（Revised）
 *
 * 【Business Adapter Rule】
 *   任何 Engine（Geometry/OCR/Renderer/Export）不得直接消费 Rule 或 Decision，
 *   必须经过 Adapter：
 *
 *     Decision
 *        ↓
 *     Adapter（本文件）
 *        ↓
 *     GeometryRequest → Geometry Engine
 *
 * 职责：把 ProcessingDecision 翻译成 Geometry 能消费的请求。
 *
 *   ProcessingDecision[]（含 context + targetId）
 *        ↓
 *   GeometryDecisionAdapter
 *        ↓
 *   GeometryRequest[]
 *
 * 【Revised 说明】
 *   - 不暴露 Pipeline 概念：用 targetId（不叫 blockId），Rule Engine 只知 Visual Object。
 *   - 不输出 GeometryStrategy：用 geometryKind（signature/stamp），不绑定 Geometry 内部枚举。
 *   - 去掉 needGeometry：能生成 Request 本身就是 Need（重复信息）。
 *   - 去掉 reasonCode：Geometry 不需要 Business Reason。
 *   - target 支持 block / region（Composite Signature Region 需要 target，而非单一 block）。
 *
 * 【本 Commit 只新增 Adapter，不改 Geometry Pipeline，不接线。】
 */

import type { VisualObjectType } from "./visual-semantic";
import { VisualObjectType as VO } from "./visual-semantic";
import type { DecisionContext } from "./decision-context";
import type { ProcessingDecision } from "./processing-decision";

/**
 * Geometry 目标种类（GeometryTargetKind） — 枚举，非字符串。
 *
 * 使用枚举便于扩展（Paragraph / Composite / Table / Field / Layer / Mask ...），
 * 避免字符串散落。目前支持：
 *   - Block  ：单个 OCR block
 *   - Region ：复合区域（如 Composite Signature Region，由多个 block 合并）
 */
export enum GeometryTargetKind {
  Block = "block",
  Region = "region",
}

/**
 * Geometry 目标 — 指向一个需要几何分析的视觉对象。
 *
 * 不绑定 Pipeline 概念：
 *   - Rule Engine 只知道 Visual Object（target.id + target.kind），
 *   - 不知道它是 block（OCR）/ region（Layout）/ page（Document）。
 */
export interface GeometryTarget {
  /** 目标 id（block id 或 region id，由接线方决定） */
  id: string;
  /** 目标种类（枚举，可扩展） */
  kind: GeometryTargetKind;
}

/**
 * Geometry 请求 — Adapter 翻译后的产物，Geometry Engine 可消费。
 *
 * 只有两个字段：target + geometryKind。
 *   - target：对哪个对象做几何分析
 *   - geometryKind：做什么类型的几何分析
 *
 * Geometry Engine 不知道 Rule / Decision / Business Reason，只消费本请求。
 */
export interface GeometryRequest {
  /** 几何分析目标 */
  target: GeometryTarget;
  /** 几何分析类型（signature / stamp / ...） */
  geometryKind: "signature" | "stamp" | "none";
}

/**
 * 一个决策及其上下文 + 目标。
 *
 * Adapter 需要 semantic.objectType 才能把引擎无关的 DecisionType
 * 翻译成 geometryKind。
 *
 * target 由接线方（未来 PDFEditor）提供，指向该决策对应的视觉对象。
 */
export interface DecisionWithContext {
  /** 处理决策（引擎无关意图） */
  decision: ProcessingDecision;
  /** 该决策对应的上下文（含 semantic.objectType 等） */
  context: DecisionContext;
  /** 该决策对应的几何目标 */
  target: GeometryTarget;
}

/**
 * 把 DecisionType 翻译为是否需要几何分析。
 *
 *   - analyze_visual → 需要
 *   - decode / ignore / analyze_ocr / extract_structure / composite → 不需要
 */
function decisionNeedsGeometry(type: string): boolean {
  return type === "analyze_visual";
}

/**
 * 根据对象类型，翻译 geometryKind。
 *
 *   - Signature → "signature"（签名笔迹几何）
 *   - Stamp     → "stamp"（印章几何）
 *   - 其他      → "none"（Geometry 不分析）
 */
function translateGeometryKind(objectType: VisualObjectType): "signature" | "stamp" | "none" {
  switch (objectType) {
    case VO.Signature:
      return "signature";
    case VO.Stamp:
      return "stamp";
    default:
      return "none";
  }
}

/**
 * GeometryDecisionAdapter 实现（纯函数，Stateless）。
 */
export const GeometryDecisionAdapter = {
  /**
   * 把带上下文的决策列表翻译为 GeometryRequest 列表。
   *
   * @param items 带上下文的决策列表（含 target）
   * @returns Geometry 请求列表（Geometry 可消费）
   */
  adapt(items: DecisionWithContext[]): GeometryRequest[] {
    const requests: GeometryRequest[] = [];

    for (const item of items) {
      // 决策无需几何分析 → 跳过
      if (!decisionNeedsGeometry(item.decision.type)) {
        continue;
      }
      const geometryKind = translateGeometryKind(item.context.semantic.objectType);
      if (geometryKind === "none") {
        continue;
      }
      requests.push({
        target: item.target,
        geometryKind,
      });
    }

    return requests;
  },
};
