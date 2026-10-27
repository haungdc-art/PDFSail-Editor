/**
 * editor/binding/core-input-history.ts — F3B-6.17-3C-10C.3B-0
 *
 * **Core Input Undo/Redo 路由契约**（纯模块；不触碰 DOM / React / 文档）。
 *
 * ── 问题（C.3A 遗留的生产缺口）──────────────────────────────────────
 * `undoCoreInput` / `redoCoreInput` 有完整实现，但**零 production caller**：
 * 生产 `Ctrl+Z / Ctrl+Y` 只走 `OperationHistory`（Legacy）。
 * 若此时把 Core 输入打开，就会得到 **ownership split**：
 *
 *     输入 → Core Command → EditorDocument（真相在 Core）
 *     Ctrl+Z → Legacy OperationHistory（另一条栈，撤销不到 Core）
 *
 * ── 本模块的裁决 ────────────────────────────────────────────────────
 * 路由**由 ownership 决定**（不是由某个输入开关决定）：
 *
 *     owner = lastUndoRedoOwner ?? lastMutationOwner ?? "legacy"
 *
 *   · `lastMutationOwner`：**最近一次 mutation 落到哪一侧**（Core 提交成功 / Legacy funnel）
 *   · `lastUndoRedoOwner`：**当前 undo/redo 连续段所在侧**（任何新 mutation 都会清空它）
 *
 * 两条不变式（B0 的验收核心）：
 *
 *   ① **同一连续段不换侧**：一旦某次 undo 路由到 Core，其后的 redo 仍在 Core
 *      （`lastUndoRedoOwner` 粘住；只有**新的 mutation** 才能重置它）。
 *   ② **owner = core 时绝不触碰 Legacy History**：即使 Core 栈已到底（`core-exhausted`）
 *      或没有 Core session（`no-core-session`），也只 no-op ——
 *      这保证「Core 接管期间 Legacy undo/redo = 0」是可证明的，
 *      而不是"恰好 Legacy 栈为空"。
 *
 * ⚠️ 本模块**不**做跨侧时间序合并（chronological merge）：
 *    两侧栈的交错（Core 提交 → Legacy 提交 → 再撤销）不在 B0 范围。
 *    ownership = core 时 Legacy 栈必然为空，故无交错；ownership = legacy 时按既有语义处理。
 */

import type { EditorDocument } from "../core/document/types";

export type UndoRedoOwner = "core" | "legacy";

/** 路由判定的输入状态（两个侧记由调用方持有；本模块只做纯判定） */
export interface UndoRedoRouteState {
  /** 最近一次 mutation 的落点（Core 提交成功 / Legacy funnel） */
  readonly lastMutationOwner: UndoRedoOwner | null;
  /** 当前 undo/redo 连续段的所在侧（新 mutation ⇒ null） */
  readonly lastUndoRedoOwner: UndoRedoOwner | null;
}

/**
 * 解析本次 undo/redo 应该作用于哪一侧。
 *
 * 优先级：连续段（`lastUndoRedoOwner`）> 最近 mutation 落点 > `"legacy"`（保守默认 = 既有行为）。
 */
export function resolveUndoRedoOwner(state: UndoRedoRouteState): UndoRedoOwner {
  return state.lastUndoRedoOwner ?? state.lastMutationOwner ?? "legacy";
}

export type UndoRedoRouteReason =
  /** owner = core 且 Core 栈可撤销/可重做 */
  | "core-owner"
  /** owner = core 且 Core 栈已到底 ⇒ no-op（**不**换侧） */
  | "core-exhausted"
  /** owner = core 但没有 Core session ⇒ no-op（**不**换侧） */
  | "no-core-session"
  /** owner = legacy ⇒ 既有 OperationHistory 语义 */
  | "legacy-owner";

export interface UndoRedoRouteDecision {
  readonly route: UndoRedoOwner;
  readonly reason: UndoRedoRouteReason;
}

