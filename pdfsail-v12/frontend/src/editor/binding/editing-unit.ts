/**
 * editor/binding/editing-unit.ts — F3B-6.27 · P0-A · Semantic Editing Unit（**纯 contract**）
 *
 * ── 解决的问题 ────────────────────────────────────────────────────────
 * 用户眼里的一个「段落」通常横跨**多个 PDF visual line**，而当前架构每条 line 是
 * 独立 TextBox，Core command 又禁止跨 TextBox mutation：
 *
 *   PDF → Legacy visual lines → TextBox(每行一个) → Core paragraph → editing surface
 *
 * 方案 A（一个 Core paragraph 一个 editing surface）只解决了**单行**编辑；
 * 跨 visual line 的段落编辑需要在**视图/映射层**建立单位，而不是改 Core 的
 * TextBox 粒度。
 *
 * ── 硬边界（P0-A 冻结）──────────────────────────────────────────────
 *   · EditingUnit 是**视图/映射层**，**不得**把多条 line 合并成一个 Core TextBox；
 *     每个 line 仍对应**自己的** TextBox / paragraph / Legacy ownership。
 *   · 单元内 offset 是 **unit 坐标**（拼接后的全局 UTF-16），与 paragraph 坐标
 *     通过 `line.startUtf16/endUtf16` 互转 —— 不引入第三套坐标。
 *   · 段间分隔（换行/空格）**不归任何 line**，是显式的一等公民（`separators`）；
 *     落在 separator 上的 offset 是 **boundary**，不归属任何 line。
 *   · **不做几何**：几何需要 Core layout 输入，属 P0-B。
 *   · **不做语义段落识别**：不做自动 heuristic（实测真实 PDF 仅约 25% 行能形成
 *     预期 grouping 且存在大量 false merge）；`kind` 只有显式两种。
 *
 * ★ boundary 优先级（caret 安全优先，顺序不可调换）：
 *   ① line **内部** `[start, end)`   ⇒ 属该 line
 *   ② **单元末尾** `offset === lengthUtf16` ⇒ `kind:"end"`（确定映射，非猜测）
 *      —— 必须先于 ③：否则与「最后一行行末」重合而被判成 line，丢掉 end 语义
 *   ③ line **行末** `offset === end` ⇒ 仍属该 line（localOffset = text.length）
 *      —— 必须先于 separator：否则「\n 之前那个位置」会被判成 boundary，
 *         连带把行内替换误判为跨分隔（这是实现期实测到的真实坑）
 *   ④ separator 内部 `[start, end)`（单字符分隔时无整数命中 ⇒ 天然不可达）
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 * 纯函数：零 React / 零 DOM / 零 Core import（用结构化参数）/ 零坐标 / 零 indexOf。
 */

// ── 类型 ───────────────────────────────────────────────────────────────

/** 单元内一条 visual line（仍保有自己的 Core / Legacy ownership） */
export interface EditingUnitLine {
  readonly lineId: string;
  readonly textBoxId: string;
  readonly paragraphId: string;
  /** 该 line 对应 Core paragraph 的文本（单段，不含分隔符） */
  readonly text: string;
  /** 在 unit text 中的起始偏移（unit 坐标，UTF-16，闭） */
  readonly startUtf16: number;
  /** 在 unit text 中的结束偏移（unit 坐标，UTF-16，开） */
  readonly endUtf16: number;
  /**
   * ★ F3B-6.28：该 line 在**其 Core paragraph 内**的起始 UTF-16 偏移。
   *
   * 缺省 `0` = 该 line 覆盖整个 paragraph（既有全部用法）⇒ **行为逐字节不变**。
   *
   * 非 0 ⇒ 该 line 只是 paragraph 的一个**子区间**（= 表格「一个格子」）：
   *   · `text` = 子区间文本（cell 文本），不是 paragraph 全文；
   *   · unit 坐标 ↔ paragraph 坐标的换算必须加上本偏移，否则 cell 编辑会
   *     落到 paragraph 内的错误位置（真实表格行 = 1 paragraph × N cells）。
   */
  readonly paragraphStartUtf16?: number;
}

/** 段间分隔（不归任何 line；落在其上的 offset 是 boundary） */
export interface EditingUnitSeparator {
  /** 紧跟其后的 lineId（用于定位；构建时校验必须存在） */
  readonly afterLineId: string;
  readonly text: string;
  /** 在 unit text 中的起始偏移（闭） */
  readonly startUtf16: number;
  /** 在 unit text 中的结束偏移（开） */
  readonly endUtf16: number;
}

