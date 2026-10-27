/**
 * F3B-6.17 阶段二 — Segment Core Migration：flag + 路径判据（纯函数层）
 *
 * ── 方案 A（门控切换）────────────────────────────────────────────────
 *   · 独立 flag `__segmentCoreMigration`；**F3B-6.17-3C-0 起默认 true**
 *     （生产默认路径 = Segment → Core Command → Core Document）
 *   · 保留 **kill-switch**：仅显式 `false` 关闭（回到纯 Legacy 路径，行为级不变）
 *   · **不复用** `__coreInput`（两者是不同 capability）
 *   · 不影响 `__segmentCanonicalCommit`
 *   · ⚠️ 与 `readSegmentCanonicalCommitFlag` 同为「默认启用 + 显式 false 关闭」契约
 *
 * ── fallback 语义（6.17 §9）──────────────────────────────────────────
 *   **判据在这里，执行在 orchestration 层**。Core Command 内部**绝不** fallback
 *   （否则又会把 Legacy mutation 变成 Core 的隐式 dependency）。
 *   ⚠️ 默认 ON **不改变** fallback 语义：Core 尝试失败 → 调用方继续走既有 Legacy 分支。
 */

import type { EditorDocument } from "../core/document/types";
import type { EditorCommand } from "../core/commands/types";
import type { CoreTextRangeRef } from "./segment-core-range";

/**
 * 独立 migration 开关名。
 *
 * F3B-6.17-3C-0：**默认启用**，仅显式 `false` 关闭（kill-switch）。
 * 与 `readSegmentCanonicalCommitFlag` 同契约（默认 ON + kill-switch 保留）。
 */
export const SEGMENT_CORE_MIGRATION_FLAG = "__segmentCoreMigration";

/**
 * 读取 migration 开关。
 *
 * - 默认（含 `window.__segmentCoreMigration` 未定义）→ **true**（生产默认走 Core）
 * - 仅显式 `=== false` → false（kill-switch，回到纯 Legacy 路径）
 * - SSR（无宿主）→ false（保持既有保守语义：不迁移）
 */
export function readSegmentCoreMigrationFlag(
  scope?: { [SEGMENT_CORE_MIGRATION_FLAG]?: unknown }
): boolean {
  const target =
    scope ?? (typeof window !== "undefined" ? (window as unknown as object) : undefined);
  if (!target) return false; // SSR
  return (target as Record<string, unknown>)[SEGMENT_CORE_MIGRATION_FLAG] !== false;
}

export type SegmentCommitPath = "core" | "legacy";

export type SegmentFallbackReason =
  | "migration-flag-off"
  | "no-core-document"
  | "range-unresolved"
  | "command-unavailable"
  | "render-source-unavailable"
  | "commit-error";

export interface SegmentCommitPathInput {
  migrationEnabled: boolean;
  /** `coreDocumentRef.current`（import 时由 `initializeCoreDocument` 创建） */
  coreDocument: EditorDocument | null;
  /** `resolveSegmentToCoreRange` 结果；null = 未命中 */
  ref: CoreTextRangeRef | null;
  command: EditorCommand | null;
  /** Core render source 是否可用（决定能否真正“可见”） */
  renderSourceAvailable: boolean;
}

export interface SegmentCommitDecision {
  path: SegmentCommitPath;
  reason?: SegmentFallbackReason;
}

/**
 * 决定本次 Segment commit 走 Core 还是 Legacy。
 * 任一条件不满足 → `legacy` + reason（**不抛错**，由调用方继续走既有分支）。
 */
export function decideSegmentCommitPath(
  input: SegmentCommitPathInput
): SegmentCommitDecision {
  if (!input.migrationEnabled) return { path: "legacy", reason: "migration-flag-off" };
  if (!input.coreDocument) return { path: "legacy", reason: "no-core-document" };
  if (!input.ref) return { path: "legacy", reason: "range-unresolved" };
  if (!input.command) return { path: "legacy", reason: "command-unavailable" };
  if (!input.renderSourceAvailable) {
    return { path: "legacy", reason: "render-source-unavailable" };
  }
  return { path: "core" };
}

// ─────────────────────────────────────────────────────────────────────
//  可观测计数（6.17 §9：attempt / success / fallback / reason）
// ─────────────────────────────────────────────────────────────────────

export interface SegmentCoreTelemetry {
  attempt: number;
  success: number;
  fallback: number;
  lastReason?: SegmentFallbackReason;
}

export function createSegmentCoreTelemetry(): SegmentCoreTelemetry {
  return { attempt: 0, success: 0, fallback: 0 };
}

// ─────────────────────────────────────────────────────────────────────
//  F3B-6.17-3C-0.5 — Fallback Export Contract（export ownership）
// ─────────────────────────────────────────────────────────────────────

/**
 * 本次**当前文档**的导出 ownership。
 *
 * 语义 = 「当前文档的编辑真相是否已由 Core semantic path 完整接管」：
 *   · `"core"`   → 全部编辑都进了 Core ⇒ 允许 Core Export
 *   · `"legacy"` → 至少有一次编辑**未被 Core 接管**（fallback 或 migration 关闭）
 *                  ⇒ **必须**走 Legacy Export，否则该编辑会在 Core 产物中丢失
 *
 * ⚠️ 与 `segmentCoreActive` / `CoreDocumentLifecycle.owned` 的区别：后两者是
 *    **每 generation 粘性** 的「Core 曾接管过」信号，无法表达「本次编辑落回 Legacy」。
 *    本信号由 **每次 Segment commit 的结果**驱动，并在 re-import 时复位。
 */
export type ExportOwnership = "core" | "legacy";

/**
 * 本次 export 是否允许尝试 Core。
 *
 * 硬约束：`ownership === "legacy"` ⇒ **绝不**尝试 Core Export
 * （Core 产物不读 legacy 编辑 ⇒ 会静默丢失本次 legacy-only 编辑）。
 */
export function shouldAttemptCoreExport(input: {
  ownership: ExportOwnership;
  coreExportWired: boolean;
  hasCoreSource: boolean;
  hasDocument: boolean;
}): boolean {
  if (input.ownership === "legacy") return false;
  return input.coreExportWired && input.hasCoreSource && input.hasDocument;
}
