/**
 * editing-unit-mutation-plan.ts — F3B-6.27 · **P0-D1 · EditingUnitMutationPlan（只读计划）**
 *
 * ── 用户裁决（本阶段的全部授权边界）────────────────────────────────
 *   方案 = **(a) multi-Core transaction**；**明确不采用 merge/split Core paragraph**。
 *   ⇒ Core paragraph 不合并、TextBox 不合并、visual-line 粒度不变。
 *   本阶段只做 **D1（计划）**：不执行 Core command、不改 History、不接 React。
 *
 * ── 与 P0-A 既有 `planUnitMutation` 的关系（不制造第二套真值）────────
 *   P0-A 的 `planUnitMutation` 是**单行 strict 入口**（跨行 fail-closed），属冻结契约。
 *   本模块提供**跨行**能力，唯一真值是 `planUnitMutationMulti()`。
 *   两者的一致性由**测试逐例证明**（单行输入下二者结果必须逐字段相同），
 *   而不是靠互相 import —— 避免循环依赖，也避免"改一处忘另一处"。
 *   `planUnitMutationStrict` 是从 multi 计划**重新推导**的 strict 视图，仅用于该等价性证明。
 *
 * ── 三条必须显式声明的语义（不猜）──────────────────────────────────
 *
 *   ★ S1 replacement 归属：**全部替换文本只落在「选区起点所在的那条 line」**，
 *       其余 line 的 op 是纯删除（`replacement: ""`）。
 *       理由：替换文本是一次连续插入，必须有唯一确定落点；落在起点行是编辑器通用行为。
 *
 *   ★ S2 separator 不是 Core text，**永不产生"删除 separator"的 Core command**：
 *       · `preserve` —— 选区未完全覆盖（默认，不触碰 Core 结构）
 *       · `consume`  —— 选区**完全覆盖** ⇒ 转换为两侧 line 的文本操作
 *       · **部分覆盖 ⇒ fail-closed**（`partial-separator-consumption`）：
 *         "是否连带吞掉剩余换行"属 Core 结构决定（被否决的 merge/split 域）⇒ 不猜。
 *       · **纯 separator 选择 ⇒ fail-closed**（`separator-only-mutation`）：
 *         它要求"不删任何字符就把两个 paragraph 连起来"，visual-line 粒度下无法表达。
 *
 *   ★ S3 ★★ 诚实的核心限制：`consume` 之后 **Core 实际渲染仍是两个 visual line**。
 *       Core 里 L5/L6 是两个独立 TextBox/paragraph，没有任何 Core 语义能让它们渲染成
 *       一行（那正是被否决的 merge/split）。因此计划层**显式暴露**该 mismatch：
 *         `separatorConsumed: true` + `coreProjectionMismatch{expected, coreProjection, residual}`
 *       未 consume 时恒有 `projectOntoCore(unit, plan) === plan.afterText`（字节级自洽）。
 *
 * ── 硬边界 ──────────────────────────────────────────────────────────
 *   · 0 Core import / 0 React / 0 DOM / 0 坐标 / 0 indexOf（不 text search）
 *   · 0 Command 构造 / 0 History 触碰（grouping 仅为**声明式 contract**）
 */

import { paragraphStartOf, unitOffsetToBoundary, type EditingUnit } from "./editing-unit";

// ── 计划类型 ─────────────────────────────────────────────────────────

export type UnitOperationRole = "insert" | "replace" | "delete";

/** 一条 per-line 局部操作（尚未执行；自带 Core 身份，绝不 text search） */
export interface UnitOperation {
  /** 文档顺序（= unit 坐标升序），deterministic（D6） */
  readonly order: number;
  readonly lineId: string;
  readonly textBoxId: string;
  readonly paragraphId: string;
  /** 段落内偏移（UTF-16，Core 坐标 [start, end)） */
  readonly coreStartUtf16: number;
  readonly coreEndUtf16: number;
  /** 被删除字符数（= coreEnd - coreStart） */
  readonly deletionUtf16: number;
  /** 替换文本；**只有 S1 指定的 host line 非空** */
  readonly replacement: string;
  /** 该 op 在 unit 坐标中的覆盖范围（便于回验） */
  readonly unitStartUtf16: number;
  readonly unitEndUtf16: number;
  readonly role: UnitOperationRole;
}

export type SeparatorDisposition = "preserve" | "consume";

export interface SeparatorDecision {
  readonly afterLineId: string;
  readonly unitStartUtf16: number;
  readonly unitEndUtf16: number;
  readonly disposition: SeparatorDisposition;
  /** 为何不产生 Core command（始终有值，便于审计） */
  readonly note: string;
}

/**
 * D8 · History grouping **声明式 contract**（本阶段**不改**实际 History）。
 * 一条 EditingUnit mutation = 1 个 undo unit = 1 个 redo unit。
 */