/**
 * 单元类型。**刻意不含 semantic paragraph** —— 自动识别尚未验证，
 * 不得以启发式上线（见头注「硬边界」）。
 */
export type EditingUnitKind = "visual-line" | "explicit-multi-line";

export interface EditingUnit {
  readonly unitId: string;
  readonly blockId: string;
  readonly kind: EditingUnitKind;
  readonly lines: readonly EditingUnitLine[];
  readonly separators: readonly EditingUnitSeparator[];
  /** 拼接后的单元全文（含分隔符） */
  readonly text: string;
  /** = text.length（UTF-16 单元数） */
  readonly lengthUtf16: number;
}
// ── 构建（fail-closed）─────────────────────────────────────────────────

export type EditingUnitBuildFailure =
  | "empty-lines"
  | "duplicate-line-id"
  | "duplicate-textbox-id"
  | "duplicate-paragraph-id"
  | "unknown-separator-anchor"
  | "invalid-kind"
  | "invalid-identity";

export interface EditingUnitLineInput {
  readonly lineId: string;
  readonly textBoxId: string;
  readonly paragraphId: string;
  readonly text: string;
  /**
   * ★ F3B-6.28：该 line 在其 Core paragraph 内的起始 UTF-16 偏移（缺省 0 =
   * 覆盖整个 paragraph ⇒ 既有行为逐字节不变）。非 0 ⇒ paragraph 子区间（表格 cell）。
   */
  readonly paragraphStartUtf16?: number;
}

/** 段间分隔的声明（构建时按出现顺序插到对应 line 之后） */
export interface EditingUnitSeparatorInput {
  /** 分隔符插在这个 line 之后 */
  readonly afterLineId: string;
  readonly text: string;
}

export interface BuildEditingUnitInput {
  readonly unitId: string;
  readonly blockId: string;
  readonly kind: EditingUnitKind;
  readonly lines: readonly EditingUnitLineInput[];
  readonly separators?: readonly EditingUnitSeparatorInput[];
}

export type BuildEditingUnitOutcome =
  | { readonly ok: true; readonly unit: EditingUnit }
  | { readonly ok: false; readonly reason: EditingUnitBuildFailure };

const KINDS: readonly string[] = ["visual-line", "explicit-multi-line"];

const has = (xs: ReadonlySet<string>, v: string): boolean => xs.has(v);

/**
 * 由「若干 line + 段间分隔」构建 EditingUnit。
 *
 * 不变量（任一不成立即 fail-closed，不做任何"猜测式"修补）：
 *   I1 至少一条 line
 *   I2 lineId / textBoxId / paragraphId 各自不重复
 *      （一个 TextBox 一个 paragraph —— 与 Core 现状「visual-line 粒度」一致；
 *        若将来允许一个 paragraph 拆成多 line，须显式放开本约束并单独立项）
 *   I3 分隔符的 anchor 必须是已声明的 lineId
 *   I4 offset 单调递增、不交叠，且恰好铺满 [0, text.length)
 */
