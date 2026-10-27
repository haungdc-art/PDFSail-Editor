/**
 * editor/binding/core-dom-caret.ts — F3B-6.21-G1 · **Core→DOM Caret Reconciliation**
 *
 * ── 为什么要有这个模块 ───────────────────────────────────────────────
 * 6.21-G 审计的结论：今天是 **DOM-selection latest-wins**
 *   （浏览器移动 DOM caret ⇒ `selectionchange` ⇒ 写回 Core）。
 * C5-2 之后 Core 开始 `preventDefault` 接管输入，方向必须反转成 **Core latest-wins**
 * ⇒ 每次 Core 改了 caret/selection，都要把它**写回 DOM Selection**。
 *
 * 在 G1 之前，这件事只有**两个特设落点**，且各自内联一份 TreeWalker：
 *   · F3B-6.21-F2 词删对账（`PDFEditor.tsx`）
 *   · F3B-6.21-E  compositionend D6（`PDFEditor.tsx`）
 * 继续复制第三份（即将到来的 C5-3 navigation 至少 6 个键）是不可接受的。
 *
 * ── 契约 ─────────────────────────────────────────────────────────────
 *   1. **UTF-16**：一切 offset 都是 UTF-16 code unit，与 `extractDomRangeOffsets`
 *      （`./dom-selection-shadow.ts`）同口径 —— **不存在第二套 DOM offset 算法**。
 *   2. **surrogate-safe**：offset 会被收敛到 code point 边界（复用 Core 唯一
 *      `stepBack` primitive），绝不落在代理对中间。
 *   3. **fail-closed**：任一校验不过就**不写** DOM，并返回明确 reason（绝不猜）。
 *   4. **无双写竞争**：`markSynced` **只在成功时**调用 ⇒ 调用方用它更新
 *      `selectionchange` 幂等键，阻断「Core 写 DOM → selectionchange 又写回 Core」的环。
 *   5. **不投影文本**：本模块**只动 Selection**，不写 `textContent`
 *      （守卫 T6a：禁止 Core → DOM 文本投影）。
 */

import { stepBack } from "../core/input";
import type { EditorSelection } from "../core/position";
import { positionToParagraphOffset } from "../core/position";
import type { CoreInputSession } from "./core-input-source";
import { documentOf } from "./core-input-source";

export type CoreDomCaretReason =
  | "no-session"
  | "no-caret"
  | "no-scope"
  // ★ F3B-6.27-STEP4：`scope` 已承载整段（base 无意义）却给了非 0 `segmentStartUtf16`
  //   ⇒ 两个事实互相矛盾。不猜、不静默取其一 ⇒ fail-closed。
  | "base-contradiction"
  | "no-document"
  | "text-mismatch"
  | "offset-out-of-range"
  | "dom-unresolved"
  | "roundtrip-mismatch";

export interface CoreDomCaretResult {
  readonly ok: boolean;
  readonly reason: CoreDomCaretReason | null;
  /** 实际落到 DOM 的 [start, end)（UTF-16）；失败时两个都为 `null` 且 **DOM 未被改写** */
  readonly startOffsetUtf16: number | null;
  readonly endOffsetUtf16: number | null;
}

/** `NodeFilter.SHOW_TEXT` / `Node.TEXT_NODE`（避免依赖全局常量，与 dom-selection-shadow 同手法） */
const SHOW_TEXT = 4;
const TEXT_NODE = 3;

// ─────────────────────────────────────────────────────────────────────
//  ① 纯规划（无 DOM）：offset 归一化 + fail-closed 判定
// ─────────────────────────────────────────────────────────────────────

export interface DomCaretPlanInput {
  /** offset 所参照的文本（通常是 contentEditable 的 `textContent`） */
  readonly text: string;
  readonly startOffsetUtf16: number;
  /** 缺省 = 折叠（与 start 相同） */
  readonly endOffsetUtf16?: number;
  /** 期望文本；提供且与 `text` 不等 ⇒ `text-mismatch`（fail-closed） */
  readonly expectedText?: string;
}

export type DomCaretPlan =
  | { readonly ok: true; readonly start: number; readonly end: number }
  | { readonly ok: false; readonly reason: CoreDomCaretReason };

/** 收敛到 **code point 边界**（复用 Core 唯一 `stepBack`，不另写一份代理对逻辑） */
function snapToCodePoint(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(Math.trunc(offset), text.length));
  if (clamped <= 0 || clamped >= text.length) return clamped;
  const cp = text.codePointAt(clamped);
  return cp !== undefined && cp >= 0xdc00 && cp <= 0xdfff ? stepBack(text, clamped) : clamped;
}

