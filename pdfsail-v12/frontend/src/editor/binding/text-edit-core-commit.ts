/**
 * editor/binding/text-edit-core-commit.ts — F3B-6.17-3C-10C.3A
 *
 * **TextEdit → Core commit 规划器**（纯模块；只产出 plan，**绝不提交**）。
 *
 * ── 生产链（C.3A 目标）───────────────────────────────────────────────
 *
 *     EditSession / TextEditOverlay（session working text，**不是** document truth）
 *              ↓  commit（Enter / blur / 点击切换）
 *     projectLegacyLineEdit（LCP/LCS → 变更跨度，码点）
 *              ↓
 *     TextEditInputAdapter（Codepoint → **UTF-16**；唯一坐标收敛点）
 *              ↓
 *     CoreInputIntent（intent.range = 行内 UTF-16 半开区间 + text）
 *              ↓  ★ 以 **CanonicalSelection** 形状复用 canonical 链
 *     replaceFromCanonicalSelection（唯一 hierarchy 解析 + 唯一 Command 构造点）
 *              ↓
 *     ReplaceTextCommand / DeleteTextCommand → EditorDocument → Core Export
 *
 * ── 为什么在 **commit** 接线（而不是逐键）────────────────────────────
 *   · `EditSession` 自身契约（`edit-session.ts` 设计原则 3）：**Keyboard 不直接 mutation**，
 *     只更新 `session.text`；commit 才执行 document mutation。
 *   · History 粒度：逐键 Core Command 会把「一次 session = 一次 undo」改成「一键一条」。
 *   ⇒ C.3A 接的是「supported input 的**语义落点**」，input 事件仍先进入 session
 *     的 working text（那是 UI 的输入缓冲，不是 document truth）。
 *
 * ── 复用（**零重复坐标换算**）────────────────────────────────────────
 *   · Codepoint → UTF-16：`toTextEditInputIntent`（**唯一**实现）
 *   · 行内 UTF-16 → Core target：`canonicalSelectionToCoreTarget`（**唯一** hierarchy 解析，
 *     由 `replaceFromCanonicalSelection` 内部调用 ⇒ 本模块**不**解析 Core hierarchy）
 *   · Command 构造：`createSegmentCoreCommand`（**唯一**构造点）
 *   · 单 run / out-of-bounds / unresolved / reversed ⇒ canonical 链 fail-closed
 *     ⇒ 调用方回落到 Legacy（**不**在 Command 内 fallback）
 */

import type { CanonicalSelection } from "./canonical-selection";
import {
  toTextEditInputIntent,
  type TextEditInputIntent,
  type TextEditInputRejection,
  type TextEditInputRequest,
  type TextEditSessionSnapshot,
} from "./text-edit-input-adapter";
import { projectLegacyLineEdit } from "./text-edit-session-projection";

/** 生产开关名（`window.__coreTextEditInput`） */
export const CORE_TEXT_EDIT_INPUT_FLAG = "__coreTextEditInput";

/**
 * 读取生产开关。
 *
 * ── 3C-10C.3B 通过后的新默认（本轮启用）────────────────────────────────
 *
 *     ON  是 production default
 *     OFF 是 emergency rollback（**只有显式 `=== false` 才关闭**）
 *
 * ```text
 * __coreTextEditInput === false  ⇒ Legacy EditSession 路径
 * otherwise（缺省 / true / 其它） ⇒ Core TextEditInputAdapter 路径
 * ```
 *
 * 为什么不是「只有 true 才启用」：C.3B 已在真实 Chromium 上证明
 * 既有 EditSession surface → Adapter → Core 全链成立（replace / insertion /
 * deletion / CJK / emoji Ctrl+Z / Ctrl+Y / no-op / 最终 PDF 无重复 / Legacy mutation=0），
 * 继续保持 OFF 已无架构必要。
 *
 * ⚠️ Legacy EditSession **不删除** —— 它现在是 fallback / rollback 能力。
 */
export function readCoreTextEditInputFlag(scope?: { [CORE_TEXT_EDIT_INPUT_FLAG]?: unknown }): boolean {
  const target = scope ?? (typeof window !== "undefined" ? (window as unknown as object) : undefined);
  if (!target) return true;
  return (target as Record<string, unknown>)[CORE_TEXT_EDIT_INPUT_FLAG] !== false;
}

