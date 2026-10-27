/**
 * cross-line-selection-range.ts — 「拖选跨行」范围的**纯判定**（F3B-6.27 · P0-VPS 最小第一步）。
 *
 * 背景（cases/F3B-6.27-P0VPS-...md §13）：
 *   1 legacy 行 = 1 Core TextBox = 1 Core paragraph，而 Core 命令层**明确拒绝跨 TextBox**
 *   （`delete-text.ts:37` / `replace-text.ts:43` / `set-text-style.ts:43` 均抛 `cross-text-box`）。
 *   ⇒ 「一个编辑面覆盖多个 legacy 行」必须先有**范围判定**，且该判定必须是**用户显式意图**
 *      （§6 已用 1390 个 block 证明几何推断不可靠）。
 *
 * 本模块**只做判定**：给定「DOM 选区起止所属 segment」+「文档顺序的 segment 列表」，
 * 产出被覆盖的 blockId / segmentIds / lineIds / paragraphIds。
 *
 * ⚠️ 刻意不包含：编辑面几何、偏移映射、任何 mutation、任何 DOM 访问。
 *    （几何与映射契约在 `core-editing-surface-geometry.ts`，本轮不接线。）
 *
 * ⚠️ fail-closed 优先：任何一处不确定 ⇒ 返回 reason，**绝不猜测范围**。
 */

/** 判定失败原因（封闭集合，便于测试与观测） */
export type CrossLineRangeReason =
  /** 没有 segment 列表 */
  | "no-segments"
  /** DOM 选区起点未落在任何 segment 上 */
  | "no-anchor"
  /** DOM 选区终点未落在任何 segment 上 */
  | "no-focus"
  /** 起点 segment 不在给定列表中 */
  | "anchor-not-found"
  /** 终点 segment 不在给定列表中 */
  | "focus-not-found"
  /** 起止跨越了不同的 block（不做跨 block 合并） */
  | "cross-block"
  /** 区间内存在无 blockId 的 segment */
  | "missing-block-id"
  /** 区间内存在无 lineId 的 segment（无 PDF provenance ⇒ 不建范围） */
  | "missing-line-id"
  /** lineId 解析不出 paragraphId（Core 文档未就绪 / 陈旧 generation） */
  | "unresolved-paragraph"
  /** 去重后只有一个段落 ⇒ 不是跨行范围，应走现有单段路径（**逐字节不变**） */
  | "single-paragraph"
  /** 选中集合为空（D1' 多选入口） */
  | "empty-selection"
  /** 选中集合里的 segment 都不在给定列表中（D1' 多选入口） */
  | "selection-not-found";

export interface CrossLineSegmentInput {
  readonly id: string;
  readonly source?: {
    readonly blockId?: string;
    readonly lineId?: string;
  };
}

export interface CrossLineRangeInput {
  /** **文档顺序**（DOM 顺序）的 segment 列表 */
  readonly segments: ReadonlyArray<CrossLineSegmentInput>;
  /** DOM 选区起点所属 segment id（可为空 ⇒ fail-closed） */
  readonly anchorSegmentId: string | null;
  /** DOM 选区终点所属 segment id（可为空 ⇒ fail-closed） */
  readonly focusSegmentId: string | null;
  /**
   * lineId → paragraphId。
   * 生产应传 `coreParagraphIdForLineId(coreDoc, lineId)`
   * —— 与 editingSurface / A′ effect 用**同一个已验证解析器**，绝不裸比 source.lineId。
   */
  readonly resolveParagraph: (lineId: string) => string | null;
}

export interface CrossLineRange {
  readonly blockId: string;
  readonly segmentIds: readonly string[];
  /** 去重后的 legacy 行 id（同一行多个 segment 共享一个 lineId） */
  readonly lineIds: readonly string[];
  /** 去重后的 Core paragraph id，**顺序 = 文档顺序** */
  readonly paragraphIds: readonly string[];
}

export type CrossLineRangeResult =
  | { readonly ok: true; readonly range: CrossLineRange }
  | { readonly ok: false; readonly reason: CrossLineRangeReason };

/**
 * 判定「拖选跨行」覆盖的范围。
 *
 * 支持**反向拖选**（focus 在 anchor 之前）：内部按索引取 [min, max]，
 * 输出始终是文档顺序。
 */
