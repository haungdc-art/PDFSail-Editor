/**
 * core/commands/unit-transaction.ts — F3B-6.27 · **P0-D2 · UnitTransactionCommand**
 *
 * ── 用户裁决（(a) 方案）─────────────────────────────────────────────
 *   一次 EditingUnit mutation = **N 个 Core command + 1 个 history 边界**。
 *   实现方式 = **包装器 Command**（`UnitTransactionCommand`）：
 *   内部顺序执行 N 个既有 Core command，对外**只暴露一次** `execute()`。
 *
 * ── 为什么不需要改 EditorHistory（选 (a) 而非 (a1) 的全部理由）────────
 *   `EditorHistory.commit(command)` 只要求 `command.execute(document)` 返回新 document
 *   （同一引用 = no-op ⇒ 零 entry），undo/redo 走 before/after 快照。
 *   ⇒ 只要包装器**一次**返回最终 document，History 天然只看到 1 条 entry。
 *   **Core History 的公开签名零改动。**
 *
 * ── 语义（严格）──────────────────────────────────────────────────────
 *   · **顺序**：按 `operations[]` 数组顺序执行（不按 paragraph id 重排）
 *     —— 顺序由 P0-D1 的 plan 决定，deterministic。
 *   · **原子**：任一 op 失败（段落不存在 / offset 越界 / 同段落重复）⇒ **整体抛错**。
 *     Command 是纯函数（`document → document`，抛错时无副作用）⇒ 外部 document
 *     不会被部分修改 ⇒ 不存在"改了一半"。
 *   · **零部分执行**：所有 op 先在原 document 上**预验证**，通过后才开始执行。
 *   · **no-op 诚实**：若所有 op 都不产生变化 ⇒ 返回**原 document 引用**
 *     ⇒ History 判 `changed=false` ⇒ 零 entry、version 不变。
 *   · **不越界**：offset 必须落在该 paragraph 真实长度内。**不用 Core 的 clamp**
 *     （`paragraphOffsetToPosition` 对越界 offset 会静默夹到末尾）⇒ 先自校验并抛错。
 *   · **不碰 separator**：separator 不是 Core text，本命令**完全看不见**它
 *     （它已由 P0-D1 的 plan 归约为两侧 line 的文本操作）。
 *   · **同段落只允许一个 op**：两个 op 落在同一 paragraph 时，第二个 op 的 offset
 *     会因第一个 op 已改变文本而失效 ⇒ **fail-closed**，不猜。
 *
 * ── 硬边界 ──────────────────────────────────────────────────────────
 *   · 零 React / DOM / PDF.js / PDF 导出 / glyphIndex / Segment / docBlocks
 *   · 零 provenance 伪造：替换文本由既有 Command 写入，Core 自己标记 `generated`
 *   · 本阶段**不接生产**：仅从 `commands/index.ts` 导出（无任何生产 caller）
 */

import { getParagraphText } from "../document/query";
import type { EditorDocument, Paragraph, TextBoxObject } from "../document/types";
import { paragraphOffsetToPosition } from "../position/position";
import { createTextRange } from "../position/range";
import type { TextPosition } from "../position/types";
import { DeleteTextCommand } from "./delete-text";
import { InsertTextCommand } from "./insert-text";
import { ReplaceTextCommand } from "./replace-text";
import { CommandError, type EditorCommand } from "./types";

/** 一条 per-line 操作（与 P0-D1 的 `UnitOperation` 同形，刻意解耦以免 Core 依赖 Binding） */
export interface UnitTransactionOperation {
  readonly textBoxId: string;
  readonly paragraphId: string;
  /** 段落内偏移 [startUtf16, endUtf16) */
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly replacement: string;
}

function findTextBoxOfParagraph(
  document: EditorDocument,
  paragraphId: string
): { textBox: TextBoxObject; paragraph: Paragraph } | null {
  for (const page of document.pages) {
    for (const object of page.objects) {
      if (object.type !== "text") continue;
      const textBox = object as TextBoxObject;
      const paragraph = textBox.paragraphs.find((p) => p.id === paragraphId);
      if (paragraph) return { textBox, paragraph };
    }
  }
  return null;
}

/** 段落内偏移 → TextPosition（越界已由 preflight 拦截，这里只兜底抛错） */
function positionAt(document: EditorDocument, paragraphId: string, offset: number): TextPosition {
  try {
    return paragraphOffsetToPosition(document, paragraphId, offset);
  } catch (e) {
    throw new CommandError(
      "missing-paragraph",
      `UnitTransaction 无法在段落 "${paragraphId}" 偏移 ${offset} 处定位：${(e as Error).message}`
    );
  }
}

