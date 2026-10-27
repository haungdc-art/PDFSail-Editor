/**
 * editor/core/commands/resize-object.ts — F3B-6.24-B3-C4-C
 *
 * 语义 = **把一个 EditorObject 缩放/重定位到绝对几何 (x, y, width, height)**。
 *
 * ── 范围（C4-A Decision Record D3 / D4 / D11 锁定）──────────────────
 *   · **绝对几何**，不是 delta —— Command 必须是纯变换（§3）：
 *     重复 execute 结果一致，不依赖"当前在哪"，对 History before/after 快照语义友好。
 *     "拖拽边框不累积漂移"由 UI 层从缩放基线重算绝对值来保证，不靠 Command 记 delta。
 *   · **只写 x / y / width / height**。`rotation / transform / assetRef / 段落内容` 一律保持。
 *
 * ── 为什么 Resize 不需要碰 transform ───────────────────────────────
 * 平移 + 等比/自由缩放**不改变**归一化仿射分量 `[a,b,c,d]`（平移归到 x/y、缩放归一为 1）。
 * 因此缩放**不改变** transform，二者不存在同步问题
 * （这也是 C4-A 结论：rotation/transform 双真相风险不落在 Move/Resize 上，
 *  只落在未来的 Rotate 上 —— 本命令**不做 Rotate**）。
 *
 * ── 不变式（本命令的硬边界）─────────────────────────────────────────
 *     after.rotation   === before.rotation
 *     after.transform  === before.transform   ← 同一引用（spread 保持引用）
 *     after.assetRef   === before.assetRef     ← 图片资产引用不变
 *     after.paragraphs === before.paragraphs   ← 文本段落内容不变
 *
 * ── 几何校验（C4-C 明确）────────────────────────────────────────────
 *     width  > 0、height > 0、x/y/width/height 全部有限
 *     （校验在构造期完成；"missing-object" 因需查文档，在 execute 期抛出）
 *
 * ── 不可变与结构共享 ────────────────────────────────────────────────
 *   · 新 document / 新 pages 数组 / 新目标 page / 新 objects 数组
 *   · 未涉及页与未涉及对象保持**元素引用**（不做 deep clone）
 *   · 几何完全相同 ⇒ 返回**原 document 引用**（no-op，不产生 history entry，§5）
 *
 * ── 纯函数（§3 / §27）───────────────────────────────────────────────
 *   · 不修改 React state / docBlocks / EditableDocument / PDF bytes / selection / caret / UI
 *   · 不接 Legacy / Export，不修 F3，不做 aspect ratio / min-size / page clamp
 *   · Command 不依赖 History（execute → newDocument → history.commit）
 */

import { bumpVersion } from "../document/factory";
import type { EditorDocument } from "../document/types";
import { CommandError, type EditorCommand } from "./types";

/** 缩放对象的入参：objectId + **绝对**目标几何 */
export interface ResizeObjectInput {
  readonly objectId: string;
  /** 目标 x（Page Canvas Space，px），必须有限 */
  readonly x: number;
  /** 目标 y（Page Canvas Space，px），必须有限 */
  readonly y: number;
  /** 目标宽度（px），必须有限且 > 0 */
  readonly width: number;
  /** 目标高度（px），必须有限且 > 0 */
  readonly height: number;
}

export class ResizeObjectCommand implements EditorCommand {
  readonly type = "resize-object" as const;

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
  readonly width: number;
  readonly height: number;

  constructor(input: ResizeObjectInput) {
    const id = input?.objectId;
    if (typeof id !== "string" || id.length === 0) {
      throw new CommandError("missing-object", "ResizeObject 需要提供非空 objectId");
    }
    if (typeof input.x !== "number" || !Number.isFinite(input.x)) {
      throw new CommandError("invalid-geometry", `x 必须是有限数（实际 ${String(input.x)}）`);
    }
    if (typeof input.y !== "number" || !Number.isFinite(input.y)) {
      throw new CommandError("invalid-geometry", `y 必须是有限数（实际 ${String(input.y)}）`);
    }
    if (typeof input.width !== "number" || !Number.isFinite(input.width) || input.width <= 0) {
      throw new CommandError(
        "invalid-geometry",
        `width 必须是 > 0 的有限数（实际 ${String(input.width)}）`
      );
    }
    if (typeof input.height !== "number" || !Number.isFinite(input.height) || input.height <= 0) {
      throw new CommandError(
        "invalid-geometry",
        `height 必须是 > 0 的有限数（实际 ${String(input.height)}）`
      );
    }
    this.objectId = id;
    this.x = input.x;
    this.y = input.y;
    this.width = input.width;
    this.height = input.height;
  }

  execute(document: EditorDocument): EditorDocument {
    for (let pi = 0; pi < document.pages.length; pi++) {
      const page = document.pages[pi];
      const oi = page.objects.findIndex((o) => o.id === this.objectId);
      if (oi < 0) continue;

      const target = page.objects[oi];

      // §5：几何完全相同 ⇒ no-op（返回同一引用，不产生 history entry、version 不变）
      if (
        target.x === this.x &&
        target.y === this.y &&
        target.width === this.width &&
        target.height === this.height
      ) {
        this.affectedTextBoxes = [];
        this.affectedParagraphs = [];
        return document;
      }

      this.affectedTextBoxes = target.type === "text" ? [target.id] : [];
      this.affectedParagraphs =
        target.type === "text" ? target.paragraphs.map((p) => p.id) : [];

      // spread 只覆盖 x/y/width/height：
      // rotation / transform / assetRef / 段落内容原样保留
      // （transform 是数组引用，spread 后仍 === 原引用）
      const resized = {
        ...target,
        x: this.x,
        y: this.y,
        width: this.width,
        height: this.height,
      };
      const objects = page.objects.slice();
      objects[oi] = resized;
      const pages = document.pages.slice();
      pages[pi] = { ...page, objects };
      return bumpVersion({ ...document, pages });
    }

    throw new CommandError("missing-object", `对象 "${this.objectId}" 在文档中不存在`);
  }
}
