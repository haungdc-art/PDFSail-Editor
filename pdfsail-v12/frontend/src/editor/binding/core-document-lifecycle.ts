/**
 * core-document-lifecycle.ts — EDITOR-CORE-012-F3B-1.1
 *
 * Core Document Ownership & Rehydration Boundary（纯逻辑、可单测，不依赖 React）。
 *
 * 解决的问题：F3B-1 把 `initializeCoreDocument` 接到了 import boundary（`editableDocVersion` effect），
 * 但 legacy 驱动的 `editableDocVersion++`（undo/redo、replace、SEM、re-import…）都会触发 Core 重新派生，
 * 从而在「Core editing 已经开始」后把 Core 的编辑状态被 legacy snapshot 覆盖 —— 重新制造 Legacy↔Core
 * 双向 truth 问题。
 *
 * 本模块用最小状态机锁死 ownership invariant：
 *
 *   uninitialized ──(import)──▶ active(未 owned) ──(Core edit)──▶ active(owned)
 *        ▲                         │  ▲                            │
 *        │        (re-import)      │  └─ legacy mutation：保持同步  │
 *        └─────────────────────────┘   (owned 后：legacy mutation 不再覆盖 Core)
 *
 * 关键不变量：
 *   · Invariant 1：Core editing active + legacy mutation ≠ 自动 Core re-import
 *   · Invariant 2：Core command（ReplaceText/SplitParagraph/Delete/Insert）不触发 initializeCoreDocument
 *   · Invariant 3：只有 re-import / new document 才允许 Core A → Core B（且旧 session 必须释放）
 */

export type CoreDocumentLifecycleState = "uninitialized" | "active";

export class CoreDocumentLifecycle {
  private _state: CoreDocumentLifecycleState = "uninitialized";
  /** Core 编辑/命令已开始 → Core 成为 document 真相源，legacy mutation 不再覆盖它 */
  private _owned = false;
  /** 一次新 PDF 加载已发出信号，下一次 rehydrate 允许创建新 Core 文档 */
  private _pendingReimport = false;

  get state(): CoreDocumentLifecycleState {
    return this._state;
  }
  get owned(): boolean {
    return this._owned;
  }
  get pendingReimport(): boolean {
    return this._pendingReimport;
  }

  /** 全新 PDF 加载 / 重新解析：允许下一次 rehydrate 创建新 Core 文档。
   *  旧 Core 输入 session 必须由调用方释放（见 PDFEditor.loadPdfFromArrayBuffer）。 */
  signalNewDocument(): void {
    this._pendingReimport = true;
    this._owned = false;
  }

  /** Core document 被清空（doc=null 或组件卸载）。 */
  invalidate(): void {
    this._state = "uninitialized";
    this._owned = false;
    this._pendingReimport = false;
  }

  /** import / re-import 完成：Core document 已从 legacy 创建，但尚未被 Core 编辑 owning。 */
  markActive(): void {
    this._state = "active";
    this._owned = false;
    this._pendingReimport = false;
  }

  /** 首次 Core 编辑/命令发生：Core 成为 document 真相源。 */
  markOwned(): void {
    this._owned = true;
  }

  /**
   * Effect 决策：本次 `editableDocVersion` 变化是否允许触发 Core 重新派生。
   *
   *   - uninitialized：首次 import → 允许
   *   - pendingReimport：re-import 信号 → 允许（创建 Core B，旧 A 失效）
   *   - owned：Core 已 owning truth → legacy mutation **禁止**覆盖（返回 false）
   *   - active + 未 owned：Core 尚未成为真相源 → 保持与 legacy 同步（返回 true）
   */
  shouldRehydrate(): boolean {
    if (this._state === "uninitialized") return true;
    if (this._pendingReimport) return true;
    if (this._owned) return false;
    return true;
  }
}
