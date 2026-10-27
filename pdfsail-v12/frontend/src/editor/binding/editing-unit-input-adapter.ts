/**
 * editing-unit-input-adapter.ts — F3B-6.27 · P0-D0 · Slice 1
 *
 * 唯一职责：把「浏览器 input intent」标准化成 **EditingUnit mutation intent**
 *   { unitText, domStart, domEnd, inputType, data }
 *        ↓
 *   { kind, unitStart, unitEnd, replacementText }
 *        ↓
 *   P0-D `planUnitMutationMulti(unit, unitStart, unitEnd, replacementText)`
 *
 * ── 冻结边界（Slice 1 = 到此为止）──────────────────────────────
 *   ✅ 产出 { unitStart, unitEnd, replacementText }
 *   ❌ 不构造 Core Command、不 commit、不碰 History、不做 rebind/reflow
 *   ❌ 不接 PDFEditor / React / 真实 DOM；不消费 separator（归 P0-D plan）
 *
 * ── 五条冻结细节 ────────────────────────────────────────────────
 *   1. `unitText` 是唯一文本真值：只读它做 bounds 校验与 code point 位移；
 *      **不接受** segment.text、paragraph slice，也不重新拼接。
 *   2. offset 口径 = UTF-16（与 EditingUnit / DOM textContent 一致）；
 *      只有 deleteBackward/Forward 的 **caret 位移**按 code point。
 *   3. separator 不由本模块消费：只产出半开区间 + replacementText。
 *   4. 越界 fail-closed：**绝不 clamp**。
 *   5. IME 不建立第二套路径：insertCompositionText → 同一个 insert intent。
 *
 * ★ 简化（有真实 Chromium 证据）：unit surface 的 DOM 文本恒等于 `unit.text`
 *   （实测 40 = 32 + "\n" + 7）⇒ DOM offset ≡ unit offset
 *   ⇒ 本模块**不需要任何 base / slice 运算**（单 paragraph 面才需要）。
 *
 * 硬边界：0 React / 0 DOM / 0 Core import / 0 Command / 0 History / 0 PDFEditor
 */

// ── 支持的 input 事件（封闭集合；**先判定，后解析区间**）──────────────
// ⚠️ 顺序理由（沿用 text-edit-input-adapter 的既有教训）：若先解析区间，
//   未建模事件会先被 out-of-bounds 之类理由拒绝，掩盖「本事件根本不支持」。
const INSERT_TYPES: readonly string[] = ["insertText", "insertCompositionText", "insertFromPaste"];
const DELETE_BACKWARD_TYPES: readonly string[] = ["deleteContentBackward"];
const DELETE_FORWARD_TYPES: readonly string[] = ["deleteContentForward"];

export type UnitInputKind = "insert" | "replace" | "delete";

export interface EditingUnitInputRequest {
  /** 唯一文本真值：`unit.text`（不得由调用方重新拼接） */
  readonly unitText: string;
  /** 事件当下的 DOM 选区起点（UTF-16，含） */
  readonly domStart: number;
  /** 事件当下的 DOM 选区终点（UTF-16，不含） */
  readonly domEnd: number;
  /** beforeinput 的 `inputType` */
  readonly inputType: string;
  /** 插入文本（insert* 必填；delete* 必须 null/undefined） */
  readonly data?: string | null;
}

export type EditingUnitInputFailure =
  | "empty-unit-text"
  | "unsupported-input-type"
  | "empty-insert-data"
  | "non-integer-offset"
  | "negative-offset"
  | "reversed-range"
  | "out-of-bounds"
  | "delete-at-boundary";

export interface EditingUnitInputIntent {
  readonly kind: UnitInputKind;
  /** 半开区间 [unitStart, unitEnd)，UTF-16，unit 坐标 */
  readonly unitStart: number;
  readonly unitEnd: number;
  /** 替换文本；delete 恒为 "" */
  readonly replacementText: string;
  /** delete 实际跨过的 code point 数（未跨时 0） */
  readonly deletedCodePoints: number;
}

export type EditingUnitInputOutcome =
  | {
      readonly ok: true;
      readonly intent: EditingUnitInputIntent;
      /**
       * **事务成功后 caret 应落的 UTF-16 unit offset**（F5 裁决 B：由 intent 派生）。
       *
       *   insert / replace：`unitStart + replacementText.length`（UTF-16）
       *   delete：`unitStart`
       *
       * ★ 口径纪律：
       *   · 本字段是 **UTF-16**（与 `unit.text` / DOM `textContent` 同口径），不是 code point。
       *   · 本模块只负责 **mutation semantics**，**不做 caret boundary 收敛**；
       *     收敛仍由 `planDomCaretOffsets`（core-dom-caret）独家负责 ⇒ 不产生第二套 caret 规则。
       *   · 依据：Core `UnitTransactionCommand` **不产出 caret**（实测零命中），
       *     故 caret 位置只能由「事务语义本身」确定，而非从 Core 反推。
       *   · 只在事务**成功**后使用；失败不得留下待恢复的 caret（见 PendingUnitCaret）。
       */
      readonly postMutationUnitOffset: number;
      /**
       * **事务成功后应呈现的 unit 文本**（= 本次 mutation 的确定性结果）。
       *
       * ★ 它同时是 caret 恢复的**交叉验证基准**：只有当 Core 事后算出的 unit 文本
       *   与它**逐字节相等**时才恢复 caret；不等 ⇒ 不恢复（fail-closed）。
       *   ⇒ 若 adapter 的 intent 与 Core 的 splice 出现分歧，表现为「不恢复 caret」，
       *     而**不是**把光标放到错误位置。
       */
      readonly postMutationText: string;
    }
  | { readonly ok: false; readonly reason: EditingUnitInputFailure };

