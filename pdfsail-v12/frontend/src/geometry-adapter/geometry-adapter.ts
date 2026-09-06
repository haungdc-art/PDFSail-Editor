/**
 * geometry-adapter.ts — GeometryAdapter（Sprint-67 Task-002）
 *
 * 目的：把 Geometry Ownership 从 DocumentRenderer 抽离。
 *
 * PM Architecture Decision（Sprint-67 修正）：
 *   以前：Semantic → DocumentRenderer → resolve() → DrawRect
 *   以后：Semantic → GeometryAdapter → GeometryResult → DocumentRenderer → paint
 *
 * PM Rule-012：Migrate Ownership before Migrate Rendering。
 *   先迁"谁拥有数据"（Geometry 计算），再迁"谁画数据"（Rendering）。
 *   本任务只迁 Ownership：DocumentRenderer 不再 calculate，只 consume GeometryAdapter。
 *
 * 关键（PM 裁决）：
 *   - GeometryAdapter 是 Geometry Ownership 的唯一位置
 *   - `resolveVisualCoverageBounds` / `calculateReplacementMaskBounds` 迁入本 Adapter
 *   - DocumentRenderer 只消费 GeometryResult，不再自己算 mask/patch/rect 几何
 *   - Renderer（GlyphRenderer / BackgroundPatchLayer）零修改
 *
 * 过渡说明（Task-002 阶段）：
 *   DocumentRenderer 当前数据源是 EditableBlock（非 Semantic Run）。
 *   因此 GeometryAdapter 当前从 EditableBlock（originalBounds + rotation）解析几何。
 *   未来 Task-003+ 切换输入源为 Semantic visualCoverage 时，只需改本 Adapter 的
 *   输入解析，DocumentRenderer / Renderer 不变。这正是 "先迁 Ownership，再迁数据源"。
 *
 * Pure Function（ADR-005）：输入 EditableBlock，输出 GeometryResult[]。
 * 不依赖 DOM / Canvas / Renderer。
 */

import type { BBox } from "../document-model/types";
import type { EditableBlock } from "../document-model/types";
import type { SemanticRunV2 } from "../document-model-v2/semantic-run";
import {
  resolveVisualCoverageBounds,
  calculateReplacementMaskBounds,
} from "../document-model/signature-mask-geometry";

/** Mask 几何（白色遮盖原文） */
export interface MaskGeometry {
  readonly kind: "mask";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly blockId: string;
  /** 生成方式（coverage 解析） */
  readonly source: "coverage";
}

/** Patch 几何（签名背景恢复区域，将来承载 patch 图像） */
export interface PatchGeometry {
  readonly kind: "patch";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly blockId: string;
  /** 所属区域 id */
  readonly regionId?: string;
}

/** Rect 几何（像素级覆盖，旧架构兼容） */
export interface RectGeometry {
  readonly kind: "rect";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly blockId: string;
  readonly fill: string;
  readonly opacity: number;
}

/** GeometryResult 联合类型 */
export type GeometryResult = MaskGeometry | PatchGeometry | RectGeometry;

/**
 * 为单个 EditableBlock 解析 Mask 几何。
 *
 * 封装了原来的：
 *   coverageBounds = resolveVisualCoverageBounds(block.originalBounds)     ← 迁入
 *   maskBounds     = calculateReplacementMaskBounds({ originalBounds: coverageBounds, rotation })  ← 迁入
 *
 * 输入：
 *   - block.originalBounds（OCR 检测框）
 *   - rotation（CSS 旋转角度，来自 rotationMap 或 block.transform.rotation）
 *
 * 输出：MaskGeometry（扩展后的视觉覆盖 + 旋转包围盒）
 *
 * 无 originalBounds 时返回 null（无可遮盖区域）。
 */