export interface EditingUnitTransactionContract {
  readonly transactionKey: string;
  readonly historyBoundary: "one-undo-unit";
  /** 将被包装成多少个 Core command（可 >1，但只有一个 history 边界） */
  readonly commandCount: number;
  readonly grouping: "one-transaction-per-unit-mutation";
}

/** consume 情形下 Core 投影与编辑意图的差异（**如实暴露，不隐藏**） */
export interface CoreProjectionMismatch {
  readonly expectedAfterText: string;
  /** 逐 op 应用到各 Core 段落文本后的真实拼接（仍含保留的 separator） */
  readonly coreProjectionText: string;
  /** 差异恰好等于被 consume 的 separator 文本之和（可解释、可验证） */
  readonly residualSeparatorText: string;
}

export interface EditingUnitMutationPlan {
  readonly unitId: string;
  readonly blockId: string;
  readonly kind: EditingUnit["kind"];
  readonly planKind: "single-paragraph" | "cross-paragraph";
  readonly beforeText: string;
  /** **编辑意图**（= 选区被替换后的单元文本）；consume 时 ≠ Core 渲染结果，见 S3 */
  readonly afterText: string;
  readonly operations: readonly UnitOperation[];
  readonly separators: readonly SeparatorDecision[];
  readonly separatorConsumed: boolean;
  /** 仅当 `separatorConsumed === true` 时存在 */
  readonly coreProjectionMismatch: CoreProjectionMismatch | null;
  readonly affectedParagraphs: readonly string[];
  readonly affectedLines: readonly string[];
  readonly affectedTextBoxes: readonly string[];
  readonly transaction: EditingUnitTransactionContract;
}

export type UnitMultiPlanFailure =
  | "non-integer-offset"
  | "negative-offset"
  | "reversed-range"
  | "out-of-unit-range"
  | "empty-unit"
  | "crosses-separator"
  | "partial-separator-consumption"
  | "separator-only-mutation";

export type UnitMultiPlanOutcome =
  | { readonly ok: true; readonly plan: EditingUnitMutationPlan }
  | { readonly ok: false; readonly reason: UnitMultiPlanFailure };

const CONSUME_NOTE = "separator 不是 Core text：已转为相邻 line 的文本操作，未产生删除换行的 command";
const PRESERVE_NOTE = "选区未完全覆盖该 separator：保留（不触碰 Core 结构）";

/**
 * P0-D1 主体：把「单元内一次 replacement」分解为 deterministic 的 per-line Core 操作计划。
 * ★ 只做计划：不构造 Core Command、不访问 EditorDocument、不触碰 History。
 */
