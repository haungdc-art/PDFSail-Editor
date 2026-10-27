/**
 * editor/binding/capability-contract.ts — F3B-6.17-3C-8 CapabilityContract
 *
 * ── 本模块**不是**新的 mutation API ──────────────────────────────────
 * 它**不**返回 `EditableDocument`、**不**执行任何 mutation、**不**接触 Legacy 编辑模型。
 * 它只做一件事：把 Toolbar Capability 的**语义意图**规范化成可映射到 Core Command 的形态。
 *
 *      Capability ──▶ CapabilityIntent ──▶ Core Command（构造，非执行）
 *
 * PDF fidelity（`editedOriginalBounds` / `droppedOperatorIds` / glyph provenance 等）
 * **不由本模块、也不由 Core Command 产出** —— 由既有 Binding / reconciliation / export 链承担。
 *
 * ── 关键事实（3C-8 审计，全部从生产代码确认）─────────────────────────
 * 5 个注册能力的 Command（`replace` / `delete` / `rewrite` / `translate` / `fixOcr`）
 * 实现**结构完全相同**：读 runtime 文档 → 定位 block/line → 读行全文 →
 * 把 `[start, end+1)` 区间替换为 `payload.text` → 调同一个 Legacy mutation kernel。
 * 唯一差异：
 *   · `delete` —— 替换文本恒为空串，且 `selection.isEmpty` 时提前 return
 *   · 其余四个 —— 替换文本 = `payload.text`
 * 因此**语义上只有一种操作：单行区间替换**（删除 = 替换为空串）。
 * 「AI 改写 / 翻译 / OCR 校正」只发生在**上层**（产出 `payload.text`），
 * Command 本身不做网络请求、不做语义加工（各 Command 头部注释已明确）。
 *
 * ── 三类能力（3C-8 裁决）─────────────────────────────────────────────
 *   A. Core-migratable：`replace` / `delete` / `rewrite`
 *      —— 可表达为 Core `replace-text` / `delete-text`。
 *   B. Legacy-only / fidelity-specific：各 Command 经 Legacy kernel 顺带写出的
 *      fidelity 字段 —— **不得**迁入 Core，须改由 Binding projection 产出。
 *   C. UNRESOLVED：`translate` / `fixOcr`
 *      —— 派发语义尚未稳定（`translate` 的 UI 按钮实际派发 `rewrite`；
 *         `fixOcr` 已注册但无 UI 生产 caller）⇒ **不虚构 contract**。
 *      （F3B-6.25：`translate` 已进入类型层 `CapabilityName`，但 UI 派发语义仍未稳定，
 *        故仍归 C 类——类型收口 ≠ 派发语义收口。）
 *
 * ── 边界（本阶段 contract-only）──────────────────────────────────────
 * 不迁移 UI、不改 `__replaceMode`、不改 PDFEditor 主流程、不碰 EditSession /
 * TextEditOverlay / OCR / Legacy export / Sidecar schema；Legacy kernel 全部保留
 * 为 fallback / compatibility capability。
 */

// ─────────────────────────────────────────────────────────────────────
//  能力清单（生产实际注册，见 PDFEditor 组合根 L5375-5379）
// ─────────────────────────────────────────────────────────────────────

/** 生产实际注册的 5 个能力名 */
export type RegisteredCapability = "replace" | "delete" | "rewrite" | "fixOcr" | "translate";

export const REGISTERED_CAPABILITIES: readonly RegisteredCapability[] = [
  "replace",
  "delete",
  "rewrite",
  "fixOcr",
  "translate",
];

/**
 * 类型层 `CapabilityName`（`document-model/edit-capability.ts`）。
 * F3B-6.25：`translate` 已随 E4 正式注册而纳入类型层（3C-8 记录的 mismatch 已收口）。
 */
export const CAPABILITY_TYPE_LAYER: readonly RegisteredCapability[] = [
  "replace",
  "delete",
  "rewrite",
  "fixOcr",
  "translate",
];

/** A 类：可映射到既有 Core Command */
export const CORE_MIGRATABLE_CAPABILITIES: readonly RegisteredCapability[] = [
  "replace",
  "delete",
  "rewrite",
];

/** C 类：派发语义未稳定 ⇒ UNRESOLVED，不虚构 contract */
export const UNRESOLVED_CAPABILITIES: readonly RegisteredCapability[] = ["translate", "fixOcr"];

/**
 * B 类：由 Legacy kernel 顺带产出、**不得**进入 Core 的 fidelity 字段。
 * 这些必须由 Binding projection / export policy 承担。
 */
export const CAPABILITY_FIDELITY_FIELDS: readonly string[] = [
  "editedOriginalBounds",
  "droppedOperatorIds",
  "operatorId",
  "operatorCharIndex",
  "originalChar",
  "nativeReplacementState",
];

// ─────────────────────────────────────────────────────────────────────
//  CapabilityIntent（语义意图；不含 EditableDocument）
// ─────────────────────────────────────────────────────────────────────

/** 语义操作种类 */
export type CapabilityIntentKind = "replace" | "delete" | "noop";

/** clamp 后的合法 glyph 区间（**含端**） */
export interface ClampedCapabilityRange {
  readonly start: number;
  readonly end: number;
}

/**
 * ★ 3C-9 **统一 precondition**：先 clamp 到 `[0, glyphCount-1]`，再判 `start > end`。
 *
 * ── 为什么必须统一（3C-8 实测的分叉）─────────────────────────────────
 * 现有 5 个 Command 的 P0 guard **口径不一致**：
 *   · `ReplaceCommand` —— clamp **前**判断 `selection.startGlyphIndex > selection.endGlyphIndex`
 *   · 其余四个          —— clamp **后**判断 `start > end`
 * 非越界输入下二者等价；但**越界输入下可能分叉**。
 * Shadow 阶段最怕「production 与 Core 看起来一样、边界输入却 divergence」，
 * 故本 contract 统一为 **clamp 后判断**，并**不**顺手修改那五个 Command。
 *
 * @returns `null` = 非法输入（调用方必须中止，绝不写坏文档）
 */