export function buildEditingUnit(input: BuildEditingUnitInput): BuildEditingUnitOutcome {
  if (input.kind !== "visual-line" && !KINDS.includes(input.kind)) {
    return { ok: false, reason: "invalid-kind" };
  }
  if (!input.unitId || !input.blockId) return { ok: false, reason: "invalid-identity" };
  const src = input.lines ?? [];
  if (src.length === 0) return { ok: false, reason: "empty-lines" };

  const lineIds = new Set<string>();
  const boxIds = new Set<string>();
  const paraIds = new Set<string>();
  for (const l of src) {
    if (!l.lineId || !l.textBoxId || !l.paragraphId) return { ok: false, reason: "invalid-identity" };
    if (has(lineIds, l.lineId)) return { ok: false, reason: "duplicate-line-id" };
    if (has(boxIds, l.textBoxId)) return { ok: false, reason: "duplicate-textbox-id" };
    if (has(paraIds, l.paragraphId)) return { ok: false, reason: "duplicate-paragraph-id" };
    lineIds.add(l.lineId);
    boxIds.add(l.textBoxId);
    paraIds.add(l.paragraphId);
  }

  const sepByAnchor = new Map<string, string[]>();
  for (const s of input.separators ?? []) {
    if (!has(lineIds, s.afterLineId)) return { ok: false, reason: "unknown-separator-anchor" };
    const cur = sepByAnchor.get(s.afterLineId) ?? [];
    cur.push(s.text);
    sepByAnchor.set(s.afterLineId, cur);
  }

  const lines: EditingUnitLine[] = [];
  const separators: EditingUnitSeparator[] = [];
  let cursor = 0;
  for (const l of src) {
    lines.push({
      lineId: l.lineId,
      textBoxId: l.textBoxId,
      paragraphId: l.paragraphId,
      text: l.text,
      startUtf16: cursor,
      endUtf16: cursor + l.text.length,
      // ★ 缺省 0（覆盖整个 paragraph）⇒ 既有行为逐字节不变
      ...(typeof l.paragraphStartUtf16 === "number" && l.paragraphStartUtf16 > 0
        ? { paragraphStartUtf16: l.paragraphStartUtf16 }
        : {}),
    });
    cursor += l.text.length;
    for (const st of sepByAnchor.get(l.lineId) ?? []) {
      separators.push({
        afterLineId: l.lineId,
        text: st,
        startUtf16: cursor,
        endUtf16: cursor + st.length,
      });
      cursor += st.length;
    }
  }

  const text = lines
    .map((l) => ({ at: l.startUtf16, s: l.text }))
    .concat(separators.map((sp) => ({ at: sp.startUtf16, s: sp.text })))
    .sort((a, b) => a.at - b.at)
    .map((x) => x.s)
    .join("");

  return {
    ok: true,
    unit: {
      unitId: input.unitId,
      blockId: input.blockId,
      kind: input.kind,
      lines,
      separators,
      text,
      lengthUtf16: cursor,
    },
  };
}
// ── 身份辅助（P0-E1 / P0-E2-B 共用唯一实现）──────────────────────────

/**
 * 编辑后 lineId 丢失时的**合成** lineId。
 *
 * ★ 唯一实现 —— P0-E1 `rebindEditingUnit` 与 P0-E2-B `reflowed-unit-bridge`
 *   都必须调用本函数，**不得**各自拼接字符串（否则出现两套合成规则）。
 *
 * 背景（F3B-6.27 P0-D2 实测）：Core 编辑后，被整段删除的 paragraph
 * 残留 run 为 `{text:""}` 且**完全无 `source` 字段** ⇒ lineId 全丢。
 * 此时 `paragraphId` 是唯一稳定的结构身份，合成 id 必须由它**可复现派生**。
 */
export function syntheticLineIdOf(paragraphId: string): string {
  return `syn:${paragraphId}`;
}

// ── 双向映射（DOM offset ⇄ unit offset）────────────────────────────────

export type EditingUnitBoundary =
  | { readonly kind: "line"; readonly lineId: string; readonly localOffset: number }
  | { readonly kind: "separator"; readonly afterLineId: string; readonly localOffset: number }
  | { readonly kind: "end"; readonly lineId: string; readonly localOffset: number };

export type UnitOffsetFailure =
  | "negative-offset"
  | "out-of-unit-range"
  | "non-integer-offset"
  | "empty-unit";

export type UnitOffsetOutcome =
  | { readonly ok: true; readonly at: EditingUnitBoundary }
  | { readonly ok: false; readonly reason: UnitOffsetFailure };

const lineOf = (unit: EditingUnit, lineId: string): EditingUnitLine | null => {
  for (const l of unit.lines) if (l.lineId === lineId) return l;
  return null;
};

/**
 * 该 line 在其 Core paragraph 内的起始偏移（缺省 0 = 覆盖整个 paragraph）。
 * ★ 单一事实来源：所有「unit 坐标 ⇄ paragraph 坐标」换算都必须经此函数，
 *   否则表格 cell（paragraph 子区间）会落到 paragraph 内的错误位置。
 */
export const paragraphStartOf = (l: EditingUnitLine): number =>
  typeof l.paragraphStartUtf16 === "number" && l.paragraphStartUtf16 > 0 ? l.paragraphStartUtf16 : 0;

/**
 * unit offset → 归属定位。
 *
 * ★ boundary 规则（与既有 `core-editing-surface-geometry` 的 G4 对齐）：
 *   · 落在某 line 的 `[startUtf16, endUtf16]` 内 ⇒ 归属该 line
 *   · 落在 separator 上 ⇒ boundary，**不归属任何 line**
 *   · `offset === lengthUtf16`（末尾）⇒ 归属**最后一行**的末尾（确定映射，非猜测）
 *   · 区间用**半开** `[start, end)`：`end` 本身仍属该 line（即行末字符之后一位
 *     就是行末），避免"行末换算成下一行行首"的经典 off-by-one。
 */
