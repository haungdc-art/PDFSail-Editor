/**
 * logical-line-partition.ts — Reflow Step 4B-4A · **Logical Line Partition Adapter**（纯函数）
 *
 * ── 目的（用户裁决：先证明，不改CSS）────────────────────────────────
 *   回答：**在 ONE contenteditable 中如何表达 Core 的 visual-line partition，
 *   同时不破坏 UTF-16 selection/caret。**
 *
 *   输入：EditingUnit（logical structure）+ ReflowedVisualLine[]（Core layout fact）
 *   输出：**unit 全局坐标下的 flow line 列表** + 显式换行需求标记
 *
 * ── 方案 B（已正式冻结）─────────────────────────────────────────────
 *   Core权威：text partition · visual line count · contentWidth · line height
 *   DOM 权威：UTF-16 text · caret/selection · **vertical flow**
 *   ⇒ **Core 的 absolute Y / baseline 不进入单一contenteditable 的 flow 定位。**
 *   （依据：4B-2.6 已证明 PDF TextBox 独立绝对定位与 DOM 流式物理不相容。）
 *
 * ── 五条硬性不变量 ─────────────────────────────────────────────────
 *   1**EditingUnit 不变**：`unit.lines.length` 绝不因 reflow 变成 visual 行数。
 *   2 **UTF-16 直接来自 Core**：`textStart/textEnd` 原样换算到 unit 全局坐标。
 *   3 **soft-wrap 不产生 separator**：`line[i].end === line[i+1].start` 绝不生成 "\n"。
 *   4 **paragraph separator 仍属于 EditingUnit**：从 `unit.separators` 读，不来自 Core。
 *   5 **不使用 Core absolute Y**：输出**不含** box.y / baseline / absoluteTop / absoluteBottom。
 *
 * ── 坐标系（本模块的核心）────────────────────────────────────────────
 *   输入（**4B-1 `SurfaceVisualLine`**）的 `startInParagraphUtf16`/`endInParagraphUtf16`
 *     = **paragraph 内**偏移
 *   `EditingUnit` offset          = **unit 全局**偏移（含所有 paragraph + separator）
 *   换算：unitGlobal = unit.lines[i].startUtf16 + paragraphLocal
 *   ★ 输出**统一为 unit 全局**：`startInParagraphUtf16` **不会**泄漏到下游。
 *
 * 硬边界：0 DOM / 0 React / 0 Command / 0 History / 0 PDFEditor / 0 CSS。
 *   类型引用全部 type-only；不 import任何运行期函数。
 */

import type { EditingUnit } from "./editing-unit";
import type { ParagraphVisualGroup } from "./editing-surface-visual-geometry";

// ══════════════════════════════════════════════════════════════════════
// 输出类型
// ══════════════════════════════════════════════════════════════════════

/**
 * 一条 **flow line**（unit 全局坐标）。
 *
 * ★ `kind` 的语义（对应不变量 3 与 4）：
 *   · `"visual"`    = Core soft-wrap 出来的行。**不产生任何字符**，
 *                     unit.text 里没有对应字符 ⇒ DOM 需要**显式换行元素**。
 *   · `"separator"` = EditingUnit 的显式 separator（`\n` 本体）。
 *                     unit.text **里就有这个字符** ⇒ `white-space: pre-wrap`
 *                     下**天然换行**，**不需要**额外换行元素。
 */
export interface LogicalFlowLine {
  readonly kind: "visual" | "separator";
  /** 所属 paragraph（separator 恒为 null） */
  readonly paragraphId: string | null;
  /** **unit 全局** UTF-16 区间 [startUtf16, endUtf16) */
  readonly startUtf16: number;
  readonly endUtf16: number;
  /** Core 的 contentWidth（separator 无 ⇒ null） */
  readonly contentWidth: number | null;
  /** 行高：Core 行盒height（**不是** absolute Y） */
  readonly lineHeight: number;
  /** 相对段落左边界的缩进（Core textIndent；separator 无 ⇒ null） */
  readonly textIndent: number | null;
  /**
   * ★ DOM 是否需要在此行**之前**插入显式换行元素（如 `<br>`）。
   *   visual 行（非首行）⇒ true；separator ⇒ false（`\n` 自带换行）；
   *   首行 ⇒ false。
   */
  readonly needsExplicitBreak: boolean;
}

