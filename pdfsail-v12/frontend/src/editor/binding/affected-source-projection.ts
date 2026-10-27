/**
 * editor/binding/affected-source-projection.ts — F3B-6.17-3C-6A.2-CB1
 *
 * Affected Source Projection Contract（**纯 Binding 层 / read-only**）。
 *
 * ── 本模块解决什么 ───────────────────────────────────────────────────
 * C-B2 / C-B2.1 已证明：Core 端 Segment 编辑是 **run 粒度替换**
 * （实测 `[SEGMENT_CORE_COMMIT] {kind: replace, start: 0, end: 11}`，只改 3 字符也整 run 替换），
 * 因此**编辑行里不存在「原始 glyph」** —— 导出的 `stripReplacedTextOperators`
 * 只能从 `line.glyphs[].operatorId`（edited line）/ `line.droppedOperatorIds` 收集算子
 * （`document-model/export-renderer.ts#L345-390`），而 Core 路径下二者都是空的
 * ⇒ **编辑行原文残留在文本层**（CB2.1 实测：`"EMBEDTESTHELLO WORLDZQ9LO WORLD"`）。
 *
 * 原始 provenance **只能来自 BindingSidecar**。本模块把「Core 语义编辑 → PDF 原文
 * glyph/operator」这一步做成**可测的纯函数契约**，不接 export、不写任何 line 字段。
 *
 * ── 两段式（用户明确要求，避免概念互相污染）─────────────────────────
 *   ① `computeAffectedSourceProjection`  —— Binding 层事实投影：
 *        Core(before/after/command/result) + Sidecar → **AffectedSourceProjection**
 *        回答「这次编辑影响了哪些**原 PDF source**（glyph / bbox / operator）」
 *   ② `projectExportDrop`                —— export 面向的派生投影：
 *        AffectedSourceProjection → **ExportDropOperatorProjection**
 *        产出 `droppedOperatorIds` / `editedOriginalBounds`（与既有 `EditableLine` 字段同语义）
 *
 * `droppedOperatorIds` **不是** source projection 的核心字段 —— 它是 ② 的产物。
 *
 * ── 当前 Core 模型的关键参数：redraw 粒度 ─────────────────────────────
 * 由于「编辑行会被整行重绘」，② 需要知道重绘粒度：
 *   · `redrawGranularity: "line"`（**当前 Core 现实**）⇒ 丢弃该行**全部**原算子
 *   · `redrawGranularity: "range"`（char 粒度模型）⇒ 只丢弃**被替换/删除**子区间的原算子
 * 二者都暴露、都测：**不把整 run 假设写死进通用 contract**（用户要求）。
 *
 * ── fail-closed（严格）────────────────────────────────────────────────
 *   · Sidecar 缺失 / 受影响行无法解析 ⇒ `UNKNOWN` ⇒ ② 返回空集 + `failClosed: true`
 *   · 部分 glyph 无 operatorId ⇒ `PARTIAL` ⇒ **只**输出已知算子，绝不伪造
 *   · 空白 glyph（`originalChar.trim() === ""`）本无独立算子，**不计入** unknown
 *     （与 `export-renderer.ts#L356-357` 同口径）
 *   · 绝不把局部编辑扩大为全页/全行之外的删除：所有算子**只**来自受影响行的 Sidecar 序列
 *
 * 禁止（本模块边界）：不修改 Core Command / EditorDocument / `TextRun.source` /
 * Sidecar schema / export-renderer / Legacy mutation；不接 EditSession；不写
 * `line.droppedOperatorIds` / `line.editedOriginalBounds`；不新增 provenance source。
 *
 * ── F3B-6.28 · D 阶段第一阶段：位移行（displaced）────────────────────────
 * 段落重排会把**后续原始行**推到新位置：这些行文本未变、段落归属也未变 ⇒
 * before/after diff 结构上发现不了，但旧位置的原算子必须剥离（否则位移后
 * 新旧文字重叠）。因此新增 `displacedLines` 输入（调用方显式声明）与
 * `mutation: "displaced"`；声明了却无法定位的行记入 `unresolved`（显式失败）。
 * 本阶段**只做清除**，不产出重绘几何（那属于第二阶段）。
 */

import type { EditorDocument, TextRun } from "../core/document/types";
import type { CommandType } from "../core/commands";
import type { BBox } from "../../document-model/types";
import type { BindingSidecar, GlyphRange, OriginalGlyph } from "./binding-sidecar";
import { lookupGlyphRange, lookupLineBinding } from "./binding-sidecar";
import type { ExportRedrawScenario } from "./export-redraw-scenario";

// ─────────────────────────────────────────────────────────────────────
//  类型
// ─────────────────────────────────────────────────────────────────────

/** 整体可判定性 */
export type AffectedCoverage = "KNOWN" | "PARTIAL" | "UNKNOWN";

/** 本次编辑对某行的作用类别（由 before/after **source 归属文本** 推导） */
export type AffectedMutation =
  | "replace"
  | "delete"
  | "insert"
  | "disappeared"
  | "displaced"
  /** D 第二步（决策二）：unit 成员行（文本可能未变，但整行将被 flow 重绘 ⇒ 原算子必须剥离） */
  | "unit-member"
  | "unknown";

