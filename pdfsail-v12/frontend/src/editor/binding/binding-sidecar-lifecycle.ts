/**
 * F3B-6.12 — Binding Sidecar 生命周期判据（纯函数，可单测）
 *
 * ── 冻结约束（F3B-6.11）─────────────────────────────────────────────
 *   · Sidecar 是 **per-import immutable snapshot**
 *   · **禁止**在 `[editableDocVersion]` 的普通 rehydrate 分支重建
 *     （该分支对「active + legacy mutation」也会返回 shouldRehydrate()===true，
 *      重建会把**已编辑几何**当成原文几何）
 *   · **禁止**在 legacy mutation / Core command 之后重建
 *   · 唯一销毁边界 = `signalNewDocument()`（re-import）
 *
 * 判据来源：`current === null` —— 因为 `current` **只在 re-import 边界被置空**，
 * 所以「current 为空」等价于「这是一个全新的 document generation」。
 */

import type { BindingSidecar, SidecarOrigin } from "./binding-sidecar";

export type SidecarLifecycleAction =
  /** 构建新 Sidecar（新 generation） */
  | "build"
  /** 保持现有实例（legacy mutation / Core rehydrate / Core command 都走这里） */
  | "keep"
  /** 文档不存在（re-import 边界 / 组件卸载）→ 释放 */
  | "clear";

export interface SidecarLifecycleInput {
  /** 当前持有的 Sidecar（re-import 边界被置 null） */
  current: BindingSidecar | null;
  /** `editableDocumentRef.current !== null` */
  hasDocument: boolean;
  /** OCR 是否已注入并覆盖文档（`ocrBlocksInjectedRef`） */
  ocrInjected: boolean;
}

export interface SidecarLifecycleDecision {
  action: SidecarLifecycleAction;
  /** action === "build" 时给出应使用的入口 */
  origin?: SidecarOrigin;
}

export function decideSidecarLifecycle(
  input: SidecarLifecycleInput
): SidecarLifecycleDecision {
  const { current, hasDocument, ocrInjected } = input;

  // 文档不存在 → 释放（re-import 边界已在此前把 current 置 null）
  if (!hasDocument) return { action: "clear" };

  // 新 generation（首次 import，或 re-import 后重建）
  if (!current) {
    return { action: "build", origin: ocrInjected ? "ocr" : "pdf-native" };
  }

  // OCR 注入替换了文档 → 必须用 OCR 入口重建（pdf-native 快照已失效）
  if (ocrInjected && current.origin === "pdf-native") {
    return { action: "build", origin: "ocr" };
  }

  // 其余（legacy mutation / Core rehydrate / Core 编辑）→ 保持，绝不重建
  return { action: "keep" };
}