export function planDomCaretOffsets(input: DomCaretPlanInput): DomCaretPlan {
  const { text } = input;
  if (input.expectedText !== undefined && input.expectedText !== text) {
    return { ok: false, reason: "text-mismatch" };
  }
  const rawStart = Number.isFinite(input.startOffsetUtf16) ? input.startOffsetUtf16 : 0;
  const rawEnd = Number.isFinite(input.endOffsetUtf16 ?? rawStart) ? (input.endOffsetUtf16 ?? rawStart) : rawStart;
  if (rawEnd < rawStart) return { ok: false, reason: "offset-out-of-range" };

  const start = snapToCodePoint(text, rawStart);
  const end = snapToCodePoint(text, Math.max(rawEnd, start));
  if (start < 0 || end > text.length || start > end) {
    return { ok: false, reason: "offset-out-of-range" };
  }
  return { ok: true, start, end };
}

// ─────────────────────────────────────────────────────────────────────
//  ② DOM 应用（唯一写入点）
// ─────────────────────────────────────────────────────────────────────

export interface ReconcileDomCaretArgs {
  /** contentEditable 段元素（offset 空间 = 其 `textContent`） */
  readonly scope: HTMLElement | null;
  readonly startOffsetUtf16: number;
  readonly endOffsetUtf16?: number;
  /** 期望的 DOM 文本；提供 ⇒ 漂移时 fail-closed（推荐在**已知**期望值时传入） */
  readonly expectedText?: string;
  /**
   * **仅成功时**回调（用于更新 `selectionchange` 幂等键）。
   * 这是「无 Core/DOM 双写竞争」的结构性保证：不成功 ⇒ 不产生回写环。
   */
  readonly markSynced?: (applied: { start: number; end: number }) => void;
}

const FAIL = (reason: CoreDomCaretReason): CoreDomCaretResult => ({
  ok: false,
  reason,
  startOffsetUtf16: null,
  endOffsetUtf16: null,
});

/**
 * 把 **offset** 写回 DOM Selection（Core→DOM 的唯一入口）。
 *
 * 内部顺序：规划（纯）→ 建 Range → **回读自检** → 才写入。
 * 自检用与 `extractDomRangeOffsets` 完全相同的口径（文档序 + UTF-16 累加），
 * 不一致 ⇒ `roundtrip-mismatch` 且 **DOM 保持原样**。
 */
export function reconcileDomCaretAtOffset(args: ReconcileDomCaretArgs): CoreDomCaretResult {
  const scope = args.scope;
  if (!scope) return FAIL("no-scope");
  const text = scope.textContent ?? "";
  const plan = planDomCaretOffsets({
    text,
    startOffsetUtf16: args.startOffsetUtf16,
    endOffsetUtf16: args.endOffsetUtf16,
    expectedText: args.expectedText,
  });
  if (!plan.ok) return FAIL(plan.reason);

  const doc = scope.ownerDocument;
  if (!doc || typeof doc.createTreeWalker !== "function" || typeof doc.createRange !== "function") {
    return FAIL("no-document");
  }

  const resolve = (target: number): { node: Node; offset: number } | null => {
    let acc = 0;
    const walker = doc.createTreeWalker(scope, SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const len = (node as unknown as { length?: number }).length ?? 0;
      if (target <= acc + len) return { node, offset: target - acc };
      acc += len;
      node = walker.nextNode();
    }
    return null;
  };

  const startHit = resolve(plan.start);
  const endHit = plan.start === plan.end ? startHit : resolve(plan.end);
  if (!startHit || !endHit) return FAIL("dom-unresolved");

  const range = doc.createRange();
  try {
    range.setStart(startHit.node, startHit.offset);
    range.setEnd(endHit.node, endHit.offset);
  } catch {
    return FAIL("dom-unresolved");
  }

  // ★ 回读自检：与 `extractDomRangeOffsets` 同口径重算，不一致 ⇒ 不落盘
  let acc = 0;
  let readStart = -1;
  let readEnd = -1;
  const walker = doc.createTreeWalker(scope, SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const len = (node as unknown as { length?: number }).length ?? 0;
    if (node === range.startContainer) readStart = acc + range.startOffset;
    if (node === range.endContainer) {
      readEnd = acc + range.endOffset;
      break;
    }
    acc += len;
    node = walker.nextNode();
  }
  if (readStart !== plan.start || readEnd !== plan.end) return FAIL("roundtrip-mismatch");

  const view = doc.defaultView;
  const selection = view && typeof view.getSelection === "function" ? view.getSelection() : null;
  if (!selection) return FAIL("no-document");
  selection.removeAllRanges();
  selection.addRange(range);

  args.markSynced?.({ start: plan.start, end: plan.end });
  return { ok: true, reason: null, startOffsetUtf16: plan.start, endOffsetUtf16: plan.end };
}