/**
 * F3B-6.28 · D 阶段第一阶段：被段落重排**位移**的原始行。
 *
 * 这些行文本未变、段落归属也未变 ⇒ before/after diff **结构上无法发现**，
 * 但它们的旧位置必须被清除（否则位移后新旧文字重叠）。因此只能由调用方
 * （受控 unit 编辑的流布局结果）显式声明。
 */
export interface DisplacedLineTarget {
  readonly blockId: string;
  readonly lineId: string;
}

// ─────────────────────────────────────────────────────────────────────
//  三种身份（**显式区分，不得混用**）—— F3B-6.28 · D 身份修复
// ─────────────────────────────────────────────────────────────────────

/**
 * **Core 段落身份**（`textBoxId` + `paragraphId`）—— Core 文档空间。
 * 导出侧（bridge `lineDropOf`）按它匹配重绘行。
 */
export interface CoreParagraphIdentity {
  readonly textBoxId: string;
  readonly paragraphId: string;
}

/**
 * 受控 unit 编辑提交时登记的**清除目标**。
 *
 * `blockId` + `lineId` = **source line ID**（PDF import-time 行身份，Sidecar 主键）。
 * `coreIdentity` = 提交时从 **unit 事务的 `operations[].paragraphId`** 登记的
 * **Core 段落身份**（经 unit 行映射，成员行全覆盖）。
 *
 * ⚠️ 为什么需要它：Core 编辑后 run 的 source 可能被剥离/替换（§24/§25），
 *   「编辑后从 run.source 反查 source key」在整行替换时拿不到 after 侧身份
 *   ⇒ 成员行的 drop 无法匹配 bridge 行。提交时登记的身份与 after 文档同源，
 *   是唯一不依赖"编辑后 source key 幸存"的匹配键。
 */
export interface DisplacedClearTarget {
  readonly blockId: string;
  readonly lineId: string;
  /** 提交时登记的 Core 段落身份（缺省 = 仅 source key 机制） */
  readonly coreIdentity?: CoreParagraphIdentity | null;
}

/**
 * 受控 unit 编辑提交时登记的「位移清除计划」（PDFEditor 侧 ref 的类型）。
 *
 * ⚠️ 只存**身份 + 提交时的事务证据**，不存几何、不存屏幕坐标：
 *   · `appliedTxId` = 登记时 Core 最后一条**已应用**事务的 id（`EditorTransaction.id`）。
 *     导出侧校验「当前最后已应用事务的 id 是否仍等于它」——这是**身份**校验，
 *     能正确处理「Undo 后又产生新事务」的情况（新事务 id ≠ 计划事务 id ⇒ 失效）；
 *   · `appliedIndex` 双重校验（undo 过头 ⇒ 失效）；
 *   · `sidecarGeneration` = 登记时的 **Sidecar（import-time 文档）代次**——
 *     drop 的原算子来自 Sidecar，跨代次（re-import / OCR injection）必然失效。
 *
 * ★ D-3B-5（用户 2026-10-14 裁决）：`scenario` = 本计划的**场景授权**（
 *   `classifyExportRedrawScenario` 的判定结果，来源 = 事务本身 + 位移行页面归属）。
 *   只有 `d1-paragraph-append`（D1 段落末尾追加）被授权进入「清除 + 重绘」链；
 *   其它场景（替换/删除/合并/多段落流动/跨页推挤）⇒ 导出侧必须让本计划
 *   **整体不参与**（清除与重绘都不做），回到既有路径。
 */
export interface DisplacedClearPlan {
  readonly unitId: string;
  readonly sidecarGeneration: number | null;
  readonly appliedTxId: string;
  readonly appliedIndex: number;
  /** 被流推进的原始行（文本未变，旧位置必须清除） */
  readonly lines: readonly DisplacedClearTarget[];
  /** D 第二步（决策二）：unit 的**全部成员行**（都会被 flow 重绘 ⇒ 原算子必须剥离） */
  readonly memberLines: readonly DisplacedClearTarget[];
  /**
   * D-3B-0 · **本次事务实际改动到的成员行** lineId（原始断行保真的唯一授权来源）。
   *
   * ★ 来源纪律（用户 2026-10-13）：必须来自**事务本身**
   *   （`UnitTransactionCommand.operations[].paragraphId` → unit 成员行），
   *   **禁止**由最终文本 / 几何变化 / diff 反推 —— 反推会把「模型误差」误判成「用户编辑」。
   *
   * ★ 生命周期：与计划同生共死 —— 计划失效（Undo/Redo/事务被取代/文档切换/
   *   Sidecar 代次变化）⇒ 本字段一并失效 ⇒ 调用方必须回到保守模式
   *   （全部成员行按硬断行 + `original-break-unresolved`），绝不沿用旧声明。
   */
  readonly changedLineIds: readonly string[];
  /**
   * D-3B-5 · 场景授权（`classifyExportRedrawScenario().scenario`）。
   * `unsupported` ⇒ 导出侧整体不消费本计划（见 `decideExportRedrawGate`）。
   */
  readonly scenario: ExportRedrawScenario;
  /** `scenario === "unsupported"` 时的人可读原因（取证/日志用） */
  readonly scenarioDetail: string;
}

