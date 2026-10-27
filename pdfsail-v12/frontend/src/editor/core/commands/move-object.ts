/**
 * editor/core/commands/move-object.ts — F3B-6.24-B3-C4-B
 *
 * 语义 = **移动一个 EditorObject 到绝对坐标 (x, y)**。
 *
 * ── 范围（C4-A Decision Record D3 / D4 / D11 锁定）──────────────────
 *   · **绝对坐标**，不是 delta —— Command 必须是纯变换（§3）：
 *     重复 execute 结果一致，不依赖"当前在哪"，对 History before/after 快照语义友好。
 *     "拖拽不累积漂移"由 UI 层从拖拽基线重算绝对值来保证，不靠 Command 记 delta。
 *   · **只写 x / y**。`width / height / rotation / transform` 一律保持。
 *
 * ── 为什么 Move 不需要碰 transform ─────────────────────────────────
 * `transform` 是**归一化**仿射分量 `[a,b,c,d]`：平移已归到 `x/y`（不存 `e/f`）、
 * 缩放归一为 1。因此平移**不改变** transform，二者不存在同步问题
 * （这也是 C4-A 结论：rotation/transform 双真相风险不落在 Move/Resize 上，
 *  只落在未来的 Rotate 上）。
 *
 * ── 不变式（本命令的硬边界）─────────────────────────────────────────
 *     after.width    === before.width
 *     after.height   === before.height
 *     after.rotation === before.rotation
 *     after.transform === before.transform   ← 同一引用（spread 保持引用）
 *
 * ── 不可变与结构共享 ────────────────────────────────────────────────
 *   · 新 document / 新 pages 数组 / 新目标 page / 新 objects 数组
 *   · 未涉及页与未涉及对象保持**元素引用**（不做 deep clone）
 *   · 坐标完全相同 ⇒ 返回**原 document 引用**（no-op，不产生 history entry，§5）
 *
 * ── 纯函数（§3 / §27）───────────────────────────────────────────────
 *   · 不修改 React state / docBlocks / EditableDocument / PDF bytes / selection / caret / UI
 *   · Command 不依赖 History（execute → newDocument → history.commit）
 */

import { bumpVersion } from "../document/factory";
import type { EditorDocument } from "../document/types";
import { CommandError, type EditorCommand } from "./types";

/** 移动对象的入参：objectId + **绝对**目标坐标 */
export interface MoveObjectInput {
  readonly objectId: string;
  /** 目标 x（Page Canvas Space，px），必须有限 */
  readonly x: number;
  /** 目标 y（Page Canvas Space，px），必须有限 */
  readonly y: number;
}

export class MoveObjectCommand implements EditorCommand {
  readonly type = "move-object" as const;

  /**
   * 在 `execute()` 中赋值：构造期只有 objectId，无法判断目标是文本还是图片。
   * `applyCommand()` 在 execute 之后才读这些字段，时序安全。
   *   · 文本框 → affectedTextBoxes=[id] + 全部段落 id
   *   · 图片   → 两者均为空
   */
  affectedTextBoxes: readonly string[] = [];
  affectedParagraphs: readonly string[] = [];

  readonly objectId: string;
  readonly x: number;
  readonly y: number;

  constructor(input: MoveObjectInput) {
    const id = input?.objectId;
    if (typeof id !== "string" || id.length === 0) {
      throw new CommandError("missing-object", "MoveObject 需要提供非空 objectId");
    }
    if (typeof input.x !== "number" || !Number.isFinite(input.x)) {
      throw new CommandError("invalid-geometry", `x 必须是有限数（实际 ${String(input.x)}）`);
    }
    if (typeof input.y !== "number" || !Number.isFinite(input.y)) {
      throw new CommandError("invalid-geometry", `y 必须是有限数（实际 ${String(input.y)}）`);
    }
    this.objectId = id;
    this.x = input.x;
    this.y = input.y;
  }

  execute(document: EditorDocument): EditorDocument {
    for (let pi = 0; pi < document.pages.length; pi++) {
      const page = document.pages[pi];
      const oi = page.objects.findIndex((o) => o.id === this.objectId);
      if (oi < 0) continue;

      const target = page.objects[oi];

      // §5：坐标完全相同 ⇒ no-op（返回同一引用，不产生 history entry、version 不变）
      if (target.x === this.x && target.y === this.y) {
        this.affectedTextBoxes = [];
        this.affectedParagraphs = [];
        return document;
      }

      this.affectedTextBoxes = target.type === "text" ? [target.id] : [];
      this.affectedParagraphs =
        target.type === "text" ? target.paragraphs.map((p) => p.id) : [];

      // spread 只覆盖 x/y：width / height / rotation / transform 原样保留
      // （transform 是数组引用，spread 后仍 === 原引用）
      const moved = { ...target, x: this.x, y: this.y };
      const objects = page.objects.slice();
      objects[oi] = moved;
      const pages = document.pages.slice();
      pages[pi] = { ...page, objects };
      return bumpVersion({ ...document, pages });
    }

    throw new CommandError("missing-object", `对象 "${this.objectId}" 在文档中不存在`);
  }
}