export function unitOffsetToBoundary(unit: EditingUnit, unitOffset: number): UnitOffsetOutcome {
  if (!Number.isInteger(unitOffset)) return { ok: false, reason: "non-integer-offset" };
  if (unitOffset < 0) return { ok: false, reason: "negative-offset" };
  if (unit.lines.length === 0) return { ok: false, reason: "empty-unit" };
  if (unitOffset > unit.lengthUtf16) return { ok: false, reason: "out-of-unit-range" };

  // ★ 优先级（caret 安全优先，务必保持此顺序）：
  //   ① line **内部**：`[start, end)`  ⇒ 属该 line
  //   ② **单元末尾** `offset === lengthUtf16` ⇒ `kind: "end"`（确定映射，非猜测）
  //      —— 必须先于 ③：否则会与「最后一行行末」重合而被判成 line，丢掉 end 语义
  //   ③ line **行末**：`offset === end` ⇒ 仍属该 line（localOffset = text.length）
  //      —— 必须先于 separator，否则「\n 之前那个位置」会被判成 boundary，
  //         连带把行内替换误判为跨分隔（实现期实测到的真实坑）
  //   ④ separator 内部：`[start, end)`（单字符分隔时无整数命中 ⇒ 天然不可达）
  for (const l of unit.lines) {
    if (unitOffset >= l.startUtf16 && unitOffset < l.endUtf16) {
      return { ok: true, at: { kind: "line", lineId: l.lineId, localOffset: unitOffset - l.startUtf16 } };
    }
  }
  const last = unit.lines[unit.lines.length - 1];
  if (unitOffset === unit.lengthUtf16) {
    return { ok: true, at: { kind: "end", lineId: last.lineId, localOffset: last.text.length } };
  }
  for (const l of unit.lines) {
    if (unitOffset === l.endUtf16) {
      return { ok: true, at: { kind: "line", lineId: l.lineId, localOffset: l.text.length } };
    }
  }
  for (const sp of unit.separators) {
    if (unitOffset >= sp.startUtf16 && unitOffset < sp.endUtf16) {
      return {
        ok: true,
        at: { kind: "separator", afterLineId: sp.afterLineId, localOffset: unitOffset - sp.startUtf16 },
      };
    }
  }
  // 理论上不可达（不变量 I4 保证铺满）；仍显式 fail-closed
  return { ok: false, reason: "out-of-unit-range" };
}

/** 该 line 在 unit 坐标中的区间（未知 lineId ⇒ null） */
export function unitRangeOfLine(unit: EditingUnit, lineId: string): { startUtf16: number; endUtf16: number } | null {
  const l = lineOf(unit, lineId);
  return l ? { startUtf16: l.startUtf16, endUtf16: l.endUtf16 } : null;
}

/** unit offset → paragraph 内偏移（只对 line 归属有效；boundary ⇒ null） */
export function unitOffsetToParagraphOffset(
  unit: EditingUnit,
  unitOffset: number
): { ok: true; paragraphId: string; localOffset: number } | { ok: false; reason: UnitOffsetFailure | "boundary-not-in-paragraph" } {
  const r = unitOffsetToBoundary(unit, unitOffset);
  if (!r.ok) return r;
  if (r.at.kind === "separator") return { ok: false, reason: "boundary-not-in-paragraph" };
  const l = lineOf(unit, r.at.lineId);
  if (!l) return { ok: false, reason: "boundary-not-in-paragraph" };
  // ★ paragraph 内偏移 = line 内偏移 + 该 line 在 paragraph 内的起点（cell 场景）
  return { ok: true, paragraphId: l.paragraphId, localOffset: r.at.localOffset + paragraphStartOf(l) };
}

/** paragraph 内偏移 → unit 坐标（lineId + localOffset） */
export function paragraphOffsetToUnitOffset(
  unit: EditingUnit,
  lineId: string,
  localOffset: number
): { ok: true; unitOffset: number } | { ok: false; reason: UnitOffsetFailure | "unknown-line" | "local-offset-out-of-range" } {
  const l = lineOf(unit, lineId);
  if (!l) return { ok: false, reason: "unknown-line" };
  const pStart = paragraphStartOf(l);
  if (!Number.isInteger(localOffset) || localOffset < pStart || localOffset > pStart + l.text.length) {
    return { ok: false, reason: "local-offset-out-of-range" };
  }
  return { ok: true, unitOffset: l.startUtf16 + (localOffset - pStart) };
}
// ── 只读 mutation 计划（P0-D 的前置；本模块**不执行**任何 command）─────

