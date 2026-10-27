/**
 * editor/core/commands/add-block.ts — F3B-6.24-B3-C2
 *
 * 语义 = **把一个用户新增对象（文本框 / 图片）添加进 EditorDocument**。
 * 这是 B3 系列的第一个"对象级"语义命令（此前全部是文本级：insert/delete/replace/split/merge/style）。
 *
 * ── 输入不是 UI Block ──────────────────────────────────────────────
 * Command **不接受** `editor/types.ts` 的 `Block`：
 *   它带有 `page / src / dataUrl` 等 UI / Legacy 字段，会把 UI 模型重新污染 Core。
 * 这里定义 Core-facing 的 `AddBlockInput`（`AddTextObjectInput | AddImageObjectInput`），
 * 只含 Core 语义：几何 + 段落（文本）或 assetRef（图片）。
 *
 * ── Page ownership（B3-B 钉死）──────────────────────────────────────
 * 对象**不持有 page 字段**。归属由结构表达：
 *
 *     EditorDocument.pages[pi].objects.push(object)
 *
 * `pageIndex` = **1-based 页码**，与 `EditorPage.index` 同义（不新发明 Page ID 系统）。
 *
 * ── ID 稳定性 ──────────────────────────────────────────────────────
 * object id **在构造函数里确定一次**（input.id 优先，否则 `nextId`），
 * **绝不在 `execute()` 里重新生成** —— 否则 redo / 重放会得到不同 identity，
 * 破坏后续 selection / binding / assetRef 的引用稳定性。
 *
 * ── 图片只消费 assetRef ────────────────────────────────────────────
 * 资产由 Binding ingestion 先行创建（`ImageAsset { id, bytes, mime }`），
 * 本命令只接 `assetRef`。Core 不知道 FileReader / dataURL / Uint8Array / mime / embedPng。
 *
 * ── 纯函数与不可变（§3 / §27）───────────────────────────────────────
 *   · 不修改 React state / docBlocks / EditableDocument / PDF bytes / selection / caret / UI
 *   · 不修改 Binding 资源字节
 *   · 未涉及的 page 共享引用；返回新 document 并 bump version
 *   · Command 不依赖 History（沿用 execute → newDocument → history.commit 模式）
 */

import {
  bumpVersion,
  createImageObject,
  createTextBox,
  nextId,
} from "../document/factory";
import type {
  EditorDocument,
  ImageAssetRef,
  Paragraph,
  TextSourceBinding,
} from "../document/types";
import { CommandError, type EditorCommand } from "./types";

/** 归一化仿射分量 `[a, b, c, d]`（与 TextBoxObject.transform / ImageObject.transform 同义） */
export type AffineTransform4 = [number, number, number, number];

/** 新增对象的公共几何（Core 语义，不含任何 UI 字段） */
export interface AddObjectGeometry {
  /** Page Canvas Space（左上原点，y 向下），px */
  x: number;
  y: number;
  /** 布局约束宽高，px（必须 > 0） */
  width: number;
  height: number;
  /** 顺时针旋转角度（度），缺省 0 */
  rotation?: number;
  /** F3B-6.18-C.1：归一化仿射分量（authoritative）；缺省表示无旋转/无倾斜 */
  transform?: AffineTransform4;
}

/**
 * 新增文本框。
 *
 * 关于 style：**不设独立的 `style` 字段** —— 样式唯一真源是 `paragraphs[].runs[].style`。
 * 再加一个顶层 `style` 会形成两个可独立修改的样式真相（与 rotation/transform 的双真相问题同源）。
 */
export interface AddTextObjectInput extends AddObjectGeometry {
  readonly type: "text";
  /** 1-based 页码（= EditorPage.index） */
  readonly pageIndex: number;
  /** 对象 id；缺省由 `nextId` 在构造时生成一次 */
  readonly id?: string;
  /** 至少 1 个段落（空段落合法） */
  readonly paragraphs: readonly Paragraph[];
  /** PDF provenance；用户新增对象通常缺省或显式 `{ kind: "user" }` */
  readonly source?: TextSourceBinding;
}

/**
 * 新增图片。
 *
 * 只接 `assetRef` —— **不接** src / dataUrl / bytes / mime。
 */
