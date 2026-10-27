/**
 * editor/core/commands/add-ocr-blocks.ts — Manual OCR → Core Migration · Step 2c-B
 *
 * 语义 = 把 **2b 已经构造好的真实 Core TextBoxObject** 作为**一次语义事务**
 * 加入现有 EditorDocument。
 *
 * ── 边界（与 AddBlockCommand 的根本区别）────────────────────────────
 * AddBlockCommand 接收"几何 + 段落"并**在命令内 createTextBox 重新 materialize**；
 * 本命令**不**重新构造任何 Core Object —— 2b 已经创建好的 TextBoxObject 就是输入事实。
 * 命令只负责：校验 → 按 pageIndex 找现有 EditorPage → 把已有 TextBoxObject 原样 append。
 *
 * ── Producer（Rev 0.7，取代 Rev 0.6 Path X' 表述）─────────────────
 *   entries 来自 binding/core-ocr-add.ts 的 buildOcrTextBlocksInput：
 *   2b 产出 ImportPageDraft[] → materializeImport() → EditorDocument → 抽取 text objects。
 *   （Step 2b.6 收敛：materializeImport 是 OCR Draft → Core Object 的唯一路径。）
 *
 * ── 单次事务（2c-A 验收核心）──────────────────────────────────────
 *   一次 execute() 完成全部 page/object 修改；编排层单次 history.commit()
 *   → 恰好一个 EditorTransaction（history.size +1），而非每对象一次 commit。
 *
 * ── 不可变 / identity ─────────────────────────────────────────────
 *   · 输入 object 原样 append（object.id / paragraph.id / run.id / source / geometry 一律不变）
 *   · 未涉及的 page 共享引用；仅命中页得到新 objects 数组 + 新 page 对象
 *   · bumpVersion；缺页 fail-closed（missing-page）
 */

import { bumpVersion } from "../document/factory";
import type { EditorDocument, TextBoxObject } from "../document/types";
import { CommandError, type EditorCommand } from "./types";

/** 一次 OCR 操作产出的一个 Core 文本框 + 其 1-based 页码 */
export interface AddOcrTextBlockEntry {
  /** 1-based 页码（= EditorPage.index） */
  readonly pageIndex: number;
  /** 2b 已构造好的真实 Core TextBoxObject（原样 append，命令内不重建） */
  readonly object: TextBoxObject;
}

export type AddOcrTextBlocksInput = {
  readonly entries: readonly AddOcrTextBlockEntry[];
};

function requireFinite(n: unknown, label: string): number {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new CommandError("invalid-geometry", `${label} 必须是有限数（实际 ${String(n)}）`);
  }
  return n;
}

export class AddOcrTextBlocksCommand implements EditorCommand {
  readonly type = "add-ocr-blocks" as const;
  readonly affectedTextBoxes: readonly string[];
  readonly affectedParagraphs: readonly string[];
  readonly input: AddOcrTextBlocksInput;

  constructor(input: AddOcrTextBlocksInput) {
    this.input = input;

    const tbIds: string[] = [];
    const paraIds: string[] = [];
    for (const entry of input.entries) {
      const obj = entry.object;
      if (!obj || obj.type !== "text") {
        throw new CommandError("invalid-geometry", "OCR block 必须是 TextBoxObject");
      }
      requireFinite(entry.pageIndex, "pageIndex");
      requireFinite(obj.x, "x");
      requireFinite(obj.y, "y");
      requireFinite(obj.width, "width");
      requireFinite(obj.height, "height");
      if (obj.width <= 0 || obj.height <= 0) {
        throw new CommandError(
          "invalid-geometry",
          `width/height 必须 > 0（实际 width=${obj.width}, height=${obj.height}）`
        );
      }
      if (!obj.id || typeof obj.id !== "string") {
        throw new CommandError("invalid-geometry", "TextBoxObject.id 必须非空字符串");
      }
      if (!obj.paragraphs || obj.paragraphs.length === 0) {
        throw new CommandError("missing-paragraph", "OCR TextBoxObject 至少需要一个段落");
      }
      tbIds.push(obj.id);
      for (const p of obj.paragraphs) paraIds.push(p.id);
    }

    this.affectedTextBoxes = tbIds;
    this.affectedParagraphs = paraIds;
  }

  execute(document: EditorDocument): EditorDocument {
    const entries = this.input.entries;
    if (entries.length === 0) return document; // no-op：不产生 history entry（§5）

    // 按 pageIndex 分组（同页按 entry 顺序追加）
    const byPage = new Map<number, TextBoxObject[]>();
    for (const e of entries) {
      const arr = byPage.get(e.pageIndex);
      if (arr) arr.push(e.object);
      else byPage.set(e.pageIndex, [e.object]);
    }

    // 缺页 fail-closed（document 相关，放 execute 而非 constructor）
    for (const pi of byPage.keys()) {
      if (!document.pages.some((p) => p.index === pi)) {
        throw new CommandError(
          "missing-page",
          `pageIndex ${pi} 不存在（文档共 ${document.pages.length} 页）`
        );
      }
    }

    // 不可变：仅命中页得到新 objects 数组 + 新 page 对象；其余共享引用
    const pages = document.pages.map((page) => {
      const add = byPage.get(page.index);
      if (!add || add.length === 0) return page;
      return { ...page, objects: [...page.objects, ...add] };
    });

    return bumpVersion({ ...document, pages });
  }
}
