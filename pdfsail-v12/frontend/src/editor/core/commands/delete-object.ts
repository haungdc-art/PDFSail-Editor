/**
 * editor/core/commands/delete-object.ts — F3B-6.24-B3-C3
 *
 * 语义 = **从 EditorDocument 中删除一个 EditorObject**（文本或图片）。
 *
 * ── 输入不是 UI Block ──────────────────────────────────────────────
 * Command 只接 `objectId`，**不接** `editor/types.ts` 的 `Block`、不接 `docBlocks`。
 *
 * ── Page traversal ─────────────────────────────────────────────────
 * `EditorObject` 不持有 page（B3-B 钉死），因此必须遍历 `pages[]` 定位：
 *
 *     for (page of document.pages) { const oi = page.objects.findIndex(...) }
 *
 * ── pages 不发生结构性变化 ──────────────────────────────────────────
 * 删除的是 **object**，不是 page：
 *   · `after.pages.length === before.pages.length`（页数/页序不变）
 *   · 未涉及页共享**元素引用**（`after.pages[i] === before.pages[i]`）
 *   · ⚠️ `pages` **数组本身**必然是新引用 —— 不可变更新要求替换目标页元素，
 *     若复用原数组就只能原地写入（会破坏入参不可变性）。这是 Core 既有
 *     不可变风格（`applyToTextBox` 同款 `pages.slice()`）。
 *
 * ── 不做全树 deep clone ────────────────────────────────────────────
 * 剩余对象、未涉及页全部保持原引用（`objects.filter` 只断开被删那一项）。
 *
 * ── 找不到就抛错（不静默成功）──────────────────────────────────────
 * `delete nonexistent → no-op success` 会掩盖 routing bug，故抛
 * `CommandError("missing-object")`，沿用既有 Command error contract。
 *
 * ── Undo / Redo 不重新创建对象 ─────────────────────────────────────
 * Command 不实现 undo（规范 §2）：History 保存 before/after 两份 document，
 * 因此 undo/redo 恢复的是**原对象引用** —— id 与 assetRef 天然不变，
 * 不存在"redo 重建对象导致 assetRef 重新生成"的问题。
 *
 * ── 纯函数与不可变（§3 / §27）───────────────────────────────────────
 *   · 不修改 React state / docBlocks / EditableDocument / PDF bytes / selection / caret / UI
 *   · Command 不依赖 History
 */

import { bumpVersion } from "../document/factory";
import type { EditorDocument } from "../document/types";
import { CommandError, type EditorCommand } from "./types";

/** 删除对象的入参：只有 id（UI Block / docBlocks 不得进入 Core） */
export interface DeleteObjectInput {
  readonly objectId: string;
}

export class DeleteObjectCommand implements EditorCommand {
  readonly type = "delete-object" as const;

  /**
   * 受影响的对象 id。
   *
   * 在 `execute()` 中赋值：构造期只有 objectId，无法判断目标是文本还是图片。
   * `applyCommand()` 在 execute 之后才读这些字段，因此时序安全。
   *   · 文本框 → [id] + 其段落 id
   *   · 图片   → []（页面级失效由 version bump 承担）
   */
  affectedTextBoxes: readonly string[] = [];
  affectedParagraphs: readonly string[] = [];

  readonly objectId: string;

  constructor(input: DeleteObjectInput) {
    const id = input?.objectId;
    if (typeof id !== "string" || id.length === 0) {
      throw new CommandError("missing-object", "DeleteObject 需要提供非空 objectId");
    }
    this.objectId = id;
  }

  execute(document: EditorDocument): EditorDocument {
    for (let pi = 0; pi < document.pages.length; pi++) {
      const page = document.pages[pi];
      const oi = page.objects.findIndex((o) => o.id === this.objectId);
      if (oi < 0) continue;

      const target = page.objects[oi];
      this.affectedTextBoxes = target.type === "text" ? [target.id] : [];
      this.affectedParagraphs =
        target.type === "text" ? target.paragraphs.map((p) => p.id) : [];

      // 只断开被删那一项；其余对象保持原引用（不做 deep clone）
      const objects = page.objects.filter((_, i) => i !== oi);
      const pages = document.pages.slice();
      pages[pi] = { ...page, objects };
      return bumpVersion({ ...document, pages });
    }

    throw new CommandError("missing-object", `对象 "${this.objectId}" 在文档中不存在`);
  }
}