export interface TextEditCoreCommitInput {
  readonly blockId: string;
  readonly lineId: string;
  /** commit 前的行文本（Legacy `line.glyphs[].char` 拼接 = session 的起点） */
  readonly lineText: string;
  /** session 最终文本（overlay `onSave` 传来的整行 working text） */
  readonly newText: string;
  /** 行 glyph 序列（Adapter 换算 UTF-16 长度与 bounds 的唯一依据） */
  readonly glyphs: ReadonlyArray<{ readonly char?: string; readonly originalChar?: string }>;
}

export type TextEditCoreCommitReason =
  | "no-change"
  | "adapter-rejected"
  | TextEditInputRejection
  /** 无 Core document（未 rehydrate）⇒ 回落 Legacy */
  | "no-core-document"
  /**
   * F3B-6.25-A-Impl：**Core 开启但 Core baseline 不可用**
   * （`resolveCoreLineText` / `coreLineGlyphs` 返回 null）。
   *
   * ⇒ 这是一个**明确的 boundary decision**，不是隐式换数据源：
   *   Core baseline 不可解析时**绝不允许**改用 Legacy 行文本喂 Core planner
   *   （那会重演 6.24 前的 silent seam：Core owner 却用 stale Legacy baseline
   *   做 diff ⇒ offset 越界 ⇒ 静默落 Legacy）。
   *   现在一律：`core-baseline-unresolved` → `TEXT_EDIT_CORE_FALLBACK` → Legacy commit。
   */
  | "core-baseline-unresolved"
  /** canonical 链 fail-closed（unresolved / out-of-bounds / multi-run / reversed / commit-error） */
  | "core-commit-failed";

export type TextEditCoreCommitPlan =
  | {
      readonly ok: true;
      /** 实际提交的 Core Command 类型（`replace-text` / `delete-text`） */
      readonly commandType?: string;
      /** Adapter 产出的 Core 输入意图（**不是** Command） */
      readonly intent: TextEditInputIntent;
      /** 复用 canonical 链的输入形状（**同一** hierarchy 解析实现） */
      readonly canonicalSelection: CanonicalSelection;
      /** 交给 Core Command 层的替换文本（"" ⇒ `delete-text`） */
      readonly replacementText: string;
      readonly changeKind: "replace" | "insert" | "delete";
      /**
       * 纯插入 ⇒ 折叠区间必须显式允许（否则 canonical 链按 B-2.1 语义 fail-closed）。
       * Core 命令层把它映射为 `insert-text`（**不是**空替换）。
       */
      readonly allowCollapsedInsertion: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: TextEditCoreCommitReason;
      /** 诊断（不静默降级） */
      readonly detail: string;
    };

/**
 * 规划一次「TextEdit commit → Core」。
 *
 * 纯函数：零副作用、零 Command、零文档访问。调用方拿到 plan 后才决定是否走 Core，
 * 失败时**回落 Legacy**（plan 本身不 fallback）。
 */
export function planTextEditCoreCommit(input: TextEditCoreCommitInput): TextEditCoreCommitPlan {
  const projection = projectLegacyLineEdit({ lineText: input.lineText, newText: input.newText });
  if (projection.kind === "none") {
    return { ok: false, reason: "no-change", detail: "session text === pre-edit line text" };
  }

  const hasSpan = projection.codepointEnd > projection.codepointStart;
  const request: TextEditInputRequest = hasSpan
    ? projection.replacementText.length === 0
      ? { kind: "delete-range" }
      : { kind: "insert-text", text: projection.replacementText }
    : // 纯插入：折叠跨度 + 非空文本
      { kind: "insert-text", text: projection.replacementText };

  const snapshot: TextEditSessionSnapshot = {
    blockId: input.blockId,
    lineId: input.lineId,
    editingMode: "text-edit",
    startGlyphIndex: 0,
    endGlyphIndex: Math.max(0, input.glyphs.length - 1),
    caret: { start: projection.codepointStart, end: projection.codepointEnd },
    sessionText: input.lineText,
    glyphs: input.glyphs,
  };

  const resolved = toTextEditInputIntent(request, snapshot);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason, detail: `adapter:${resolved.reason}` };
  }

  const intent = resolved.intent;
  const canonicalSelection: CanonicalSelection = {
    blockId: input.blockId,
    lineId: input.lineId,
    startOffsetUtf16: intent.range.startOffsetUtf16,
    endOffsetUtf16: intent.range.endOffsetUtf16,
  };

  return {
    ok: true,
    intent,
    canonicalSelection,
    replacementText: intent.text,
    changeKind: projection.kind,
    allowCollapsedInsertion: projection.kind === "insert",
  };
}