/** 单元内一次编辑落到某条 line 上的局部操作 */
export interface UnitLineOp {
  readonly lineId: string;
  readonly textBoxId: string;
  readonly paragraphId: string;
  /** paragraph 内偏移 */
  readonly localStart: number;
  readonly localEnd: number;
  readonly text: string;
}

export type UnitPlanFailure =
  | "non-integer-offset"
  | "negative-offset"
  | "reversed-range"
  | "out-of-unit-range"
  | "crosses-separator";

export type UnitMutationPlan =
  | {
      readonly ok: true;
      readonly ops: readonly UnitLineOp[];
      /** 编辑是否只落在单条 line 内（true ⇒ 无需跨 paragraph 协调） */
      readonly singleLine: boolean;
    }
  | { readonly ok: false; readonly reason: UnitPlanFailure };

/**
 * 把「单元内一次 replacement」**分解**为若干 per-line 局部操作。
 *
 * ★ 只做计划，**不执行**、不构造任何 Core Command、不触碰 document/history。
 *   执行与事务编排属 P0-D（届时需决定 multi-Core transaction 还是 merge/split）。
 *
 * ★ fail-closed 之一：`crosses-separator` —— 编辑区间跨越段间分隔时**拒绝**。
 *   原因：跨分隔的删除/替换语义需要决定「是否连带吞掉换行」，那是 Core 结构层
 *   的决定（split/merge），不属于「行内 replacement」⇒ 不猜。
 */
export function planUnitMutation(
  unit: EditingUnit,
  unitStart: number,
  unitEnd: number,
  replacementText: string
): UnitMutationPlan {
  if (!Number.isInteger(unitStart) || !Number.isInteger(unitEnd)) {
    return { ok: false, reason: "non-integer-offset" };
  }
  if (unitStart < 0 || unitEnd < 0) return { ok: false, reason: "negative-offset" };
  if (unitStart > unitEnd) return { ok: false, reason: "reversed-range" };
  if (unitEnd > unit.lengthUtf16) return { ok: false, reason: "out-of-unit-range" };

  // 空区间（纯插入）落在哪个 line / separator？
  const start = unitOffsetToBoundary(unit, unitStart);
  if (!start.ok) return { ok: false, reason: "out-of-unit-range" };

  if (unitStart === unitEnd) {
    if (start.at.kind === "separator") return { ok: false, reason: "crosses-separator" };
    const l = lineOf(unit, start.at.lineId);
    if (!l) return { ok: false, reason: "crosses-separator" };
    // ★ paragraph 内偏移（含 cell 子区间起点）
    const local = start.at.localOffset + paragraphStartOf(l);
    return {
      ok: true,
      singleLine: true,
      ops: [
        {
          lineId: l.lineId,
          textBoxId: l.textBoxId,
          paragraphId: l.paragraphId,
          localStart: local,
          localEnd: local,
          text: replacementText,
        },
      ],
    };
  }

  // 非空区间：必须完全落在**同一条 line** 内（不跨行、不跨分隔）
  const end = unitOffsetToBoundary(unit, unitEnd);
  if (!end.ok) return { ok: false, reason: "out-of-unit-range" };
  if (start.at.kind === "separator" || end.at.kind === "separator") {
    return { ok: false, reason: "crosses-separator" };
  }
  if (start.at.lineId !== end.at.lineId) return { ok: false, reason: "crosses-separator" };

  const l = lineOf(unit, start.at.lineId);
  if (!l) return { ok: false, reason: "crosses-separator" };
  const pStart = paragraphStartOf(l);
  return {
    ok: true,
    singleLine: true,
    ops: [
      {
        lineId: l.lineId,
        textBoxId: l.textBoxId,
        paragraphId: l.paragraphId,
        localStart: start.at.localOffset + pStart,
        localEnd: end.at.localOffset + pStart,
        text: replacementText,
      },
    ],
  };
}

/** 取出每条 line 对应的 Core 身份（P0-D 分解为多个 Core range 时用；这里只读） */
export function coreIdentitiesOfUnit(
  unit: EditingUnit
): readonly { lineId: string; textBoxId: string; paragraphId: string; startUtf16: number; endUtf16: number }[] {
  return unit.lines.map((l) => ({
    lineId: l.lineId,
    textBoxId: l.textBoxId,
    paragraphId: l.paragraphId,
    startUtf16: l.startUtf16,
    endUtf16: l.endUtf16,
  }));
}