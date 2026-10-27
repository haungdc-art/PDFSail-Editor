/**
 * editor/binding/segment-commit-slice.ts — F3B-6.27 · 编辑面提交收口（纯 contract）
 *
 * 问题（实测取证）：A′ 方案 A 让编辑面承载完整 Core 段落
 * （PDFEditor.tsx:5387 / :5588 `scope.textContent = <整段>`），而 blur 提交读同一份 DOM：
 *   EditableTextNode.tsx:175 newText = textContent     -> 整段（32 字）
 *   EditableTextNode.tsx:176 newText !== segment.text  -> 与本段切片（29 字）不等，必然成立
 *   -> onChange -> PDFCanvas.tsx:1720 handleSegmentChange(id, 整段)
 *   -> useSelection.ts:105-106 editedSegmentsRef.set + {...s, text: 整段}
 *   => isModified 变 true => 该段 Legacy 面（此前恒透明）开始自绘
 *   => 与 owned 编辑面并排画出两个「日期：」（实测 surfacesStartingWithDateLabel=2）
 *
 * 该判据与是否输入过字符无关：「进入多段行编辑 -> 零输入 -> 点空白退出」同样污染。
 *
 * 收口原则：A′ 拥有整段 DOM；Legacy 只收到自己那一片切片。range 只能来自 Binding
 * 已建立的 SegmentRangeOwnership（segmentRangeOf），绝不允许 UI 用
 * `paragraphText + segment.text` 反推（会散落出 UTF-16/code-point、半开/闭区间、
 * 段内偏移/段落偏移的第二套实现）。本模块是 `sliceTextOfSegment` 的窄投影（只吃 range）。
 *
 * 纪律：纯函数（零 React/DOM/Core import/坐标/indexOf）；不改 segment.text /
 * originalText；非 whole-paragraph surface 原样 passthrough（既有行为逐字节不变）；
 * whole-paragraph surface + range 缺失/identity 不匹配 => fail-closed。
 */

/** 本段在 Core 段落中的区间投影（由 Binding ownership 决定；UI 不得自算） */
export interface SegmentRangeProjection {
  readonly paragraphId: string;
  readonly segmentId: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
  /** Core document generation（EditorDocument.version）—— stale fence */
  readonly generation: number;
}

/**
 * Binding projection primitive：按既定 range 把段落文本投影成段切片。
 *
 * 与 `sliceTextOfSegment` 同语义：上界 clamp 到段落长度（编辑中段落变短时 ownership
 * 可能暂时超出，clamp 属既定 contract，不是新行为）。
 */
export function sliceTextByRange(
  range: Pick<SegmentRangeProjection, "startUtf16" | "endUtf16">,
  paragraphText: string
): string {
  return paragraphText.slice(range.startUtf16, Math.min(range.endUtf16, paragraphText.length));
}

/**
 * range 的结构合法性。
 *
 * ⚠️ 与既有 `sliceTextOfSegment` **完全同口径**（这是刻意的，不引入第二套语义）：
 *   · `startUtf16 > 段落长度` ⇒ 不合法（既有实现此时返回 null）
 *   · `endUtf16 > 段落长度`   ⇒ **合法**，由 `sliceTextByRange` clamp 到长度
 *     （编辑中段落变短时 ownership 可能暂时超出，clamp 是既有 contract 的一部分）
 *   · 反向（start > end）/ 负数 / 非整数 ⇒ 不合法
 */
export function isUsableSegmentRange(
  range: Pick<SegmentRangeProjection, "startUtf16" | "endUtf16">,
  paragraphTextLength: number
): boolean {
  return (
    Number.isInteger(range.startUtf16) &&
    Number.isInteger(range.endUtf16) &&
    range.startUtf16 >= 0 &&
    range.startUtf16 <= range.endUtf16 &&
    range.startUtf16 <= paragraphTextLength
  );
}

export type SegmentCommitSliceReason =
  | "not-whole-paragraph-surface"
  | "sliced-by-range"
  | "range-missing"
  | "segment-identity-mismatch"
  | "paragraph-identity-mismatch"
  | "stale-generation"
  | "range-unusable";