/**
 * D-3B-0 · 从**事务本身**推导「本次改动到的成员行」（原始断行保真的授权来源）。
 *
 * 纪律：唯一输入是事务的 `operations[].paragraphId`（+ textBoxId 复核），
 * **绝不**看最终文本 / 几何 / diff —— 那些会把模型误差误判成用户编辑。
 *
 * fail-closed（任一命中 ⇒ `ok:false` ⇒ 调用方回到保守模式 + unresolved）：
 *   · 事务无操作（无法证明改了哪一行）；
 *   · 某个操作映射不到 unit 成员行；
 *   · 某个操作映射到多条成员行（不唯一 ⇒ 不猜）。
 */
export function changedLineIdsOfTransaction(
  unitLines: readonly { lineId: string; textBoxId: string; paragraphId: string }[],
  operations: readonly { textBoxId?: string; paragraphId?: string }[],
):
  | { readonly ok: true; readonly lineIds: readonly string[] }
  | {
      readonly ok: false;
      readonly reason: "empty-operations" | "unmapped-operation" | "ambiguous-operation";
      readonly detail: string;
    } {
  if (operations.length === 0) {
    return { ok: false, reason: "empty-operations", detail: "事务无操作 ⇒ 无法证明改动了哪些成员行" };
  }
  const hits = new Set<string>();
  for (const op of operations) {
    const pid = op.paragraphId;
    const matched = unitLines.filter((l) => l.paragraphId === pid);
    if (matched.length === 0) {
      return {
        ok: false,
        reason: "unmapped-operation",
        detail: `操作段落 ${String(pid)} 不在 unit 成员行中 ⇒ 无法唯一映射`,
      };
    }
    if (matched.length > 1) {
      return {
        ok: false,
        reason: "ambiguous-operation",
        detail: `操作段落 ${String(pid)} 命中 ${matched.length} 条成员行 ⇒ 映射不唯一`,
      };
    }
    const one = matched[0]!;
    if (typeof op.textBoxId === "string" && op.textBoxId && one.textBoxId !== op.textBoxId) {
      return {
        ok: false,
        reason: "unmapped-operation",
        detail: `操作 textBoxId(${op.textBoxId}) 与成员行 ${one.lineId} 的 textBoxId(${one.textBoxId}) 不一致`,
      };
    }
    hits.add(one.lineId);
  }
  return { ok: true, lineIds: [...hits] };
}

/** 导出侧校验计划是否仍然有效的输入（避免耦合 Core History 类型） */
export interface ClearPlanHistoryView {
  readonly appliedCount: number;
  /**
   * **已应用**事务的 id 序列（按栈序，长度 = appliedCount；redo 栈不计入）。
   * 即 `history.entries().slice(0, appliedCount).map(t => t.id)`。
   */
  readonly appliedTxIds: readonly string[];
  /** 当前 Sidecar 代次（= import-time 文档代次；无 Sidecar ⇒ null） */
  readonly sidecarGeneration: number | null;
}

/**
 * 计划是否仍然有效。
 *
 * 权威判据：**登记水位处的事务仍是计划所属事务** ——
 *   `appliedTxIds[plan.appliedIndex - 1] === plan.appliedTxId`
 *
 * 这能正确处理用户点名的风险：
 *   · Undo 过头（appliedCount < 登记水位）⇒ 失效；
 *   · Undo 后又产生新事务（同水位、id 已变）⇒ 计划所属事务已被取代 ⇒ 失效；
 *   · 在计划之上继续编辑（水位更高、栈底不变）⇒ 仍有效；
 *   · Sidecar 代次变化（re-import / OCR injection 换了文档）⇒ 失效。
 */
export function displacedClearPlanIsCurrent(
  plan: DisplacedClearPlan | null | undefined,
  current: ClearPlanHistoryView
): boolean {
  if (!plan) return false;
  if (plan.lines.length === 0 && plan.memberLines.length === 0) return false;
  if (!Number.isFinite(current.appliedCount)) return false;
  if (current.appliedCount < plan.appliedIndex) return false;
  // 文档代次：计划登记的 Sidecar 代次必须与当前一致（任一缺失 ⇒ 无法证明同代次 ⇒ 失效）
  if (plan.sidecarGeneration === null || current.sidecarGeneration === null) return false;
  if (plan.sidecarGeneration !== current.sidecarGeneration) return false;
  const idx = plan.appliedIndex - 1;
  if (idx < 0 || idx >= current.appliedTxIds.length) return false;
  if (current.appliedTxIds[idx] !== plan.appliedTxId) return false;
  return true;
}