export interface DecideUndoRedoRouteInput extends UndoRedoRouteState {
  readonly doRedo: boolean;
  readonly hasCoreSession: boolean;
  readonly coreCanUndo: boolean;
  readonly coreCanRedo: boolean;
}

/**
 * 决定本次 `Ctrl+Z / Ctrl+Y` 的路由（纯函数）。
 *
 * ★ `route` 与 `reason` 分离：`route = "core"` 但 `reason != "core-owner"` 表示
 *   「本方不可执行 ⇒ no-op」，调用方**必须** `return`（绝不落入另一侧）。
 */
export function decideUndoRedoRoute(input: DecideUndoRedoRouteInput): UndoRedoRouteDecision {
  const owner = resolveUndoRedoOwner(input);
  if (owner !== "core") return { route: "legacy", reason: "legacy-owner" };
  if (!input.hasCoreSession) return { route: "core", reason: "no-core-session" };
  const can = input.doRedo ? input.coreCanRedo : input.coreCanUndo;
  if (!can) return { route: "core", reason: "core-exhausted" };
  return { route: "core", reason: "core-owner" };
}

// ─────────────────────────────────────────────────────────────────────
//  可观测（B0 验收依赖它证明「Legacy undo/redo = 0」）
// ─────────────────────────────────────────────────────────────────────

export interface CoreInputHistoryTelemetry {
  /** 实际执行的次数（按侧、按方向分开） */
  undoCore: number;
  redoCore: number;
  undoLegacy: number;
  redoLegacy: number;
  /** 路由到 Core 但不可执行（到底 / 无 session）的次数 —— 用于区分「没得撤」与「撤错了侧」 */
  coreNoop: number;
  lastOwner: UndoRedoOwner | null;
  lastReason: UndoRedoRouteReason | null;
}

export function createCoreInputHistoryTelemetry(): CoreInputHistoryTelemetry {
  return {
    undoCore: 0,
    redoCore: 0,
    undoLegacy: 0,
    redoLegacy: 0,
    coreNoop: 0,
    lastOwner: null,
    lastReason: null,
  };
}

/** 记一次**实际执行**的 undo/redo（该侧该方向 +1） */
export function recordUndoRedo(
  telemetry: CoreInputHistoryTelemetry,
  owner: UndoRedoOwner,
  doRedo: boolean,
  reason: UndoRedoRouteReason
): void {
  if (owner === "core") {
    if (doRedo) telemetry.redoCore += 1;
    else telemetry.undoCore += 1;
  } else if (doRedo) {
    telemetry.redoLegacy += 1;
  } else {
    telemetry.undoLegacy += 1;
  }
  telemetry.lastOwner = owner;
  telemetry.lastReason = reason;
}

/** 记一次「路由到本方但不可执行」的 no-op */
export function recordUndoRedoNoop(
  telemetry: CoreInputHistoryTelemetry,
  reason: UndoRedoRouteReason
): void {
  telemetry.coreNoop += 1;
  telemetry.lastReason = reason;
}

// ─────────────────────────────────────────────────────────────────────
//  只读探针（E2E / 诊断；供 `window.__coreInputHistory` 使用）
// ─────────────────────────────────────────────────────────────────────

/** 逐段落取 Core 文档文本（只读；用于证明 Core 文档在 undo/redo 下的真实值） */
export function coreDocumentParagraphTexts(document: EditorDocument): string[] {
  const out: string[] = [];
  for (const page of document.pages ?? []) {
    for (const object of page.objects ?? []) {
      const paragraphs = ((object as { paragraphs?: unknown }).paragraphs ?? []) as ReadonlyArray<{
        runs?: ReadonlyArray<{ text?: string }>;
      }>;
      for (const paragraph of paragraphs) {
        const runs = (paragraph.runs ?? []) as ReadonlyArray<{ text?: string }>;
        out.push(runs.map((r) => r.text ?? "").join(""));
      }
    }
  }
  return out;
}