// ─────────────────────────────────────────────────────────────────────
//  ③ 从 **Core caret / selection** 出发（offset 空间 = 段落文本）
// ─────────────────────────────────────────────────────────────────────

export interface ReconcileFromCoreArgs {
  readonly session: CoreInputSession | null;
  readonly caret: { position: unknown } | null | undefined;
  /** 非折叠选区（Shift+Arrow 等）；缺省用 caret 折叠点 */
  readonly selection?: EditorSelection | null;
  readonly scope: HTMLElement | null;
  /**
   * 期望的 DOM 文本。**强烈建议传** —— 它就是 Core 侧段落文本；
   * 两者不等说明「DOM 与 Core 已漂移」（例如 DOM 被未建模输入改写过）⇒ fail-closed。
   */
  readonly expectedText?: string;
  /**
   * ★ IB-2-D：segment 在 **paragraph 内**的 UTF-16 起点 base（多段行时 > 0；单段行 = 0）。
   * 仅在 `domCarriesWholeParagraph === false` 时有意义。
   *
   * ⚠️ 旧语义（`scope.textContent` 只是该 segment 的**子串**，DOM offset 是 segment-local）：
   *   段落级 offset 必须减 base 才能写回 `scope`。
   * ⚠️ 新语义（`domCarriesWholeParagraph === true`，即 A′ 方案下多段行由**同一个**
   *   contentEditable 承载整段）：DOM offset **已经**是段落级 ⇒ 减 base 会二次错位。
   *   实测：`日期：` + 29 字，A′ 写整段并把 caret 放到 33（正确），
   *   本原语随即把它改回 30（= 33 − 3 = − len("日期：")）⇒ 每次输入后 caret 退 3 字符。
   */
  readonly segmentStartUtf16?: number;
  /**
   * ★ F3B-6.27-STEP4：`scope` 这个 contentEditable 是否承载**整段** Core 段落文本。
   *
   * **必填**（不给默认值、不做推断）：base 是否要减，完全由这个事实决定，而它随
   * 编辑面方案（A′）变化。让 tsc 强制每个调用点显式声明真相，而不是让原语去猜。
   *
   * - `true`  ⇒ `scope.textContent` ≡ Core 段落全文 ⇒ base 必须为 0。
   * - `false` ⇒ `scope.textContent` 只是 segment 子串 ⇒ base = `segmentStartUtf16`。
   *
   * 与 `segmentStartUtf16` 矛盾（`true` 却给了非 0 base）⇒ **fail-closed**
   * 返回 `base-contradiction`，不猜、不静默取其一。
   */
  readonly domCarriesWholeParagraph: boolean;
  readonly markSynced?: (applied: { start: number; end: number }) => void;
}

/**
 * ★ IB-2-D：把 **段落级** anchor/focus UTF-16 offset 减 `segmentStartUtf16`（segment 在
 * paragraph 内的起点 base），还原成 **segment-local** offset（segment contentEditable 的
 * `textContent` 只是该段子串）。`segmentStartUtf16` 缺省 0 ⇒ 单段行向后兼容
 * （segment-local === paragraph-relative）。
 *
 * 纯函数，可单测；下游 `reconcileDomCaretAtOffset` 仍负责 [0, len] 钳制与回读自检。
 */
export function applySegmentBaseToParagraphOffsets(
  anchorParagraphOffset: number,
  focusParagraphOffset: number,
  segmentStartUtf16: number
): { start: number; end: number } {
  const a = anchorParagraphOffset - segmentStartUtf16;
  const f = focusParagraphOffset - segmentStartUtf16;
  return { start: Math.min(a, f), end: Math.max(a, f) };
}

/**
 * ★ F3B-6.27-CARET：把 **陈旧 DOM 折叠光标偏移** 映射到 **Core 段落偏移**。
 *
 * 背景（实测，见 cases/F3B-6.27-Font-Reuse-RootCause-and-Goal2-Verification.md §4）：
 * Core 呈现期 DOM 元素文本被**故意**保持为陈旧的 `segment.text`（`domTextSuppressed`
 * 透明化，Core 为唯一真值）。而 Core 提交后浏览器默认插入已被 `preventDefault` 阻断，
 * DOM 光标不会被浏览器前移 ⇒ 第 2、3… 个字符仍用**同一个陈旧偏移**插入，落在上一个
 * 刚插入字符**之前** ⇒ 连续输入被整体倒序（`ABCD` → `DCBA`）。
 *
 * 契约（**窄、确定性**，任一不满足即原样返回 `domOffset`）：
 *   ① `staleText` 非空；
 *   ② DOM **折叠**光标停在陈旧文本的**末尾**（`domOffset === staleText.length`）；
 *   ③ `coreText` 以 `staleText` 为**前缀**（Core 只在尾部追加，未改中间、未删除）。
 * 满足时，`domOffset` 的语义是「本行末尾」⇒ 映射到 `coreText.length`。
 *
 * 中间编辑 / 尾部删除 / 前缀不成立 ⇒ 条件不满足 ⇒ 行为**逐字节不变**。
 *
 * 纯函数（无 DOM / 无 React / 无文档访问），便于单测锁定。
 */