export function clampCapabilityRange(
  selection: CapabilityTargetInput,
  glyphCount: number
): ClampedCapabilityRange | null {
  const start = Math.max(0, selection.startGlyphIndex);
  const end = Math.min(glyphCount - 1, selection.endGlyphIndex);
  if (start > end) return null;
  return { start, end };
}

/** 目标定位（与 `DocumentSelection` 的**定位字段**同形，故结构上兼容） */
export interface CapabilityTargetInput {
  readonly blockId: string;
  readonly lineId: string;
  /** 区间起点 glyph 行内索引 */
  readonly startGlyphIndex: number;
  /** 区间终点 glyph 行内索引（**含**） */
  readonly endGlyphIndex: number;
  /** 是否为空选区（caret）；`delete` 时语义为 no-op */
  readonly isEmpty?: boolean;
  /** 选中文本（仅回显/校验，不用于定位） */
  readonly text?: string;
}

/**
 * 规范化后的能力语义意图。
 *
 * ⚠️ 刻意**不含** `EditableDocument`：本结构描述「要做什么语义操作」，
 *    不是 mutation 结果。fidelity 字段一律不在此出现（见 `CAPABILITY_FIDELITY_FIELDS`）。
 */
export interface CapabilityIntent {
  /** 来源能力名（仅标注，不参与语义判定） */
  readonly capability: RegisteredCapability;
  readonly kind: CapabilityIntentKind;
  readonly blockId: string;
  readonly lineId: string;
  readonly startGlyphIndex: number;
  readonly endGlyphIndex: number;
  /** 替换文本；`delete` 语义时为空串 */
  readonly text: string;
  /** 能力特有的**非语义**参数（仅透传记录，不参与 Core 命令构造） */
  readonly params?: Readonly<Record<string, unknown>>;
}

/** 可映射到 Core Command 的语义规格（**构造描述，非执行**） */
export interface CapabilityCoreCommandSpec {
  /** Core `CommandType` 成员（见 `editor/core/commands/types.ts`） */
  readonly commandType: "replace-text" | "delete-text";
  readonly text: string;
  readonly blockId: string;
  readonly lineId: string;
  readonly startGlyphIndex: number;
  readonly endGlyphIndex: number;
}

// ─────────────────────────────────────────────────────────────────────
//  规范化：5 个能力 → 同一个语义意图
// ─────────────────────────────────────────────────────────────────────

/**
 * 把 Legacy Capability 的入参（selection + payload）规范化为 `CapabilityIntent`。
 *
 * 语义规则（与 5 个 Command 的实际行为逐一对应）：
 *   · `delete`：`isEmpty` ⇒ no-op；否则替换文本为空串
 *   · 其余：替换文本 = `payload.text`（缺失/null ⇒ 空串 = 删除语义）
 *   · `start > end`（非法/跨行压缩区间）⇒ `null`（绝不写坏文档，与各 Command 的 P0 guard 同口径）
 *
 * @returns `null` = 无可执行语义（no-op 或非法），调用方应**什么都不做**。
 */
export function toCapabilityIntent(
  selection: CapabilityTargetInput,
  payload: Record<string, unknown> | undefined,
  capability: RegisteredCapability
): CapabilityIntent | null {
  const start = selection.startGlyphIndex;
  const end = selection.endGlyphIndex;

  // P0 guard：与 Replace/Delete/Rewrite/Translate/FixOcr 五个 Command 的安全门同口径。
  if (start > end) return null;

  let text: string;
  if (capability === "delete") {
    // DeleteCommand：空选区（caret）无删除语义 ⇒ 提前返回
    if (selection.isEmpty) return null;
    text = "";
  } else {
    const raw = payload?.text;
    text = raw == null ? "" : String(raw);
  }

  // 语义种类：替换文本为空且区间非空 ⇒ 删除；否则替换。
  // （`replace` 传空串时与 `delete` 同义 —— 生产 Delete 按钮即走 `replace` + 空串）
  const kind: CapabilityIntentKind = "replace";

  return {
    capability,
    kind,
    blockId: selection.blockId,
    lineId: selection.lineId,
    startGlyphIndex: start,
    endGlyphIndex: end,
    text,
    params: payload,
  };
}

/**
 * Intent → Core Command 规格（**只构造描述，不执行、不碰 Legacy 文档**）。
 *
 * `text === ""` ⇒ `delete-text`（删除区间）；否则 `replace-text`。
 *
 * @returns `null` = 无可执行语义。
 */
export function decideCapabilityCoreCommand(
  intent: CapabilityIntent
): CapabilityCoreCommandSpec | null {
  if (intent.kind === "noop") return null;
  return {
    commandType: intent.text === "" ? "delete-text" : "replace-text",
    text: intent.text,
    blockId: intent.blockId,
    lineId: intent.lineId,
    startGlyphIndex: intent.startGlyphIndex,
    endGlyphIndex: intent.endGlyphIndex,
  };
}

/**
 * 该能力是否已有稳定的可迁移语义（A 类 ⇒ true；C 类 ⇒ false）。
 *
 * ⚠️ 返回 false **不表示**该能力「不能实现」—— 其内核与 A 类相同；
 *    只表示**生产派发语义尚未稳定**，现阶段不得据此虚构 contract。
 */
export function isCapabilityMigratable(capability: RegisteredCapability): boolean {
  return CORE_MIGRATABLE_CAPABILITIES.includes(capability);
}