/** 单条受影响原行的 source 事实投影 */
export interface AffectedSourceLine {
  blockId: string;
  lineId: string;
  /** Sidecar import-time 行序（未解析时为 -1） */
  lineIdx: number;
  mutation: AffectedMutation;
  /** 该行原始 glyph 序列在 Sidecar 中的 inclusive 下标区间（未解析为 null） */
  originalGlyphRange: GlyphRange | null;
  originalGlyphCount: number;
  /** 缺 operatorId 的**非空白**原始 glyph 数量（PARTIAL 判据） */
  provenanceUnknownGlyphCount: number;
  /** 原始 glyph 几何（Sidecar `sourceBBox`，顺序与 originalGlyphs 一致） */
  sourceBBoxes: BBox[];
  /** 已知原算子 id（保持 Sidecar 顺序、去重） */
  operatorIds: string[];
  /** 与 `operatorIds` **平行**的 charIndex（未知为 undefined） */
  operatorCharIndexes: Array<number | undefined>;
  /**
   * 与 `sourceBBoxes` **位置平行**的 operatorId。
   *
   * `operatorIds` 是去重集合（一个算子可承载多个 glyph，如 "100%" 一个 Tj），
   * 与 glyph 序列不平行；本字段提供 position → operatorId 的精确映射，
   * 供 `"range"` 粒度只挑「被替换区间」的算子。
   */
  operatorIdByGlyphPosition: Array<string | undefined>;
  /**
   * 被本次编辑**替换/删除**的原 glyph 下标（**在 `operatorIds` 对应的 Sidecar 序列内的位置**）。
   * 纯插入（source 归属文本未变）⇒ `[]`。
   */
  replacedGlyphIndexes: number[];
  /** 上述替换区间的 UTF-16 范围（相对该行**原始**文本；UNKNOWN 时 null） */
  replacedUtf16Range: { start: number; end: number } | null;
  /** 该行 source 归属文本的 diff 是否可判定（`originalChar` 缺失 ⇒ UNKNOWN，不猜） */
  replacedGlyphCoverage: AffectedCoverage;
  /** 该行所属段落的**整体**文本是否变化（generated 插入也算 ⇒ 行会被整行重绘） */
  paragraphTextChanged: boolean;
  /**
   * 该 source 行对应的 **Core 侧身份**（`buildEditableDocument` 也能拿到的稳定键）。
   *
   * ⚠️ 必需：Core 替换后该 run 变成 `{kind:"generated"}`（§24/§26），
   * 桥接产物拿不到 PDF lineId ⇒ 只能用 `(textBoxId, paragraphId)` 匹配回受影响行。
   *
   * `registered`（F3B-6.28 · D 身份修复）= 提交时从 unit 事务登记的
   * **Core 段落身份**。存在时它是权威匹配键（与 after 文档同源，不依赖
   * "编辑后 source key 幸存"）；消费方应优先用它建索引。
   */
  coreIdentity: {
    textBoxId: string;
    paragraphIds: string[];
    /** 结构位置键（`pageIndex:textBoxIndex:paragraphIndex`）—— 跨 id 空间稳定 */
    positions: string[];
    /** 提交时登记的 Core 段落身份（权威匹配键；无登记 ⇒ null） */
    registered: CoreParagraphIdentity | null;
  };
}

export interface AffectedSourceProjection {
  coverage: AffectedCoverage;
  /** 已解析的受影响原行（按 before/after 出现顺序稳定排序） */
  lines: AffectedSourceLine[];
  /** 声明了 pdf-native `(blockId,lineId)` 但 Sidecar 未命中 ⇒ fail-closed */
  unresolved: Array<{ blockId: string; lineId: string }>;
  /** 受影响但**没有** pdf-native source 归属的内容（generated / OCR / user） */
  sourceless: Array<{ textBoxId: string; paragraphId: string; mutation: AffectedMutation }>;
  /** 输入侧元数据（仅记录，不参与判定） */
  commandType: CommandType | null;
  changed: boolean | null;
  sidecarGeneration: number | null;
}

export interface AffectedSourceProjectionInput {
  before: EditorDocument;
  after: EditorDocument;
  /** 只读取 `type`（不耦合 Command 内部字段） */
  command?: { readonly type: CommandType } | null;
  /** 只读取 `changed`（可选，`before/after` 才是权威） */
  result?: { readonly changed?: boolean } | null;
  sidecar?: BindingSidecar | null;
  /**
   * F3B-6.28 · D 第一阶段：被段落重排**位移**的原始行（文本未变，旧位置必须清除）。
   * 由受控 unit 编辑的流布局显式提供；缺省 ⇒ 行为与本阶段之前逐字段一致。
   * 可携带提交时登记的 Core 段落身份（`coreIdentity`）作为权威匹配键。
   */
  displacedLines?: readonly DisplacedClearTarget[] | null;
  /**
   * F3B-6.28 · D 第二步（决策二）：受控 unit 的**全部成员行**（不论文本是否变化）。
   * 这些行都会被 flow 视觉行重新合成 ⇒ 原算子必须剥离，否则新旧文字重复。
   * 缺省 ⇒ 行为与本阶段之前逐字段一致（只有文本变了的成员行会被 diff 发现）。
   *
   * ⚠️ 成员行**必须**携带 `coreIdentity`（unit 事务的 `operations[].paragraphId`）：
   *   Core 编辑后 run source 可能被剥离 ⇒ 只靠 source key 反查无法稳定匹配 bridge 行。
   */
  unitMemberLines?: readonly DisplacedClearTarget[] | null;
}

/** export 面向的派生投影（与既有 `EditableLine` 字段同语义） */
export interface ExportDropOperatorProjection {
  coverage: AffectedCoverage;
  /** true ⇒ 调用方**不得**写入任何 drop 信息（什么都不做，保留原文） */
  failClosed: boolean;
  partial: boolean;
  redrawGranularity: "line" | "range";
  /** 全量并集（保持顺序、去重） */
  droppedOperatorIds: string[];
  /** 全量并集（每行一个合并盒） */
  editedOriginalBounds: BBox[];
  /** 逐行结果（供调用方写 `line.droppedOperatorIds` / `line.editedOriginalBounds`） */
  lines: Array<{
    blockId: string;
    lineId: string;
    /** Core 侧身份（overlay 匹配键；见 `AffectedSourceLine.coreIdentity`） */
    coreIdentity: {
      textBoxId: string;
      paragraphIds: string[];
      positions: string[];
      registered: CoreParagraphIdentity | null;
    };
    droppedOperatorIds: string[];
    editedOriginalBounds: BBox[];
  }>;
}