export function planUnitMutationMulti(
  unit: EditingUnit,
  unitStart: number,
  unitEnd: number,
  replacementText: string
): UnitMultiPlanOutcome {
  if (!Number.isInteger(unitStart) || !Number.isInteger(unitEnd)) {
    return { ok: false, reason: "non-integer-offset" };
  }
  if (unitStart < 0 || unitEnd < 0) return { ok: false, reason: "negative-offset" };
  if (unitStart > unitEnd) return { ok: false, reason: "reversed-range" };
  if (unitEnd > unit.lengthUtf16) return { ok: false, reason: "out-of-unit-range" };
  if (unit.lines.length === 0) return { ok: false, reason: "empty-unit" };
  if (typeof replacementText !== "string") return { ok: false, reason: "empty-unit" };

  // ── 步骤 1：算选区与 line 字符 / separator 的相交情况 ──
  //    ⚠️ 顺序要求：必须**先**判「纯 separator 选区」，再判「部分覆盖」。
  //    否则纯 separator 选区会被误报成 partial（实测踩过：decideSeparators 抢先返回 partial）。
  const touched = unit.lines
    .filter((l) => unitStart < l.endUtf16 && l.startUtf16 < unitEnd)
    .sort((a, b) => a.startUtf16 - b.startUtf16);
  const overlappedSeparators = unit.separators.filter(
    (sp) => Math.max(unitStart, sp.startUtf16) < Math.min(unitEnd, sp.endUtf16)
  );
  if (unitStart !== unitEnd && touched.length === 0 && overlappedSeparators.length > 0) {
    // 不删任何字符就想把两个 paragraph 连起来 —— visual-line 粒度下无法表达（D5 / S2）
    return { ok: false, reason: "separator-only-mutation" };
  }

  // ── 步骤 2：separator 处置（部分覆盖在此 fail-closed）──
  const sepDecision = decideSeparators(unit, unitStart, unitEnd);
  if (!sepDecision.ok) return sepDecision;

  // ── 插入（零宽选区）：归属由 EditingUnit boundary 唯一决定，绝无 ambiguous（D3）──
  if (unitStart === unitEnd) {
    const at = unitOffsetToBoundary(unit, unitStart);
    if (!at.ok) return { ok: false, reason: "out-of-unit-range" };
    // ⚠️ 必须提取局部 const：TypeScript **不会**跨函数边界保留 `at.at` 这种属性链的
    //   判别式窄化（会在下方 `.find()` 回调里丢失 ⇒ TS2339）。
    const boundary = at.at;
    if (boundary.kind === "separator") return { ok: false, reason: "crosses-separator" };
    const line = unit.lines.find((l) => l.lineId === boundary.lineId);
    if (!line) return { ok: false, reason: "out-of-unit-range" };
    // ★ Core 坐标 = paragraph 内偏移（含 cell 子区间起点；缺省 0 ⇒ 逐字节不变）
    const coreAt = boundary.localOffset + paragraphStartOf(line);
    return finish(
      unit,
      [
        {
          order: 0,
          lineId: line.lineId,
          textBoxId: line.textBoxId,
          paragraphId: line.paragraphId,
          coreStartUtf16: coreAt,
          coreEndUtf16: coreAt,
          deletionUtf16: 0,
          replacement: replacementText,
          unitStartUtf16: unitStart,
          unitEndUtf16: unitEnd,
          role: replacementText.length === 0 ? "delete" : "insert",
        },
      ],
      sepDecision.decisions,
      unitStart,
      unitEnd,
      replacementText
    );
  }

  // ── 非空选区：相交的 line（unit 坐标升序 = 文档顺序，D6）──
  //    （`touched` 已在上方算好）
  // 纯 separator 选择已在上面 fail-closed；此处必至少有一条 line
  if (touched.length === 0) return { ok: false, reason: "separator-only-mutation" };

  // ★ S1：replacement 只落在「选区起点所在的那条 line」
  const host = touched[0]!;

  const operations: UnitOperation[] = touched.map((l, i) => {
    const from = Math.max(unitStart, l.startUtf16);
    const to = Math.min(unitEnd, l.endUtf16);
    // ★ Core 坐标 = paragraph 内偏移（unit 坐标 − line 起点 + paragraph 子区间起点）
    const pStart = paragraphStartOf(l);
    const coreStart = from - l.startUtf16 + pStart;
    const coreEnd = to - l.startUtf16 + pStart;
    const replacement = l.lineId === host.lineId ? replacementText : "";
    const role: UnitOperationRole =
      coreStart === coreEnd
        ? replacement.length > 0
          ? "insert"
          : "delete"
        : replacement.length > 0
          ? "replace"
          : "delete";
    return {
      order: i,
      lineId: l.lineId,
      textBoxId: l.textBoxId,
      paragraphId: l.paragraphId,
      coreStartUtf16: coreStart,
      coreEndUtf16: coreEnd,
      deletionUtf16: coreEnd - coreStart,
      replacement,
      unitStartUtf16: from,
      unitEndUtf16: to,
      role,
    };
  });

  return finish(unit, operations, sepDecision.decisions, unitStart, unitEnd, replacementText);
}

/** separator 处置决策（S2）；部分覆盖 / 纯 separator 选择一律 fail-closed */
function decideSeparators(
  unit: EditingUnit,
  unitStart: number,
  unitEnd: number
): { ok: true; decisions: SeparatorDecision[] } | { ok: false; reason: UnitMultiPlanFailure } {
  const decisions: SeparatorDecision[] = [];
  for (const sp of unit.separators) {
    const overlapStart = Math.max(unitStart, sp.startUtf16);
    const overlapEnd = Math.min(unitEnd, sp.endUtf16);
    if (overlapStart >= overlapEnd) {
      decisions.push({
        afterLineId: sp.afterLineId,
        unitStartUtf16: sp.startUtf16,
        unitEndUtf16: sp.endUtf16,
        disposition: "preserve",
        note: PRESERVE_NOTE,
      });
      continue;
    }
    const fullyCovered = overlapStart === sp.startUtf16 && overlapEnd === sp.endUtf16;
    if (!fullyCovered) return { ok: false, reason: "partial-separator-consumption" };
    decisions.push({
      afterLineId: sp.afterLineId,
      unitStartUtf16: sp.startUtf16,
      unitEndUtf16: sp.endUtf16,
      disposition: "consume",
      note: CONSUME_NOTE,
    });
  }
  return { ok: true, decisions };
}