export function mapStaleAppendCaretOffset(args: {
  /** DOM 上读到的折叠光标偏移（相对陈旧 segment 文本） */
  domOffset: number;
  /** DOM 元素里的陈旧文本（= 未被 Core 写回的 `segment.text`） */
  staleText: string;
  /** Core 文档中该段落的当前文本 */
  coreText: string | null | undefined;
}): number {
  const { domOffset, staleText, coreText } = args;
  if (!coreText) return domOffset;
  if (staleText.length === 0) return domOffset;
  if (domOffset !== staleText.length) return domOffset;
  if (!coreText.startsWith(staleText)) return domOffset;
  return coreText.length;
}

/**
 * ★ F3B-6.27-STEP4：**base 消解规则**（纯函数，可单测 —— 无 DOM 依赖）。
 *
 * 「段落级 offset 写回 `scope` 时要不要减 segment base」完全由一个事实决定：
 * `scope.textContent` 是不是**整段** Core 段落文本。
 *
 * | `domCarriesWholeParagraph` | DOM 文本           | base                    |
 * |---------------------------|--------------------|-------------------------|
 * | `true`                    | Core 段落全文      | **0**（offset 恒等）    |
 * | `false`                   | segment 切片子串   | `segmentStartUtf16`     |
 *
 * 矛盾输入（`true` 却给了非 0 base）⇒ `{ ok: false }`：**不猜、不静默取其一**。
 * 这条 fail-closed 是本契约存在的主要价值 —— IB-2-D 的隐含假设在方案 A 下失效时，
 * 正是靠这种「静默取其一」悄悄错位（实测每次输入 caret 左移 3 字符）。
 */
export function resolveSegmentBaseForScope(args: {
  readonly domCarriesWholeParagraph: boolean;
  readonly segmentStartUtf16?: number;
}): { ok: true; base: number } | { ok: false; reason: "base-contradiction" } {
  const segBase = args.segmentStartUtf16 ?? 0;
  if (args.domCarriesWholeParagraph) {
    if (segBase !== 0) return { ok: false, reason: "base-contradiction" };
    return { ok: true, base: 0 };
  }
  return { ok: true, base: segBase };
}

/**
 * Core caret/selection → DOM Selection。
 *
 * 前提：**DOM 文本 ≡ Core 段落文本**（visual-line 粒度 + `white-space: nowrap` 保证）。
 * 该前提由 `expectedText` 显式校验 —— **不靠假设**。
 *
 * ★ IB-2-D：写回前通过 `applySegmentBaseToParagraphOffsets` 把段落级 offset 减 base，
 * 还原成 segment-local offset 再写 `scope`。
 *
 * ★ F3B-6.27-STEP4：base 是否要减由**必填**入参 `domCarriesWholeParagraph` 显式声明，
 * 不在本函数内推断。
 */
export function reconcileDomCaretFromCore(args: ReconcileFromCoreArgs): CoreDomCaretResult {
  if (!args.session) return FAIL("no-session");
  const caret = args.caret as { position?: unknown } | null | undefined;
  if (!caret || !caret.position) return FAIL("no-caret");
  // ★ STEP4：base 消解走**纯函数**规则（含 base-contradiction fail-closed），不在此内联推断。
  const resolved = resolveSegmentBaseForScope({
    domCarriesWholeParagraph: args.domCarriesWholeParagraph,
    segmentStartUtf16: args.segmentStartUtf16,
  });
  if (!resolved.ok) return FAIL(resolved.reason);
  const base = resolved.base;
  try {
    const document = documentOf(args.session);
    const base = args.segmentStartUtf16 ?? 0;
    const range = args.selection?.range;
    if (range && range.anchor && range.focus) {
      const { start, end } = applySegmentBaseToParagraphOffsets(
        positionToParagraphOffset(document, range.anchor),
        positionToParagraphOffset(document, range.focus),
        base
      );
      return reconcileDomCaretAtOffset({
        scope: args.scope,
        startOffsetUtf16: start,
        endOffsetUtf16: end,
        expectedText: args.expectedText,
        markSynced: args.markSynced,
      });
    }
    return reconcileDomCaretAtOffset({
      scope: args.scope,
      startOffsetUtf16: positionToParagraphOffset(document, caret.position as never) - base,
      expectedText: args.expectedText,
      markSynced: args.markSynced,
    });
  } catch {
    return FAIL("dom-unresolved");
  }
}