export interface AddImageObjectInput extends AddObjectGeometry {
  readonly type: "image";
  /** 1-based 页码（= EditorPage.index） */
  readonly pageIndex: number;
  /** 对象 id；缺省由 `nextId` 在构造时生成一次 */
  readonly id?: string;
  /** 指向 Binding 层 ImageAsset 的引用（非空） */
  readonly assetRef: ImageAssetRef;
}

/** Command 的唯一入参形态（判别联合，Core semantic input） */
export type AddBlockInput = AddTextObjectInput | AddImageObjectInput;

// ─────────────────────────────────────────────────────────────────────
//  校验（沿用既有 CommandError 约定：结构性非法才抛）
// ─────────────────────────────────────────────────────────────────────

function requireFinite(n: unknown, label: string): number {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new CommandError("invalid-geometry", `${label} 必须是有限数（实际 ${String(n)}）`);
  }
  return n;
}

function validateGeometry(g: AddObjectGeometry): void {
  requireFinite(g.x, "x");
  requireFinite(g.y, "y");
  requireFinite(g.width, "width");
  requireFinite(g.height, "height");
  if (g.width <= 0 || g.height <= 0) {
    throw new CommandError(
      "invalid-geometry",
      `width/height 必须 > 0（实际 width=${g.width}, height=${g.height}）`
    );
  }
  if (g.rotation !== undefined) requireFinite(g.rotation, "rotation");
  if (g.transform !== undefined) {
    if (!Array.isArray(g.transform) || g.transform.length !== 4) {
      throw new CommandError("invalid-geometry", "transform 必须是长度 4 的数组 [a,b,c,d]");
    }
    g.transform.forEach((v, i) => requireFinite(v, `transform[${i}]`));
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Command
// ─────────────────────────────────────────────────────────────────────

export class AddBlockCommand implements EditorCommand {
  readonly type = "add-object" as const;
  readonly affectedTextBoxes: readonly string[];
  readonly affectedParagraphs: readonly string[];
  readonly input: AddBlockInput;
  /** 本次新增对象的 id（构造时确定，execute 不再生成） */
  readonly objectId: string;

  constructor(input: AddBlockInput) {
    this.input = input;
    validateGeometry(input);

    if (input.type === "text") {
      if (!Array.isArray(input.paragraphs) || input.paragraphs.length === 0) {
        throw new CommandError("missing-paragraph", "AddBlock(text) 至少需要一个段落");
      }
      this.affectedParagraphs = input.paragraphs.map((p) => p.id);
    } else {
      if (typeof input.assetRef !== "string" || input.assetRef.length === 0) {
        throw new CommandError(
          "missing-asset-ref",
          "AddBlock(image) 必须提供非空 assetRef（Core 不接收 src / bytes / dataURL）"
        );
      }
      // 图片不是文本框 → 不产生文本失效面（页面失效由 version bump 承担）
      this.affectedParagraphs = [];
    }

    // id 在构造期定一次：input.id 优先，否则按类型取 Core 既有前缀生成（不复用 factory 的隐式生成，
    // 以保证 execute() 前后 objectId 恒定可读）
    this.objectId = input.id ?? nextId(input.type === "text" ? "tb" : "img");
    this.affectedTextBoxes = input.type === "text" ? [this.objectId] : [];
  }

  execute(document: EditorDocument): EditorDocument {
    const pi = document.pages.findIndex((p) => p.index === this.input.pageIndex);
    if (pi < 0) {
      throw new CommandError(
        "missing-page",
        `pageIndex ${this.input.pageIndex} 不存在（文档共 ${document.pages.length} 页）`
      );
    }

    // 只允许经 factory 构造：禁止 Command 自己拼接对象字面量
    const object =
      this.input.type === "text"
        ? createTextBox({
            id: this.objectId,
            x: this.input.x,
            y: this.input.y,
            width: this.input.width,
            height: this.input.height,
            rotation: this.input.rotation,
            transform: this.input.transform,
            paragraphs: this.input.paragraphs.map((p) => p),
            source: this.input.source,
          })
        : createImageObject({
            id: this.objectId,
            x: this.input.x,
            y: this.input.y,
            width: this.input.width,
            height: this.input.height,
            rotation: this.input.rotation,
            transform: this.input.transform,
            assetRef: this.input.assetRef,
          });

    const page = document.pages[pi];
    const objects = [...page.objects, object];
    const pages = document.pages.slice();
    pages[pi] = { ...page, objects };
    return bumpVersion({ ...document, pages });
  }
}
