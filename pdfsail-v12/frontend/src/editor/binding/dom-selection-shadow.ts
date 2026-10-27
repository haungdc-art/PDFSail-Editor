/**
 * editor/binding/dom-selection-shadow.ts — F3B-6.17-3C-10S.2
 *
 * **DOM Selection Shadow Adapter**（纯模块，contract/shadow-only，**不接生产**）。
 *
 * ── 目标 ─────────────────────────────────────────────────────────────
 * 证明**真实 DOM Selection** 能被稳定转换成 3C-10S.1 定义的 `CanonicalSelection`：
 *
 *      real DOM Range
 *           ↓  text-node walker（UTF-16 累加）
 *      neutral input { segmentId, startOffsetUtf16, endOffsetUtf16 }
 *           ↓  segment identity resolution
 *           ↓  UTF-16 bounds validation
 *      CanonicalSelection
 *
 * ── 架构上锁死的规则 ─────────────────────────────────────────────────
 *   · **绝不做** `UTF-16 → glyph` 转换（会把 emoji / ligature 的坐标问题带回来）。
 *     链路只有：`DOM → UTF-16 → CanonicalSelection`。
 *   · 输入是**中性数据结构**，**不依赖** `FloatingToolbar.SelectionInfo`。
 *   · 不接生产：不碰 `window.getSelection()` 生产路径、不碰 `FloatingToolbar` /
 *     `PDFEditor` / `currentDerivedSelectionRef` / `MapCurrentSelectionProvider` /
 *     `EditTool` / Capability。
 *   · 不修改 `DocumentSelection`。
 */

import {
  domSelectionToCanonical,
  type CanonicalSelection,
  type CanonicalSelectionRejection,
  type DomSelectionRangeInput,
} from "./canonical-selection";

// ─────────────────────────────────────────────────────────────────────
//  DOM → UTF-16（text-node walker；与生产算法同口径，但为纯函数）
// ─────────────────────────────────────────────────────────────────────

/** DOM `Range` 的最小结构（只取 walker 需要的 4 个字段） */
export interface DomRangeLike {
  readonly startContainer: Node;
  readonly startOffset: number;
  readonly endContainer: Node;
  readonly endOffset: number;
}

export type DomRangeOffsetsResult =
  | { readonly ok: true; readonly startOffsetUtf16: number; readonly endOffsetUtf16: number }
  | { readonly ok: false; readonly reason: "dom-range-unresolved" };

/** `NodeFilter.SHOW_TEXT`（避免依赖全局 `NodeFilter`） */
const SHOW_TEXT = 4;

/** `Node.ELEMENT_NODE`（避免依赖全局 `Node`） */
const ELEMENT_NODE = 1;

/**
 * 从一个 DOM 节点向上找到最近的 `[data-segment-id]` 元素。
 *
 * 生产用途（3C-10S.3B-1）：`selectionchange` 边界只拿得到 `Range`，
 * 需要把 `commonAncestorContainer` 解析回承载该选区的 EditableTextNode。
 *
 * 找不到 ⇒ `null`。调用方**必须 fail-closed**（`sink.clear()`），
 * **绝不**回退到 glyph selection。
 */
export function findSegmentElement(node: Node | null): Element | null {
  if (!node) return null;
  const isElement = (node as unknown as { nodeType?: number }).nodeType === ELEMENT_NODE;
  let el: unknown = isElement ? node : ((node as unknown as { parentElement?: unknown }).parentElement ?? null);
  while (el) {
    const getAttribute = (el as { getAttribute?: unknown }).getAttribute;
    if (typeof getAttribute === "function") {
      const id = (getAttribute as (name: string) => string | null).call(el, "data-segment-id");
      if (id) return el as Element;
    }
    el = (el as { parentElement?: unknown }).parentElement ?? null;
  }
  return null;
}

/**
 * 真实 DOM `Range` → segment 内 **UTF-16 [start, end)** 偏移。
 *
 * 口径与生产 `FloatingToolbar` 的 TextNode walker 完全一致：
 * 按文档顺序遍历 `segmentElement` 下的文本节点，累加 `node.length`（UTF-16 code unit）；
 * 命中 `startContainer` / `endContainer` 时记录 `acc + range.*Offset`。
 *
 * ⚠️ `node.length` 是 **UTF-16 code unit 数** ⇒ emoji(2) / ligature("fi"=2) 天然正确，
 *    无需任何 glyph 概念。
 */