/** flow line 之间的 UTF-16 间隙（**如实报告，不发明**） */
export interface PartitionGap {
  readonly afterFlowLineIndex: number;
  readonly gapUtf16: number;
}

export interface LogicalLinePartition {
  /** 全部 flow line（严格按 unit 全局坐标升序） */
  readonly flowLines: readonly LogicalFlowLine[];
  /** Σ lineHeight（DOM flow 的自然高度；**不用** Core absolute Y） */
  readonly totalFlowHeight: number;
  /** visual 行数（不含 separator） */
  readonly visualLineCount: number;
  /** separator 行数 */
  readonly separatorLineCount: number;
  /** flow lines 是否**无缝覆盖** `unit.text`（不变量 2 的强形式） */
  readonly contiguousCoverage: boolean;
  /** 覆盖范围 [0, coveredToUtf16) */
  readonly coveredToUtf16: number;
  readonly unitTextLength: number;
  /** 覆盖缺口（不连续时如实报告；soft-wrap 的 layout fact，不得当separator） */
  readonly gaps: readonly PartitionGap[];
  // ── logical 只读镜像（绝不回写）──
  readonly logicalLineCount: number;
  readonly unitId: string;
}

export type PartitionFailure =
  | "empty-unit"
  | "no-visual-lines"
  | "paragraph-not-in-unit"
  | "paragraph-set-mismatch"
  | "degenerate-line-height";

export type PartitionOutcome =
  | { readonly ok: true; readonly partition: LogicalLinePartition }
  | { readonly ok: false; readonly reason: PartitionFailure; readonly detail: string };

export interface BuildLogicalPartitionInput {
  readonly unit: EditingUnit;
  /**
   * ★ **4B-1 的输出** `ParagraphVisualGroup[]`（**不是** 4A 的 `CoreVisualLinesOfParagraph[]`）。
   *
   * ★★ 修正记录（生产缺陷，Gate A 实测逃过单测）：此前本接口声明为 4A 的
   *    `CoreVisualLinesOfParagraph[]`（字段 `startUtf16`/`endUtf16`），
   *    而生产实际传入 4B-1 的 `ParagraphVisualGroup[]`
   *    （字段 `startInParagraphUtf16`/`endInParagraphUtf16`）。
   *    TS 因结构兼容**未报错** ⇒ 运行时读到 `undefined` ⇒ `NaN`
   *    ⇒ `needsExplicitBreak` 恒 false ⇒ breaks恒为 0。
   *    ⭐ 逃过单测的原因：契约测试用**手写合成数据**（字段名恰好是 4A 的）
   *      ⇒ 现改为「真实经 4B-1 产出」的输入（见 .test.ts）。
   */
  readonly paragraphs: readonly ParagraphVisualGroup[];
}

const fail = (reason: PartitionFailure, detail: string): PartitionOutcome => ({
  ok: false,
  reason,
  detail,
});
const r2 = (n: number): number => Math.round(n * 100) / 100;

// ══════════════════════════════════════════════════════════════════════
// 主体
// ══════════════════════════════════════════════════════════════════════

/**
 * `EditingUnit` × `CoreVisualLinesOfParagraph[]` → `LogicalLinePartition`。
 *
 * ★ 本函数**不**产生任何 DOM / CSS；只输出逻辑流模型，供 4B-4B 决定
 *   「在哪个 offset 插入显式换行元素」。
 */