export function resolveMaskGeometry(
  block: EditableBlock,
  rotation: number,
): MaskGeometry | null {
  if (!block.originalBounds) return null;
  const coverageBounds = resolveVisualCoverageBounds(block.originalBounds);
  const maskBounds = calculateReplacementMaskBounds({
    originalBounds: coverageBounds,
    rotation,
  });
  return {
    kind: "mask",
    x: maskBounds.x,
    y: maskBounds.y,
    width: maskBounds.width,
    height: maskBounds.height,
    blockId: block.id,
    source: "coverage",
  };
}

/**
 * 解析单个 block 的全部 Geometry（mask / patch / rect）。
 *
 * 当前（Task-002）只实现 mask（document-renderer 唯一实际生成的 Geometry）。
 * PatchGeometry / RectGeometry 建立类型，接入留到 Task-003（Patch）/ Task-004。
 *
 * @param block EditableBlock
 * @param rotation CSS 旋转角度
 * @returns GeometryResult[]
 */
export function resolveBlockGeometry(
  block: EditableBlock,
  rotation: number,
): GeometryResult[] {
  const results: GeometryResult[] = [];
  const mask = resolveMaskGeometry(block, rotation);
  if (mask) results.push(mask);
  return results;
}

// ────────────────────────────────────────────────────────────
// Task-003：Semantic Geometry Input Migration
// ────────────────────────────────────────────────────────────

/**
 * 为单个 SemanticRunV2 解析 Mask 几何（输入为 Semantic，不依赖 EditableBlock）。
 *
 * 关键差异（Semantic 输入）：
 *   - `run.visualCoverage.coverageBounds` **已经是扩展后的视觉覆盖**
 *     （Builder `estimateVisualCoverage` 已做 padding，见 semantic-run-builder.ts）。
 *   - 因此**不再需要 `resolveVisualCoverageBounds`**（EditableBlock 路径才需要它，
 *     因为 `originalBounds` 是紧贴 OCR bbox，未扩展）。
 *   - 只需 `calculateReplacementMaskBounds` 处理 rotation（run.rotation 或显式传入）。
 *
 * 数据流：
 *   SemanticRun.visualCoverage.coverageBounds
 *        ↓
 *   GeometryAdapter
 *        ↓
 *   MaskGeometry
 *
 * @param run SemanticRunV2（visualCoverage / rotation / sourceId）
 * @param rotation 可选显式 rotation；缺省用 run.rotation
 * @returns MaskGeometry | null
 */
export function resolveMaskGeometryFromRun(
  run: SemanticRunV2,
  rotation?: number,
): MaskGeometry | null {
  const vc = run?.visualCoverage;
  if (!vc || !vc.coverageBounds) return null;
  const rot = rotation ?? run.rotation ?? 0;
  // coverageBounds 已含视觉扩展（Semantic 的 Coverage Domain），只做 rotation 几何。
  const maskBounds = calculateReplacementMaskBounds({
    originalBounds: vc.coverageBounds,
    rotation: rot,
  });
  return {
    kind: "mask",
    x: maskBounds.x,
    y: maskBounds.y,
    width: maskBounds.width,
    height: maskBounds.height,
    blockId: run.sourceId ?? run.id,
    source: "coverage",
  };
}

/**
 * 由 SemanticDocumentV2 解析全部 run 的 Geometry（mask）。
 *
 * Task-003 主入口：遍历 Semantic 的 runs，输出 MaskGeometry[]。
 * 不依赖 EditableBlock。
 *
 * @param semantic SemanticDocumentV2
 * @returns GeometryResult[]
 */
export function resolveSemanticGeometry(
  semantic: import("../document-model-v2/semantic-run").SemanticDocumentV2,
): GeometryResult[] {
  const results: GeometryResult[] = [];
  for (const page of semantic.pages) {
    for (const para of page.paragraphs) {
      for (const line of para.lines) {
        for (const run of line.runs) {
          const mask = resolveMaskGeometryFromRun(run);
          if (mask) results.push(mask);
        }
      }
    }
  }
  return results;
}

/** 导出 resolveVisualCoverageBounds（迁移后仍可由外部引用，但 Ownership 在本 Adapter） */
export { resolveVisualCoverageBounds };
