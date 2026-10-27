/**
 * F3B-6.14-A — Production Reconciliation Eligibility（纯判据）
 *
 * 原则（与 F3B-2 Core Export 一致）：
 *   **eligibility 决定路径，执行器负责执行。**
 *   reconciliation 自己**不得**偷偷 fallback —— 任一条件不满足即返回 "legacy" + reason。
 *
 * ⚠️ 关于「Legacy fallback」的语义（本阶段）：
 *   Core 输入路径 `legacyMutation` 恒为 `false`，因此 Core 编辑**原本就不会**更新
 *   `editedLineBoxes`。故 Core path 走 legacy fallback = 维持 6.14 之前的既有行为，
 *   **不是**把某条链路从"正确"降级为"陈旧"。Legacy mutation 路径不受本模块影响。
 */

import type { AffectedBindingLine, ReconciliationTarget } from "./reconciliation-target";
import type { BindingSidecar } from "./binding-sidecar";

export type ReconciliationPath = "core-sidecar" | "legacy";

export type ReconciliationFallbackReason =
  | "core-not-owned"
  | "missing-sidecar"
  | "generation-mismatch"
  | "no-affected-lines"
  | "missing-binding"
  | "missing-current-geometry"
  | "unsupported-render-source"
  | "reconciliation-error";

/** 支持的 RenderSource（RenderSource 分支不得因 Sidecar 接入发生行为倒置） */
const SUPPORTED_RENDER_SOURCES = new Set(["vector", "image", "image-ocr"]);

export interface EligibilityInput {
  /** Core document 是否已 owning truth（`markOwned()` 之后） */
  coreOwned: boolean;
  sidecar: BindingSidecar | null;
  /** 当前 document generation（须与 sidecar.generation 一致） */
  documentGeneration: number;
  affectedLines: readonly AffectedBindingLine[];
  targets: readonly ReconciliationTarget[];
}

export interface EligibilityDecision {
  path: ReconciliationPath;
  reason?: ReconciliationFallbackReason;
  /** 通过校验、可用于 reconciliation 的行数 */
  eligibleLineCount: number;
}

export function decideReconciliationPath(
  input: EligibilityInput
): EligibilityDecision {
  const { coreOwned, sidecar, documentGeneration, affectedLines, targets } = input;

  if (!coreOwned) return { path: "legacy", reason: "core-not-owned", eligibleLineCount: 0 };
  if (!sidecar) return { path: "legacy", reason: "missing-sidecar", eligibleLineCount: 0 };
  if (sidecar.generation !== documentGeneration) {
    return { path: "legacy", reason: "generation-mismatch", eligibleLineCount: 0 };
  }
  if (affectedLines.length === 0) {
    return { path: "legacy", reason: "no-affected-lines", eligibleLineCount: 0 };
  }

  let eligible = 0;
  for (const target of targets) {
    if (!target.sidecarHit) {
      return { path: "legacy", reason: "missing-binding", eligibleLineCount: eligible };
    }
    if (!target.currentGeometry) {
      return {
        path: "legacy",
        reason: "missing-current-geometry",
        eligibleLineCount: eligible,
      };
    }
    if (!SUPPORTED_RENDER_SOURCES.has(target.renderSource)) {
      return {
        path: "legacy",
        reason: "unsupported-render-source",
        eligibleLineCount: eligible,
      };
    }
    eligible += 1;
  }

  if (eligible === 0) return { path: "legacy", reason: "no-affected-lines", eligibleLineCount: 0 };
  return { path: "core-sidecar", eligibleLineCount: eligible };
}
