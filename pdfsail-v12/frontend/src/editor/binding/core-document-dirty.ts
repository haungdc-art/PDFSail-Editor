import type { CoreInputSession } from "./core-input-source";

/**
 * C-6-B：Core Dirty 唯一判定（不新增任何 dirty state 变量）。
 *
 * 语义依据（来自 C-6-B Audit）：
 * - `CoreInputSession.history` 在 baseline（无已应用编辑）时 `canUndo === false`；
 * - 任何已应用且未全 undo 的 Core 编辑都会使 `canUndo === true`；
 * - Core OFF / Legacy 路径下 rehydrate 仍会建一个 baseline session，`canUndo` 恒 false，
 *   Legacy 编辑不进 Core history，因此该判定对所有分支安全。
 *
 * 等价于「Core 语义状态 != 已持久化 PDF（pdfBytesRef 不含 Core 编辑）」：
 * - export 下载并不回写 `pdfBytesRef`，所以「Core edit → export」仍然 dirty；
 * - Page Ops 的 `reloadFromPdfLib()` 会用不含 Core 编辑的旧 PDF 重建 `pdfBytesRef`
 *   并从 legacy 重新派生 Core，从而丢失未持久化的 Core 编辑。
 *
 * 因此：dirty === Core session 存在 且 EditorHistory 未回到 baseline（canUndo === true）。
 */
export function isCoreDocumentDirty(
  session: CoreInputSession | null | undefined
): boolean {
  return !!session && session.history.canUndo;
}