// ─────────────────────────────────────────────────────────────────────
//  before/after 结构快照
// ─────────────────────────────────────────────────────────────────────

interface LineAgg {
  blockId: string;
  lineId: string;
  /** **只**累计 pdf-native source 归属 run 的文本（= 可回溯到 PDF 原文的部分） */
  sourceText: string;
}

interface ParaAgg {
  textBoxId: string;
  paragraphId: string;
  /** 整段文本（含 generated run） */
  text: string;
  /** 本段中 pdf-native source 归属的 key */
  keys: string[];
  /**
   * **结构位置**（文档顺序 `pageIndex:textBoxIndex:paragraphIndex`）。
   * ⚠️ 跨 id 空间稳定：生产里 Core session 可能由 legacy 引导的第二次 adapter 调用创建，
   * 其 id 与 import-time 快照不同，只有位置可比。
   */
  position: string;
}

interface DocSnap {
  byKey: Map<string, LineAgg>;
  byPara: Map<string, ParaAgg>;
}

function runSourceKey(run: TextRun): { blockId: string; lineId: string } | null {
  const source = run.source;
  if (!source) return null;
  if (source.kind !== "pdf-native") return null;
  if (!source.blockId || !source.lineId) return null;
  return { blockId: source.blockId, lineId: source.lineId };
}

function snapshot(doc: EditorDocument): DocSnap {
  const byKey = new Map<string, LineAgg>();
  const byPara = new Map<string, ParaAgg>();

  for (let pageIndex = 0; pageIndex < doc.pages.length; pageIndex++) {
    const page = doc.pages[pageIndex];
    // ★ 2026-10-22：结构位置键的页号 = **page.index - 1**（0-based PDF 页号，与
    //   pdf-export-bridge 的查询键同口径）。**不能用数组下标**——editableDocument
    //   懒加载（跳页访问后 pages=[第1页,第11页]）⇒ 下标 ≠ 页号-1 ⇒ drop/重绘的
    //   位置匹配键错位 ⇒ 导出既不剥原算子也不重绘（修改静默丢失）。
    //   缺 index（单测 mock / 旧形状）⇒ 退回下标（全量文档二者等价，行为不变）。
    const positionPageNo =
      typeof (page as { index?: unknown }).index === "number" &&
      Number.isFinite((page as { index: number }).index) &&
      (page as { index: number }).index >= 1
        ? (page as { index: number }).index - 1
        : pageIndex;
    for (let textBoxIndex = 0; textBoxIndex < page.objects.length; textBoxIndex++) {
      const textBox = page.objects[textBoxIndex];
      if (textBox.type !== "text") continue; // F3B-6.24-B3：图片对象无段落
      for (let paragraphIndex = 0; paragraphIndex < textBox.paragraphs.length; paragraphIndex++) {
        const paragraph = textBox.paragraphs[paragraphIndex];
        const paraKey = `${textBox.id}|${paragraph.id}`;
        const para: ParaAgg = {
          textBoxId: textBox.id,
          paragraphId: paragraph.id,
          text: "",
          keys: [],
          position: `${positionPageNo}:${textBoxIndex}:${paragraphIndex}`,
        };
        for (const run of paragraph.runs) {
          para.text += run.text;
          const key = runSourceKey(run);
          if (!key) continue;
          const mapKey = `${key.blockId}|${key.lineId}`;
          if (!para.keys.includes(mapKey)) para.keys.push(mapKey);
          const agg = byKey.get(mapKey) ?? { ...key, sourceText: "" };
          agg.sourceText += run.text;
          byKey.set(mapKey, agg);
        }
        byPara.set(paraKey, para);
      }
    }
  }
  return { byKey, byPara };
}

// ─────────────────────────────────────────────────────────────────────
//  文本 diff（source 归属文本 → 被替换/删除的原 UTF-16 区间）
// ─────────────────────────────────────────────────────────────────────

/** 最长公共前缀 / 后缀（UTF-16 code unit 口径） */
function diffRange(before: string, after: string): { start: number; end: number } {
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p += 1;
  let s = 0;
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) {
    s += 1;
  }
  return { start: p, end: before.length - s };
}

/**
 * 行级 mutation 分类（输入 = 该行**全文** before/after）。
 *
 * ⚠️ 必须用**全文**而不是 source 归属文本：Core 把替换后的新文本标记为
 * `{kind:"generated"}`（§24/§26）⇒ source 归属文本会整体消失，
 * 用它做 diff 会把「缩短编辑」误判为整行删除。
 */
function classifyLineMutation(beforeText: string, afterText: string): AffectedMutation {
  if (beforeText === afterText) return "insert"; // 仅结构变化 / 纯 generated 插入
  if (afterText === "") return "delete";
  if (beforeText === "") return "insert";
  if (afterText.includes(beforeText)) return "insert";
  if (beforeText.includes(afterText)) return "delete";
  return "replace";
}

/**
 * 把「原文本 UTF-16 区间」映射为 Sidecar glyph 下标（**位置**，不是 `index` 字段）。
 *
 * 任一 `originalChar` 缺失 ⇒ `null`（fail-closed，绝不猜偏移）。
 */