/** 组装 + 自洽校验（唯一调用点，避免两份组装逻辑） */
function finish(
  unit: EditingUnit,
  operations: UnitOperation[],
  separators: SeparatorDecision[],
  unitStart: number,
  unitEnd: number,
  replacementText: string
): UnitMultiPlanOutcome {
  const beforeText = unit.text;
  const afterText = beforeText.slice(0, unitStart) + replacementText + beforeText.slice(unitEnd);
  const separatorConsumed = separators.some((s) => s.disposition === "consume");

  const coreProjectionText = projectOntoCore(unit, operations);
  const residualSeparatorText = separatorConsumed
    ? unit.separators
        .filter((sp) => separators.some((d) => d.afterLineId === sp.afterLineId && d.disposition === "consume"))
        .map((sp) => sp.text)
        .join("")
    : "";
  const mismatch: CoreProjectionMismatch | null = separatorConsumed
    ? { expectedAfterText: afterText, coreProjectionText, residualSeparatorText }
    : null;

  // ★ 不变量：未 consume 时，Core 投影必须**字节级**等于编辑意图
  if (!separatorConsumed && coreProjectionText !== afterText) {
    return { ok: false, reason: "out-of-unit-range" };
  }

  return {
    ok: true,
    plan: {
      unitId: unit.unitId,
      blockId: unit.blockId,
      kind: unit.kind,
      planKind: unique(operations.map((o) => o.paragraphId)).length > 1 ? "cross-paragraph" : "single-paragraph",
      beforeText,
      afterText,
      operations,
      separators,
      separatorConsumed,
      coreProjectionMismatch: mismatch,
      affectedParagraphs: operations.map((o) => o.paragraphId),
      affectedLines: operations.map((o) => o.lineId),
      affectedTextBoxes: unique(operations.map((o) => o.textBoxId)),
      transaction: {
        transactionKey: `${unit.unitId}#${unitStart}:${unitEnd}:${replacementText.length}`,
        historyBoundary: "one-undo-unit",
        commandCount: operations.length,
        grouping: "one-transaction-per-unit-mutation",
      },
    },
  };
}

/**
 * 把计划逐 op 应用到各 Core 段落文本，再按 unit 顺序（含保留的 separator）重组。
 *
 * ★ 这**不是** Core 执行器（不构造 Command、不碰 EditorDocument），而是
 *   "若这些 op 被逐条执行，Core 侧文本会变成什么"的可验证投影。
 *   P0-D2 真正执行时必须复现同一结果，否则就是 bug。
 */
export function projectOntoCore(unit: EditingUnit, operations: readonly UnitOperation[]): string {
  const byLine = new Map<string, UnitOperation>();
  for (const op of operations) byLine.set(op.lineId, op);
  let out = "";
  for (const l of unit.lines) {
    const op = byLine.get(l.lineId);
    // ★ op 的坐标是 **paragraph 内**；l.text 是该 line（可能是 paragraph 子区间）
    //   的文本 ⇒ 切片前必须减去该 line 在 paragraph 内的起点。
    const pStart = paragraphStartOf(l);
    out += op
      ? l.text.slice(0, op.coreStartUtf16 - pStart) + op.replacement + l.text.slice(op.coreEndUtf16 - pStart)
      : l.text;
    // separator 挂在它**前一行**的 afterLineId 上；separator 恒保留（它不是 Core text）
    const sepAfter = unit.separators.find((s) => s.afterLineId === l.lineId);
    if (sepAfter) out += sepAfter.text;
  }
  return out;
}

function unique(xs: readonly string[]): string[] {
  const out: string[] = [];
  for (const x of xs) if (!out.includes(x)) out.push(x);
  return out;
}

/**
 * strict 单行视图（**从 multi 计划重新推导**，不与 P0-A 的 `planUnitMutation` 互相依赖）。
 *
 * 存在意义只有一个：让测试能逐例证明
 *   `editing-unit.planUnitMutation`（P0-A 冻结入口） ≡ 本函数（P0-D1 推导）
 * 在单行输入下逐字段相同 ⇒ 两套入口永不发散。
 * 跨行输入下两者都 fail-closed（P0-A 的既有行为因此保持不变）。
 */
export function planUnitMutationStrict(
  unit: EditingUnit,
  unitStart: number,
  unitEnd: number,
  replacementText: string
): {
  ok: boolean;
  reason?: string;
  singleLine?: boolean;
  ops?: readonly {
    lineId: string;
    textBoxId: string;
    paragraphId: string;
    localStart: number;
    localEnd: number;
    text: string;
  }[];
} {
  const r = planUnitMutationMulti(unit, unitStart, unitEnd, replacementText);
  if (!r.ok) return { ok: false, reason: "crosses-separator" };
  if (r.plan.separatorConsumed) return { ok: false, reason: "crosses-separator" };
  if (r.plan.operations.length !== 1) return { ok: false, reason: "crosses-separator" };
  const op = r.plan.operations[0]!;
  return {
    ok: true,
    singleLine: true,
    ops: [
      {
        lineId: op.lineId,
        textBoxId: op.textBoxId,
        paragraphId: op.paragraphId,
        localStart: op.coreStartUtf16,
        localEnd: op.coreEndUtf16,
        text: op.replacement,
      },
    ],
  };
}
