/**
 * multi-selection.ts — F3B-6.27 · P0-VPS（D1'）**显式多选集合**
 *
 * ── 为什么需要它（而不是 props）────────────────────────────────────
 * `EditableTextNode` 由 **`PDFCanvas`** 渲染（冻结文件，不在允许改动清单内）。
 * 要把"哪些 segment 被显式多选"传给它，走 props 必须连带改 `PDFCanvas`。
 * 因此沿用 `core-input-visual.ts` 已确立的**极小外部 store** 惯例：
 * 集合自己维护，`EditableTextNode` 用 `useSyncExternalStore` 订阅。
 *
 * ── 存在的理由（D1' 的证据链）─────────────────────────────────────
 * 跨行范围在这个 UI 下**拿不到浏览器的原生选区**（实测证伪）：
 *   · 每个 segment 是独立的 `position:absolute` 元素；
 *   · `mousedown` 已被"进入编辑"占用；
 *   · DOM selection 不跨元素扩展 ⇒ 拖选只能落在单段内。
 *   · Shift+点击同样不成立（无原生 anchor 可依附）。
 * ⇒ 跨行范围只能由**我们自己维护的选中集合**承载，语义最贴近"用户选哪几段就编辑哪几段"。
 *
 * ── 它**不是** document state ──────────────────────────────────────
 * 只承载 **UI 选择意图**（一组 segmentId）。**不保存文本、不做投影、不进 history**。
 * 与 `core-input-visual` 同一边界：本模块没有任何文本字段。
 *
 * ── 依赖 ───────────────────────────────────────────────────────────
 * 零依赖（不 import React，不 import Core）。订阅方自行用 React 粘合。
 */

export interface MultiSelectionState {
  /** 被显式多选的 segmentId（**顺序无关** —— 判定时按文档顺序取首尾） */
  readonly segmentIds: ReadonlyArray<string>;
}

const EMPTY: MultiSelectionState = { segmentIds: [] };

let state: MultiSelectionState = EMPTY;
const listeners = new Set<() => void>();

function emit(next: MultiSelectionState): void {
  state = next;
  // 供 e2e / DevTools 直接读（与既有 `window.__*` 观测面惯例一致）
  try {
    (window as any).__multiSelectedSegmentIds = next.segmentIds;
  } catch {
    /* 非浏览器环境（单测）忽略 */
  }
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* 单个订阅者异常不得影响其它订阅者 */
    }
  }
}

export function getMultiSelectionState(): MultiSelectionState {
  return state;
}

export function getMultiSelectedSegmentIds(): ReadonlyArray<string> {
  return state.segmentIds;
}

export function subscribeMultiSelection(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function isMultiSelected(segmentId: string): boolean {
  return state.segmentIds.indexOf(segmentId) >= 0;
}

/**
 * 切换某 segment 的多选成员身份（Ctrl/Cmd+点击）。
 *
 * ⚠️ **不清空**其它已选成员 —— 这正是"多选"与"单选"的区别。
 * 退出/清空由调用方显式调 `clearMultiSelection()`（如进入编辑态时）。
 */
export function toggleMultiSelected(segmentId: string): void {
  if (!segmentId) return;
  const has = isMultiSelected(segmentId);
  emit({
    segmentIds: has
      ? state.segmentIds.filter((id) => id !== segmentId)
      : [...state.segmentIds, segmentId],
  });
}

/** 用给定集合**整体替换**（供观测/测试/外部同步使用；`null` = 清空）。 */
export function setMultiSelection(segmentIds: ReadonlyArray<string> | null): void {
  const next = (segmentIds ?? []).filter((id): id is string => typeof id === "string" && id.length > 0);
  emit({ segmentIds: next.length ? Array.from(new Set(next)) : EMPTY.segmentIds });
}

export function clearMultiSelection(): void {
  emit(EMPTY);
}