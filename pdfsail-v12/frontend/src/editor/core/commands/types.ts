/**
 * editor/core/commands/types.ts — EDITOR-CORE-003
 *
 * Command 契约（规范 §2）。
 *
 * 设计选择：**不采用 command-owned undo**。
 *
 *   History 层保存 before/after 两份 document（EDITOR-CORE-004），
 *   每个 Command 只负责 `document → document` 的纯变换，
 *   不为每个 Command 复制一份 undo 逻辑。
 *
 * 严禁（§36 / §37）：
 *   - React / DOM / PDF.js / PDF 导出
 *   - glyphIndex 作为定位依据
 *   - docBlocks / Segment / EditableTextNode / EditSession 等 legacy 依赖
 *   - setDocBlocks 之类的 React setter 进入 Command API
 */

import type { EditorDocument } from "../document/types";

export type CommandType =
  | "insert-text"
  | "delete-text"
  | "replace-text"
  | "split-paragraph"
  | "merge-paragraph"
  | "set-text-style"
  /** F3B-6.24-B3-C2：新增用户对象（文本框 / 图片） */
  | "add-object"
  /** F3B-6.24-B3-C3：删除用户对象（文本框 / 图片） */
  | "delete-object"
  /** F3B-6.24-B3-C4-B：移动用户对象（只改 x/y） */
  | "move-object"
  /** F3B-6.24-B3-C4-C：缩放用户对象（只改 x/y/width/height） */
  | "resize-object"
  /** Manual OCR → Core · Step 2c-B：批量把 2b 已构造的真实 TextBoxObject 作为一次事务加入 Core */
  | "add-ocr-blocks"
  /**
   * F3B-6.27 P0-D2：一次 EditingUnit mutation = N 个既有 command + **1 个** history 边界。
   *
   * 包装器 Command（`unit-transaction.ts`）：内部顺序执行 N 个
   * insert/delete/replace-text，对外只暴露一次 `execute()`。
   * ⇒ `EditorHistory.commit()` 的公开签名**无需改动**（选方案 (a) 的全部理由）。
   */
  | "unit-transaction"
  /**
   * 2026-10-19（跨页编辑）：PDF.js 懒渲染 ⇒ legacy 页随翻页增长；owned 状态下
   * 新渲染页**增量并入** Core（幂等纯变换：只补缺失 index 的页，已编辑页的
   * Core 版本原样保留）。经 history 入栈（1 条 entry）。
   */
  | "append-rendered-pages";

export interface EditorCommand {
  readonly type: CommandType;
  /**
   * §29：受影响的 TextBox / Paragraph（供渲染失效判定，规范 §66）。
   * 可选 —— 只有 document 是必需产出。
   */
  readonly affectedTextBoxes?: readonly string[];
  readonly affectedParagraphs?: readonly string[];
  /** 纯变换：不得修改入参，返回新 document（§3） */
  execute(document: EditorDocument): EditorDocument;
}

/**
 * 命令执行失败（结构性问题：对象不存在、跨 TextBox 等）。
 *
 * 与 position 模块的 TextPositionError 分开：CommandError 只在
 * **结构性非法** 时抛出；边界偏移一律走 clamp，不抛错。
 */
export type CommandErrorCode =
  | "missing-text-box"
  | "missing-paragraph"
  | "missing-run"
  | "cross-text-box"
  | "invalid-range"
  /** F3B-6.24-B3-C2：pageIndex 在文档中不存在 */
  | "missing-page"
  /** F3B-6.24-B3-C2：几何非法（非有限数 / 负宽高 / transform 形状错误） */
  | "invalid-geometry"
  /** F3B-6.24-B3-C2：新增图片对象缺少 assetRef（Core 不接收 src / bytes / dataURL） */
  | "missing-asset-ref"
  /**
   * F3B-6.24-B3-C3：按 objectId 在全部 pages 中找不到对象。
   * 与 `missing-text-box`（限定文本框）区分：本码覆盖 EditorObject 全类型。
   */
  | "missing-object"
  /**
   * F3B-6.27 P0-D2（`UnitTransactionCommand`）：
   * operation 声明的 textBoxId 与该 paragraph 实际所属 TextBox 不一致
   * （身份错位 ⇒ 绝不"就地猜测"目标）。
   */
  | "text-box-mismatch"
  /**
   * F3B-6.27 P0-D2：同一段落出现多个 operation。
   * 第二个 op 的 offset 会因第一个 op 已改变该段落文本而失效 ⇒ 拒绝，
   * 由调用方先把它们合并成单段落内的区间。
   */
  | "duplicate-paragraph-in-transaction";

export class CommandError extends Error {
  readonly code: CommandErrorCode;

  constructor(code: CommandErrorCode, message: string) {
    super(`[EditorCommand] ${message}`);
    this.name = "CommandError";
    this.code = code;
  }
}

/** §29：命令执行结果 */
export interface CommandResult {
  document: EditorDocument;
  /** false = no-op（§5：不产生 history entry，version 不变） */
  changed: boolean;
  affectedTextBoxes: string[];
  affectedParagraphs: string[];
}