export interface ResolveSegmentCommitSliceInput {
  /**
   * regime 事实：该 DOM 面是否承载**完整 Core 段落**。
   * 必须由既有事实判据给出（`wholeParagraphSurfaceRef` /
   * `domSurfaceCarriesWholeParagraph`），**不得**由「DOM 文本是否等于段落文本」反推。
   */
  readonly domCarriesWholeParagraph: boolean;
  /** DOM 上的当前文本（whole-paragraph 模式下 = Core 段落全文） */
  readonly domText: string;
  readonly segmentId: string;
  /** 当前编辑段的既有文本（调用方据此判断是否提交；本模块不改它） */
  readonly segmentText: string;
  /** Binding ownership 发布的 range；null = 尚未建立 */
  readonly range: SegmentRangeProjection | null;
  /** 当前权威 paragraphId（null/undefined = 不可知） */
  readonly currentParagraphId: string | null | undefined;
  /** 当前 Core document generation（null/undefined = 不可知） */
  readonly currentGeneration: number | null | undefined;
}

export type SegmentCommitSliceDecision =
  | {
      readonly ok: true;
      readonly kind: "passthrough";
      readonly text: string;
      readonly reason: "not-whole-paragraph-surface";
    }
  | {
      readonly ok: true;
      readonly kind: "sliced";
      readonly text: string;
      readonly reason: "sliced-by-range";
      readonly range: SegmentRangeProjection;
    }
  | {
      readonly ok: false;
      readonly kind: "fail-closed";
      /** 不得提交任何文本（不 onChange => 不污染 segment.text、不触发 canonical fallback） */
      readonly text: null;
      readonly reason: Exclude<
        SegmentCommitSliceReason,
        "not-whole-paragraph-surface" | "sliced-by-range"
      >;
    };

type FailReason = Exclude<
  SegmentCommitSliceReason,
  "not-whole-paragraph-surface" | "sliced-by-range"
>;

const fail = (reason: FailReason): SegmentCommitSliceDecision => ({
  ok: false,
  kind: "fail-closed",
  text: null,
  reason,
});

/**
 * 决定「编辑面退出时，本段该收到什么文本」。
 *
 * fail-closed 的语义（与「ownership 缺失怎么办」不是同一件事）：已进入
 * whole-paragraph 模式却发现 `range` 缺失/不匹配，是一个**内部契约异常**（正常
 * 控制流下 ownership 先于整段写入建立，见 `PDFEditor.tsx:5277` < `:5588`），
 * 此时**不得**把整段回灌 Legacy。
 */
export function resolveSegmentCommitSlice(
  input: ResolveSegmentCommitSliceInput
): SegmentCommitSliceDecision {
  const { domCarriesWholeParagraph, domText, segmentId, segmentText, range } = input;

  // 1) 非 whole-paragraph surface => DOM 本来就是段切片 => 逐字节保持既有行为。
  if (!domCarriesWholeParagraph) {
    return { ok: true, kind: "passthrough", text: domText, reason: "not-whole-paragraph-surface" };
  }

  // 2) whole-paragraph surface => 必须有合法且 identity 匹配的 range。
  if (!range) return fail("range-missing");
  if (range.segmentId !== segmentId) return fail("segment-identity-mismatch");
  if (input.currentParagraphId != null && range.paragraphId !== input.currentParagraphId) {
    return fail("paragraph-identity-mismatch");
  }
  if (input.currentGeneration != null && range.generation !== input.currentGeneration) {
    return fail("stale-generation");
  }
  if (!isUsableSegmentRange(range, domText.length)) return fail("range-unusable");

  // 3) 按 Binding 已定的 range 执行 projection（UI 不计算 ownership）。
  const text = sliceTextByRange(range, domText);
  // 4) 若 text === segmentText，调用方天然不会 onChange
  //    （「零输入进入编辑再退出」正是这一支 => 污染被根除，而非靠额外 if 拦截）。
  void segmentText;
  return { ok: true, kind: "sliced", text, reason: "sliced-by-range", range };
}