export function buildLogicalLinePartition(
  input: BuildLogicalPartitionInput,
): PartitionOutcome {
  const unit = input.unit;
  if (!unit || unit.lines.length === 0) return fail("empty-unit", "EditingUnit 无line");
  const groups = input.paragraphs ?? [];
  if (groups.length === 0) return fail("no-visual-lines", "无 paragraph 视觉行分组");

  const unitParagraphIds = unit.lines.map((l) => l.paragraphId);
  for (const g of groups) {
    if (!unitParagraphIds.includes(g.paragraphId)) {
      return fail("paragraph-not-in-unit", `Core 分组引用了不在 unit 内的 paragraph=${g.paragraphId}`);
    }
  }
  for (const pid of unitParagraphIds) {
    if (!groups.some((g) => g.paragraphId === pid)) {
      return fail("paragraph-set-mismatch", `unit 的 paragraph=${pid} 没有任何 Core 视觉行`);
    }
  }

  // ── 按 EditingUnit 的 paragraph 顺序遍历，把 separator 插在正确位置 ──
  const flowLines: LogicalFlowLine[] = [];
  let cursor = 0;
  let contiguous = true;
  const gaps: PartitionGap[] = [];

  for (let i = 0; i < unit.lines.length; i++) {
    const unitLine = unit.lines[i]!;
    const group = groups.find((g) => g.paragraphId === unitLine.paragraphId)!;

    // ① 本 paragraph 的 Core 视觉行：paragraph 内偏移 → unit 全局
    const ordered = [...group.lines].sort((a, b) => a.lineIndex - b.lineIndex);
    for (let k = 0; k < ordered.length; k++) {
      const vl = ordered[k]!;
      const lineHeight = vl.box.height;
      if (!(Number.isFinite(lineHeight) && lineHeight > 0)) {
        return fail("degenerate-line-height", `${vl.visualLineKey} 行高非法 height=${lineHeight}`);
      }
      // ★ 输入是 **4B-1 的 `SurfaceVisualLine`** ⇒ 字段是
      //   `startInParagraphUtf16` / `endInParagraphUtf16`（**paragraph 内**偏移）。
      //   ⚠️ 此前误按 4A 的 `startUtf16`/`endUtf16` 读取 ⇒ `undefined` ⇒ `NaN`
      //      ⇒ `needsExplicitBreak` 恒 false ⇒ breaks恒为 0（Gate A 实测）。
      const startUtf16 = unitLine.startUtf16 + vl.startInParagraphUtf16;
      const endUtf16 = unitLine.startUtf16 + vl.endInParagraphUtf16;
      if (startUtf16 !== cursor) {
        contiguous = false;
        gaps.push({ afterFlowLineIndex: flowLines.length, gapUtf16: startUtf16 - cursor });
      }
      cursor = Math.max(cursor, endUtf16);
      flowLines.push({
        kind: "visual",
        paragraphId: unitLine.paragraphId,
        startUtf16,
        endUtf16,
        contentWidth: vl.contentWidth,
        lineHeight,
        textIndent: vl.textIndent,
        // ★ 首行不需要显式换行（其余 visual 行才需要）
        needsExplicitBreak: flowLines.length > 0,
      });
    }

    // ② 本 paragraph 之后的显式 separator（**属于 EditingUnit，不属于 Core**）
    const sep = unit.separators.find((s) => s.afterLineId === unitLine.lineId);
    if (sep) {
      const sepStart = unitLine.endUtf16;
      const sepEnd = sepStart + sep.text.length;
      if (sepStart !== cursor) {
        contiguous = false;
        gaps.push({ afterFlowLineIndex: flowLines.length, gapUtf16: sepStart - cursor });
      }
      // ★ separator 恒占 unit offset（坐标模型已冻结）
      cursor = sepEnd;
      flowLines.push({
        kind: "separator",
        paragraphId: null,
        startUtf16: sepStart,
        endUtf16: sepEnd,
        contentWidth: null,
        // separator 行高取其**后继视觉行**的行高在下方统一修正；此处先用前一行
        lineHeight: 0,
        textIndent: null,
        // ★ 不需要显式换行元素：`\n` 在 pre-wrap 下天然换行
        needsExplicitBreak: false,
      });
    }
  }

  // ── separator 行高：用**后继视觉行**的行高（否则末行无参考）──
  const patched = flowLines.map((l, i) => {
    if (l.kind !== "separator") return l;
    const next = flowLines.slice(i + 1).find((x) => x.kind === "visual");
    return { ...l, lineHeight: next ? next.lineHeight : 0 };
  });

  const totalFlowHeight = r2(patched.reduce((s, l) => s + l.lineHeight, 0));
  const visualLineCount = patched.filter((l) => l.kind === "visual").length;
  return {
    ok: true,
    partition: {
      flowLines: patched,
      totalFlowHeight,
      visualLineCount,
      separatorLineCount: patched.length - visualLineCount,
      contiguousCoverage: contiguous,
      coveredToUtf16: cursor,
      unitTextLength: unit.text.length,
      gaps,
      logicalLineCount: unit.lines.length,
      unitId: unit.unitId,
    },
  };
}