function glyphPositionsForUtf16Range(
  glyphs: readonly OriginalGlyph[],
  range: { start: number; end: number }
): number[] | null {
  if (range.end <= range.start) return [];
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < glyphs.length; i++) {
    const len = glyphs[i]?.originalChar?.length ?? 0;
    if (len === 0) return null;
    const gStart = acc;
    const gEnd = acc + len;
    if (gStart < range.end && gEnd > range.start) out.push(i);
    acc = gEnd;
  }
  return out;
}

/** 纯函数：合并 bbox 并集（空 ⇒ undefined） */
export function unionBBox(boxes: readonly BBox[]): BBox | undefined {
  if (boxes.length === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return undefined;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// ─────────────────────────────────────────────────────────────────────
//  ① AffectedSourceProjection
// ─────────────────────────────────────────────────────────────────────

export function computeAffectedSourceProjection(
  input: AffectedSourceProjectionInput
): AffectedSourceProjection {
  const { before, after, sidecar } = input;
  const beforeSnap = snapshot(before);
  const afterSnap = snapshot(after);
  const displacedRefs = input.displacedLines ?? [];
  // F3B-6.28 · D 第二步（决策二）：unit 成员行**全部**纳入受影响集合 ——
  //   它们都会被 flow 视觉行重新合成，即使文本没变，只要原算子留在原位就会与
  //   新 flow 行重复（l6 实测：文本未变 ⇒ diff 发现不了，Phase 1 因此漏掉它）。
  const unitMemberRefs = input.unitMemberLines ?? [];

  const unresolved: Array<{ blockId: string; lineId: string }> = [];
  const sourceless: AffectedSourceProjection["sourceless"] = [];
  const lines: AffectedSourceLine[] = [];

  // ── 无 source 归属的受影响段落（generated / OCR / user 编辑）──
  for (const paraKey of new Set([...beforeSnap.byPara.keys(), ...afterSnap.byPara.keys()])) {
    const b = beforeSnap.byPara.get(paraKey);
    const a = afterSnap.byPara.get(paraKey);
    if ((b?.text ?? "") === (a?.text ?? "")) continue;
    if ((b?.keys.length ?? 0) > 0 || (a?.keys.length ?? 0) > 0) continue;
    sourceless.push({
      textBoxId: a?.textBoxId ?? b!.textBoxId,
      paragraphId: a?.paragraphId ?? b!.paragraphId,
      mutation: classifyLineMutation(b?.text ?? "", a?.text ?? ""),
    });
  }

  // ── 受影响 source key：① source 归属文本变化，或 ② 行（段落）全文变化 ──
  const paraKeysOf = (snap: DocSnap, mapKey: string): string[] => {
    const out: string[] = [];
    for (const [paraKey, para] of snap.byPara) if (para.keys.includes(mapKey)) out.push(paraKey);
    return out;
  };

  const orderedKeys: string[] = [];
  for (const mapKey of [...beforeSnap.byKey.keys(), ...afterSnap.byKey.keys()]) {
    if (!orderedKeys.includes(mapKey)) orderedKeys.push(mapKey);
  }

  for (const mapKey of orderedKeys) {
    const b = beforeSnap.byKey.get(mapKey);
    const a = afterSnap.byKey.get(mapKey);

    // F3B-6.28 · D 第一阶段：位移行（文本与段落归属均未变，diff 发现不了）由调用方
    //   显式声明 ⇒ 必须纳入受影响集合，否则其旧位置原算子不会被剥离。
    const displacedRef = displacedRefs.find((d) => {
      const bid = d.blockId;
      const lid = d.lineId;
      return (a && a.blockId === bid && a.lineId === lid) || (b && b.blockId === bid && b.lineId === lid);
    });
    // F3B-6.28 · D 第二步（决策二）：unit 成员行同理（整行将被 flow 重绘）。
    const memberRef = unitMemberRefs.find((d) => {
      const bid = d.blockId;
      const lid = d.lineId;
      return (a && a.blockId === bid && a.lineId === lid) || (b && b.blockId === bid && b.lineId === lid);
    });
    const blockId = a?.blockId ?? b!.blockId;
    const lineId = a?.lineId ?? b!.lineId;
    const displaced = !!displacedRef;
    const unitMember = !!memberRef;
    // 提交时登记的 Core 段落身份（成员行权威匹配键；位移行当前不登记）
    const registered: CoreParagraphIdentity | null = memberRef?.coreIdentity ?? null;
    // ⚠️ 身份校验：登记了却在 after 文档中找不到该段落 ⇒ 计划与当前文档不同代次
    //   （或段落已被合并删除）⇒ **显式失败**（unresolved），绝不静默跳过。
    let registeredParaKey: string | null = null;
    if (registered) {
      registeredParaKey = `${registered.textBoxId}|${registered.paragraphId}`;
      if (!afterSnap.byPara.has(registeredParaKey)) {
        unresolved.push({ blockId, lineId });
        continue;
      }
    }

    // 该 source key 在 before/after 中**所属段落**（按 paragraphId 稳定排序）。
    // 替换后 source run 变成 generated ⇒ after 侧可能不再拥有该 key，
    // 因此必须把 before 的所属段落一并纳入，才能拿到「新文本」做 diff。
    // F3B-6.28 · D 身份修复：登记的 Core 段落同样纳入 after 侧集合 ——
    //   整行替换后 source key 从 after 消失，但该段落仍持有编辑后的新文本，
    //   只有把它纳入才能算对 `paragraphTextChanged` / diff 区间。
    const touched = [
      ...new Set([
        ...paraKeysOf(beforeSnap, mapKey),
        ...paraKeysOf(afterSnap, mapKey),
        ...(registeredParaKey ? [registeredParaKey] : []),
      ]),
    ].sort();
    const beforeLineText = touched.map((k) => beforeSnap.byPara.get(k)?.text ?? "").join("");
    const afterLineText = touched.map((k) => afterSnap.byPara.get(k)?.text ?? "").join("");

    const paragraphTextChanged = beforeLineText !== afterLineText;
    const sourceTextChanged = (b?.sourceText ?? "") !== (a?.sourceText ?? "");
    // ⚠️ **结构变化**（段落拆分/合并：文本未变但所属段落集合变了）也必须算受影响：
    //   split 后原行不再是同一条视觉行（会被重绘到新位置），若不剥离原算子，
    //   原位置的旧文字会残留。此时 `replacedGlyphIndexes` 为 []（未替换任何原 glyph），
    //   因此 range 粒度**不会**凭空产生算子，只有 line 粒度（整行重绘）才全量剥离。
    const structureChanged =
      paraKeysOf(beforeSnap, mapKey).join(",") !== paraKeysOf(afterSnap, mapKey).join(",");
    if (
      !sourceTextChanged &&
      !paragraphTextChanged &&
      !structureChanged &&
      !displaced &&
      !unitMember
    ) {
      continue;
    }

    // 该行所属段落是否整体消失（merge / 删除行）
    const lineDisappeared =
      touched.length > 0 && touched.every((k) => !afterSnap.byPara.has(k)) && !a;

    if (!sidecar) {
      unresolved.push({ blockId, lineId });
      continue;
    }
    const binding = lookupLineBinding(sidecar, blockId, lineId);
    if (!binding) {
      unresolved.push({ blockId, lineId });
      continue;
    }

    // 不给 range ⇒ 该行**完整**原始序列（含 split alias 解析，6.10A 语义）
    const glyphs = lookupGlyphRange(sidecar, blockId, lineId);
    if (glyphs.length === 0) {
      unresolved.push({ blockId, lineId });
      continue;
    }

    const provenanceUnknownGlyphCount = glyphs.filter(
      (g) => !g.operatorId && (g.originalChar ?? "").trim() !== ""
    ).length;

    const operatorIds: string[] = [];
    const operatorCharIndexes: Array<number | undefined> = [];
    for (const g of glyphs) {
      if (!g.operatorId) continue;
      if (operatorIds.includes(g.operatorId)) continue;
      operatorIds.push(g.operatorId);
      operatorCharIndexes.push(g.operatorCharIndex);
    }

    // 被替换/删除的原 glyph（纯插入 ⇒ 空）
    const utf16Range = paragraphTextChanged
      ? diffRange(beforeLineText, afterLineText)
      : { start: 0, end: 0 };
    let replacedGlyphIndexes: number[] = [];
    let replacedGlyphCoverage: AffectedCoverage = "KNOWN";
    if (paragraphTextChanged) {
      const mapped = glyphPositionsForUtf16Range(glyphs, utf16Range);
      if (mapped === null) {
        replacedGlyphCoverage = "UNKNOWN";
        replacedGlyphIndexes = [];
      } else {
        replacedGlyphIndexes = mapped;
      }
    }

    const touchedParas = touched
      .map((k) => beforeSnap.byPara.get(k) ?? afterSnap.byPara.get(k))
      .filter((p): p is ParaAgg => !!p);
    const coreIdentity = {
      // F3B-6.28 · D 身份修复：有登记身份时，textBoxId 取**登记值**（与 after 文档
      //   同源 ⇒ bridge 查询 `(textBoxId, paragraphId)` 必中）；否则维持快照口径。
      textBoxId: registered?.textBoxId ?? touchedParas[0]?.textBoxId ?? "",
      paragraphIds: [
        ...new Set([
          ...(registered ? [registered.paragraphId] : []),
          ...touchedParas.map((p) => p.paragraphId),
        ]),
      ],
      // 位置键：touched 里同时含 before/after 的所属段落 ⇒ 其位置即 after 侧同一段落的位置
      positions: [...new Set(touchedParas.map((p) => p.position))],
      registered,
    };

    lines.push({
      blockId,
      lineId,
      lineIdx: binding.lineIdx ?? -1,
      coreIdentity,
      mutation: lineDisappeared
        ? "disappeared"
        : displaced
          ? "displaced"
          : unitMember
            ? "unit-member"
            : classifyLineMutation(beforeLineText, afterLineText),
      originalGlyphRange: [glyphs[0].index, glyphs[glyphs.length - 1].index],
      originalGlyphCount: glyphs.length,
      provenanceUnknownGlyphCount,
      sourceBBoxes: glyphs.map((g) => g.sourceBBox),
      operatorIds,
      operatorCharIndexes,
      operatorIdByGlyphPosition: glyphs.map((g) => g.operatorId),
      replacedGlyphIndexes,
      replacedUtf16Range: paragraphTextChanged ? utf16Range : null,
      replacedGlyphCoverage,
      paragraphTextChanged,
    });
  }

  // ── F3B-6.28 · D 第一阶段/第二步：显式失败纪律 ─────────────────────────
  //   调用方声明的 displaced 行 / unit 成员行若没能进入投影（不在 before/after 快照中
  //   ⇒ 它既不是当前文档的行，也无法定位原算子），必须记入 unresolved ——
  //   **绝不静默跳过**，否则旧位置文字残留而无人知晓（用户验收标准「投影完整性」）。
  for (const ref of [...displacedRefs, ...unitMemberRefs]) {
    const key = `${ref.blockId}|${ref.lineId}`;
    const covered =
      lines.some((l) => `${l.blockId}|${l.lineId}` === key) ||
      unresolved.some((u) => `${u.blockId}|${u.lineId}` === key);
    if (!covered) unresolved.push({ blockId: ref.blockId, lineId: ref.lineId });
  }

  // ── coverage ────────────────────────────────────────────────────────
  let coverage: AffectedCoverage;
  const affectedSomething = lines.length > 0 || unresolved.length > 0 || sourceless.length > 0;
  if (!sidecar) {
    coverage = "UNKNOWN";
  } else if (!affectedSomething) {
    coverage = "KNOWN"; // 无受影响内容：可确定「无需 drop」
  } else if (lines.length === 0) {
    coverage = "UNKNOWN"; // 有受影响内容但**全部**无法回溯
  } else if (
    unresolved.length > 0 ||
    sourceless.length > 0 ||
    lines.some((l) => l.provenanceUnknownGlyphCount > 0 || l.replacedGlyphCoverage === "UNKNOWN")
  ) {
    coverage = "PARTIAL";
  } else {
    coverage = "KNOWN";
  }

  return {
    coverage,
    lines,
    unresolved,
    sourceless,
    commandType: input.command?.type ?? null,
    changed: input.result?.changed ?? null,
    sidecarGeneration: sidecar?.generation ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  ② ExportDropOperatorProjection
// ─────────────────────────────────────────────────────────────────────

export interface ExportDropOptions {
  /**
   * 重绘粒度（默认 `"line"` = 当前 Core 现实：编辑行整行重绘 ⇒ 丢弃该行全部原算子）。
   * `"range"` = char 粒度模型：只丢弃被替换/删除子区间的原算子。
   */
  redrawGranularity?: "line" | "range";
}

export function projectExportDrop(
  projection: AffectedSourceProjection,
  options: ExportDropOptions = {}
): ExportDropOperatorProjection {
  const redrawGranularity = options.redrawGranularity ?? "line";
  const empty: ExportDropOperatorProjection = {
    coverage: projection.coverage,
    failClosed: true,
    partial: false,
    redrawGranularity,
    droppedOperatorIds: [],
    editedOriginalBounds: [],
    lines: [],
  };
  // UNKNOWN ⇒ 什么都不输出（绝不猜、绝不扩大范围）
  if (projection.coverage === "UNKNOWN") return empty;

  const outLines: ExportDropOperatorProjection["lines"] = [];
  const allIds: string[] = [];
  const allBounds: BBox[] = [];

  for (const line of projection.lines) {
    let ids: string[];
    let indexes: number[];
    if (redrawGranularity === "line") {
      ids = [...line.operatorIds];
      indexes = line.sourceBBoxes.map((_, i) => i);
    } else {
      indexes = line.replacedGlyphCoverage === "UNKNOWN" ? [] : [...line.replacedGlyphIndexes];
      const set = new Set(indexes);
      ids = [];
      // 顺序 = Sidecar glyph 顺序（与 `"line"` 粒度同一顺序口径）
      for (let i = 0; i < line.operatorIdByGlyphPosition.length; i++) {
        if (!set.has(i)) continue;
        const glyphId = line.operatorIdByGlyphPosition[i];
        if (glyphId && !ids.includes(glyphId)) ids.push(glyphId);
      }
    }
    const bounds =
      redrawGranularity === "line"
        ? line.sourceBBoxes
        : indexes.map((i) => line.sourceBBoxes[i]).filter((b): b is BBox => !!b);
    const merged = unionBBox(bounds);
    const lineBounds = merged ? [merged] : [];
    outLines.push({
      blockId: line.blockId,
      lineId: line.lineId,
      coreIdentity: line.coreIdentity,
      droppedOperatorIds: ids,
      editedOriginalBounds: lineBounds,
    });
    for (const id of ids) if (!allIds.includes(id)) allIds.push(id);
    for (const b of lineBounds) allBounds.push(b);
  }

  return {
    coverage: projection.coverage,
    // ★ 用户冻结规则：只有 **KNOWN** 才可被消费方当作「完整答案」；
    //   PARTIAL 仍然输出**已知部分**，但必须 failClosed=true（调用方不得假定已完整剥离）。
    failClosed: projection.coverage !== "KNOWN",
    partial: projection.coverage === "PARTIAL",
    redrawGranularity,
    droppedOperatorIds: allIds,
    editedOriginalBounds: allBounds,
    lines: outLines,
  };
}

/**
 * `AffectedSourceLine` 中第 `position` 个原 glyph 的 operatorId。
 *
 * ⚠️ `line.operatorIds` 是**去重后**的算子集合，与 glyph 序列不平行；
 * 位置 → 算子的映射由 `operatorIdByGlyphPosition` 承担。
 */