export function extractDomRangeOffsets(input: {
  readonly range: DomRangeLike;
  readonly segmentElement: Node;
}): DomRangeOffsetsResult {
  const { range, segmentElement } = input;
  const doc = (segmentElement as unknown as { ownerDocument?: Document }).ownerDocument;
  if (!doc || typeof doc.createTreeWalker !== "function") {
    return { ok: false, reason: "dom-range-unresolved" };
  }

  let start = -1;
  let end = -1;
  let acc = 0;
  const walker = doc.createTreeWalker(segmentElement, SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    const len = (node as unknown as { length?: number }).length ?? 0;
    if (node === range.startContainer) start = acc + range.startOffset;
    if (node === range.endContainer) {
      end = acc + range.endOffset;
      break;
    }
    acc += len;
    node = walker.nextNode();
  }

  if (start < 0 || end < 0) return { ok: false, reason: "dom-range-unresolved" };
  return { ok: true, startOffsetUtf16: start, endOffsetUtf16: end };
}

// ─────────────────────────────────────────────────────────────────────
//  Shadow Adapter（neutral input → CanonicalSelection）
// ─────────────────────────────────────────────────────────────────────

/** segment 身份 + 文本长度（由调用方解析；本模块不知道 segment 结构） */
export interface SegmentIdentity {
  readonly blockId: string;
  readonly lineId: string;
  /** 该 segment 的 UTF-16 文本长度（bounds 校验用） */
  readonly textLengthUtf16: number;
}

export interface DomShadowDeps {
  readonly resolveSegment: (segmentId: string) => SegmentIdentity | null;
  /**
   * ★ IB-2-B：segment 在 **paragraph 内**的 UTF-16 起点 base（多段行时 > 0）。
   * 缺省 / 返回 null ⇒ 0（单段行向后兼容）。由生产 `segmentsRef` 累加同 lineId 段文本长度提供。
   */
  readonly segmentStartOffsetUtf16Of?: (segmentId: string) => number | null;
}

export type DomShadowResult =
  | { readonly ok: true; readonly selection: CanonicalSelection }
  | { readonly ok: false; readonly reason: CanonicalSelectionRejection | "dom-range-unresolved" };

/**
 * DOM selection（中性输入）→ `CanonicalSelection`。
 *
 * ★ IB-2-B：segment-local → paragraph-relative 的唯一加法发生在
 * `domSelectionToCanonical`（`deps.segmentStartOffsetUtf16Of` 提供 base）。
 * 本函数只做中性适配，不自行换算坐标。
 */
export function domSelectionShadow(
  ranges: ReadonlyArray<DomSelectionRangeInput>,
  deps: DomShadowDeps
): DomShadowResult {
  const identityOf = (segmentId: string): SegmentIdentity | null => deps.resolveSegment(segmentId);
  return domSelectionToCanonical(ranges, {
    resolveSegmentIdentity: (id) => {
      const s = identityOf(id);
      return s ? { blockId: s.blockId, lineId: s.lineId } : null;
    },
    segmentTextLengthOf: (id) => identityOf(id)?.textLengthUtf16 ?? null,
    segmentStartOffsetUtf16Of: deps.segmentStartOffsetUtf16Of,
  });
}

/**
 * **端到端 shadow**：真实 DOM `Range` + segment 元素 → `CanonicalSelection`。
 *
 * 两步：① `extractDomRangeOffsets`（DOM → UTF-16）② `domSelectionShadow`（→ canonical）。
 * 任一步失败 ⇒ 明确 reason（绝不 fallback、绝不猜）。
 */
export function domRangeToCanonicalShadow(args: {
  readonly range: DomRangeLike;
  readonly segmentElement: Node;
  readonly segmentId: string;
  readonly deps: DomShadowDeps;
}): DomShadowResult {
  const offsets = extractDomRangeOffsets({ range: args.range, segmentElement: args.segmentElement });
  if (!offsets.ok) return offsets;
  return domSelectionShadow(
    [
      {
        segmentId: args.segmentId,
        startOffsetUtf16: offsets.startOffsetUtf16,
        endOffsetUtf16: offsets.endOffsetUtf16,
      },
    ],
    args.deps
  );
}