export function resolveCrossLineRange(input: CrossLineRangeInput): CrossLineRangeResult {
  const segments = input.segments ?? [];
  if (segments.length === 0) return { ok: false, reason: "no-segments" };

  if (input.anchorSegmentId === null || input.anchorSegmentId === undefined) {
    return { ok: false, reason: "no-anchor" };
  }
  if (input.focusSegmentId === null || input.focusSegmentId === undefined) {
    return { ok: false, reason: "no-focus" };
  }

  const anchorIdx = segments.findIndex((s) => s.id === input.anchorSegmentId);
  const focusIdx = segments.findIndex((s) => s.id === input.focusSegmentId);
  if (anchorIdx < 0) return { ok: false, reason: "anchor-not-found" };
  if (focusIdx < 0) return { ok: false, reason: "focus-not-found" };

  const lo = Math.min(anchorIdx, focusIdx);
  const hi = Math.max(anchorIdx, focusIdx);
  const picked = segments.slice(lo, hi + 1);

  // ① 同 block 校验（跨 block 不做合并）
  let blockId: string | null = null;
  for (const s of picked) {
    const b = s.source?.blockId;
    if (typeof b !== "string" || b.length === 0) return { ok: false, reason: "missing-block-id" };
    if (blockId === null) blockId = b;
    else if (blockId !== b) return { ok: false, reason: "cross-block" };
  }
  if (blockId === null) return { ok: false, reason: "missing-block-id" };

  // ② lineId 校验（无 PDF provenance ⇒ 不建范围）
  const lineIds: string[] = [];
  for (const s of picked) {
    const l = s.source?.lineId;
    if (typeof l !== "string" || l.length === 0) return { ok: false, reason: "missing-line-id" };
    if (lineIds.indexOf(l) < 0) lineIds.push(l);
  }

  // ③ lineId → paragraphId（同一个已验证解析器）
  const paragraphIds: string[] = [];
  for (const l of lineIds) {
    const p = input.resolveParagraph(l);
    if (typeof p !== "string" || p.length === 0) return { ok: false, reason: "unresolved-paragraph" };
    if (paragraphIds.indexOf(p) < 0) paragraphIds.push(p);
  }

  // ④ 单段落 ⇒ 不是跨行范围（走现有单段路径，逐字节不变）
  if (paragraphIds.length <= 1) return { ok: false, reason: "single-paragraph" };

  return {
    ok: true,
    range: {
      blockId,
      segmentIds: picked.map((s) => s.id),
      lineIds,
      paragraphIds,
    },
  };
}

export interface CrossLineSetInput {
  /** **文档顺序**（DOM 顺序）的 segment 列表 */
  readonly segments: ReadonlyArray<CrossLineSegmentInput>;
  /**
   * 用户**显式多选**的 segment id 集合（D1'）。
   * 顺序无关 —— 内部会按 `segments` 的文档顺序取首尾。
   */
  readonly selectedSegmentIds: ReadonlyArray<string>;
  /** 同 `CrossLineRangeInput.resolveParagraph` */
  readonly resolveParagraph: (lineId: string) => string | null;
}

/**
 * D1' 入口：由「用户显式多选集合」判定跨行范围。
 *
 * 语义：取集合中所有 segment 在文档顺序里的 **min / max 索引**，
 * 再交给 `resolveCrossLineRange`（同一套 fail-closed 规则）。
 *
 * ⚠️ 刻意**不做**"只取集合内的离散段落"：拖选/多选的语义是**连续区间**，
 * 中间未显式点到的 segment 也属于该区间（与拖选等价）。
 */
export function resolveCrossLineRangeFromSet(input: CrossLineSetInput): CrossLineRangeResult {
  const ids = input.selectedSegmentIds ?? [];
  if (ids.length === 0) return { ok: false, reason: "empty-selection" };

  const segments = input.segments ?? [];
  if (segments.length === 0) return { ok: false, reason: "no-segments" };

  let lo = -1;
  let hi = -1;
  for (const s of segments) {
    const at = ids.indexOf(s.id);
    if (at < 0) continue;
    const idx = segments.indexOf(s);
    if (lo < 0 || idx < lo) lo = idx;
    if (hi < 0 || idx > hi) hi = idx;
  }
  if (lo < 0 || hi < 0) return { ok: false, reason: "selection-not-found" };

  return resolveCrossLineRange({
    segments,
    anchorSegmentId: segments[lo].id,
    focusSegmentId: segments[hi].id,
    resolveParagraph: input.resolveParagraph,
  });
}