export class UnitTransactionCommand implements EditorCommand {
  readonly type = "unit-transaction" as const;
  readonly unitId: string;
  readonly operations: readonly UnitTransactionOperation[];
  readonly affectedTextBoxes: readonly string[];
  readonly affectedParagraphs: readonly string[];

  constructor(unitId: string, operations: readonly UnitTransactionOperation[]) {
    this.unitId = unitId;
    this.operations = operations;
    // 去重但保序（affects 只用于渲染失效判定）
    const boxes: string[] = [];
    const paragraphs: string[] = [];
    for (const op of operations) {
      if (!boxes.includes(op.textBoxId)) boxes.push(op.textBoxId);
      if (!paragraphs.includes(op.paragraphId)) paragraphs.push(op.paragraphId);
    }
    this.affectedTextBoxes = boxes;
    this.affectedParagraphs = paragraphs;
  }

  execute(document: EditorDocument): EditorDocument {
    // ══ 阶段 1：预验证（零部分执行的关键）══════════════════════════════
    const ops = this.preflight(document);

    // ══ 阶段 2：顺序执行 ══════════════════════════════════════════════
    let next = document;
    for (const spec of ops) {
      // 区间在**当前** document 上解析（前一个 op 可能已产生新的 document 对象）
      const anchor = positionAt(next, spec.paragraphId, spec.startUtf16);
      const focus = positionAt(next, spec.paragraphId, spec.endUtf16);

      if (spec.startUtf16 === spec.endUtf16) {
        // 零宽 + 空替换 = 删除零字符 ⇒ 无意义，跳过
        if (spec.replacement.length === 0) continue;
        next = new InsertTextCommand(anchor, spec.replacement).execute(next);
        continue;
      }
      const range = createTextRange(anchor, focus);
      next =
        spec.replacement.length === 0
          ? new DeleteTextCommand(range).execute(next)
          : new ReplaceTextCommand(range, spec.replacement).execute(next);
    }

    // ★ no-op 诚实：全链未改变 ⇒ 返回**同一引用** ⇒ History 判 changed=false
    return next;
  }

  /** 预验证：全部 op 的身份与区间必须在原 document 上合法 */
  private preflight(document: EditorDocument): readonly UnitTransactionOperation[] {
    if (this.operations.length === 0) {
      throw new CommandError("invalid-range", "UnitTransaction 没有任何 operation");
    }
    const seenParagraphs = new Set<string>();
    for (const spec of this.operations) {
      if (!spec.textBoxId) {
        throw new CommandError("missing-text-box", "UnitTransaction operation 缺 textBoxId");
      }
      if (!spec.paragraphId) {
        throw new CommandError("missing-paragraph", "UnitTransaction operation 缺 paragraphId");
      }
      if (
        !Number.isInteger(spec.startUtf16) ||
        !Number.isInteger(spec.endUtf16) ||
        spec.startUtf16 < 0 ||
        spec.endUtf16 < spec.startUtf16
      ) {
        throw new CommandError(
          "invalid-range",
          `UnitTransaction operation 区间非法：[${spec.startUtf16}, ${spec.endUtf16})`
        );
      }
      if (seenParagraphs.has(spec.paragraphId)) {
        throw new CommandError(
          "duplicate-paragraph-in-transaction",
          `同一段落 "${spec.paragraphId}" 出现多个 operation：第二个 op 的 offset 会因前一个已改文本而失效`
        );
      }
      seenParagraphs.add(spec.paragraphId);

      const found = findTextBoxOfParagraph(document, spec.paragraphId);
      if (!found) {
        throw new CommandError("missing-paragraph", `段落 "${spec.paragraphId}" 不存在`);
      }
      if (found.textBox.id !== spec.textBoxId) {
        throw new CommandError(
          "text-box-mismatch",
          `operation 声明 textBoxId="${spec.textBoxId}"，但段落 "${spec.paragraphId}" 实际属于 "${found.textBox.id}"`
        );
      }
      const length = getParagraphText(found.paragraph).length;
      if (spec.endUtf16 > length) {
        throw new CommandError(
          "invalid-range",
          `区间 [${spec.startUtf16}, ${spec.endUtf16}) 越界：段落 "${spec.paragraphId}" 长度 ${length}`
        );
      }
    }
    return this.operations;
  }
}