const fail = (reason: EditingUnitInputFailure): EditingUnitInputOutcome => ({ ok: false, reason });

/** 向前（index 减小）跨过 count 个 code point；emoji/ligature/组合字符算 1 个。 */
function offsetBeforeCodePoints(text: string, index: number, count: number): number {
  let i = index;
  let moved = 0;
  while (i > 0 && moved < count) {
    const at = i - 2 >= 0 ? i - 2 : i - 1;
    const cp = text.codePointAt(at) ?? 0;
    i -= cp > 0xffff ? 2 : 1;
    moved += 1;
  }
  return i;
}

/** 向后（index 增大）跨过 count 个 code point。 */
function offsetAfterCodePoints(text: string, index: number, count: number): number {
  let i = index;
  let moved = 0;
  while (i < text.length && moved < count) {
    const cp = text.codePointAt(i) ?? 0;
    i += cp > 0xffff ? 2 : 1;
    moved += 1;
  }
  return i;
}

/**
 * 把浏览器 input intent 标准化为 EditingUnit mutation intent。
 * 纯函数：不读 DOM / window，不构造 Command，不访问 EditorDocument。
 */
export function toEditingUnitInputIntent(req: EditingUnitInputRequest): EditingUnitInputOutcome {
  // ① 唯一文本真值
  //   ★ 只拒绝「真值缺失」（非字符串）；**空文本是合法内容状态**（空 cell / 被删空的
  //     unit 面），不得拒绝 —— 否则该面将无法继续输入（B 轮缺陷 B-F1，契约 §16.1）。
  //     空文本下的语义由既有判据覆盖：insert ⇒ s=e=0 合法（e > 0 为假 ⇒ 放行），
  //     delete ⇒ ⑥ 的 code point 位移在空串上 next === s ⇒ delete-at-boundary。
  const text = req.unitText;
  if (typeof text !== "string") return fail("empty-unit-text");

  // ② inputType 封闭集合（**先于**区间解析）
  const isInsert = INSERT_TYPES.includes(req.inputType);
  const isDeleteBack = DELETE_BACKWARD_TYPES.includes(req.inputType);
  const isDeleteFwd = DELETE_FORWARD_TYPES.includes(req.inputType);
  if (!isInsert && !isDeleteBack && !isDeleteFwd) return fail("unsupported-input-type");

  // ③ insert* 的 data 有效性
  if (isInsert && (typeof req.data !== "string" || req.data.length === 0)) {
    return fail("empty-insert-data");
  }

  // ④ offset 形状（不 clamp）
  const s = req.domStart;
  const e = req.domEnd;
  if (!Number.isInteger(s) || !Number.isInteger(e)) return fail("non-integer-offset");
  if (s < 0 || e < 0) return fail("negative-offset");
  if (s > e) return fail("reversed-range");
  if (e > text.length) return fail("out-of-bounds");

  // ⑤ insert / replace（IME 走同一条路径）
  if (isInsert) {
    const kind: UnitInputKind = s === e ? "insert" : "replace";
    const replacementText = req.data as string;
    return {
      ok: true,
      intent: { kind, unitStart: s, unitEnd: e, replacementText, deletedCodePoints: 0 },
      // insert / replace：caret 落在替换文本**之后**（UTF-16；emoji 按 2 计，与 DOM textContent 同口径）
      postMutationUnitOffset: s + replacementText.length,
      postMutationText: text.slice(0, s) + replacementText + text.slice(e),
    };
  }

  // ⑥ delete：非折叠 ⇒ 选区删除（确定性，非猜测）；折叠 ⇒ 按 code point 位移
  let from = s;
  let to = e;
  let deletedCodePoints = 0;
  if (s === e) {
    if (isDeleteBack) {
      const next = offsetBeforeCodePoints(text, s, 1);
      if (next === s) return fail("delete-at-boundary");
      from = next;
      deletedCodePoints = 1;
    } else {
      const next = offsetAfterCodePoints(text, s, 1);
      if (next === s) return fail("delete-at-boundary");
      to = next;
      deletedCodePoints = 1;
    }
  } else {
    deletedCodePoints = -1; // 选区删除：code point 数无意义
  }
  return {
    ok: true,
    intent: { kind: "delete", unitStart: from, unitEnd: to, replacementText: "", deletedCodePoints },
    // delete：caret 落在被删区间**起点** `from`。
    // ★ 该偏移必已是 code point 边界（`from` 来自 code point 位移或选区端点），
    //   但本模块**不**据此宣称安全 —— 收敛仍由 `planDomCaretOffsets` 独家负责。
    postMutationUnitOffset: from,
    postMutationText: text.slice(0, from) + text.slice(to),
  };
}
