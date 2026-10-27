/**
 * editor/binding/core-input-source.ts — EDITOR-CORE-012-C（Phase C1–C5 / C7）
 *
 * 把「DOM 输入」接到 Editor Core 的**唯一编排**：
 *
 *     beforeinput / keydown / IME / paste
 *              ↓ beforeInputToInputEvent()（纯函数，DOM-free）
 *          InputEvent（CORE-008 的归一化形态）
 *              ↓ runLiveReflow(history, event, { adapter, textBoxId, metrics })   ← CORE-009
 *          EditorHistory.commit → EditorDocument mutation
 *              ↓ 同一周期内
 *          TextLayout + CaretGeometry + SelectionGeometry
 *              ↓ renderFrameFromLiveReflow()                                        ← CORE-010-B
 *          EditorRenderFrame
 *
 * ── 本层的三条硬边界 ───────────────────────────────────────────────
 * 1. **不反写 legacy**：`legacyMutation` 恒为 `false`。Core 输入只改 `EditorHistory`
 *    持有的 `EditorDocument`；`editableDocumentRef` / `Segment` / `docBlocks` 一行都不碰。
 *    （"编辑真相迁移"是 012-C 之后的 013；012-C 只建立**第一条真正闭环的 Core 编辑路径**。）
 * 2. **排他性**：`dispatchBeforeInput` 是唯一的输入派发点，它**保证**同一次 DOM 输入
 *    只会交给 Core **或** legacy 之一。绝不出现两边都处理 → 双重插入（"A" → "AA"）。
 * 3. **不预测 caret**：位置一律由 CORE-009 在**结果文档**上重新定位（CORE-008 的职责切分）。
 *
 * ── 与 012-A 的关系（重要）────────────────────────────────────────
 * | 维度 | 012-A（Render） | 012-C（Input） |
 * |---|---|---|
 * | 真相 | legacy `EditableDocument`（派生 Core 只读快照） | Core `EditorDocument`（`EditorHistory` 持有） |
 * | 方向 | legacy → Core | DOM → Core |
 * | 开关 | `window.__coreRender` | `window.__coreInput` |
 * 两者**互相独立**：012-C 不要求 `__coreRender` 打开，也不改 012-A 的渲染源选择。
 * 但两者同时打开时存在「Core 编辑后、页面 glyph 仍来自 legacy」的一致性问题，
 * 该问题已在 `docs/editor-core-012c-input-audit.md` 显式记录并留待接线轮决策。
 *
 * ── 依赖边界（规范 §57）────────────────────────────────────────────
 * 允许 import：`../core/{input,history,layout,render,position,document}`、`../legacy`、
 *              `./canonical-selection`（F3B-6.19-C：caret 身份链复用同一 hierarchy 实现）、
 *              `../../document-model/types`。
 * 禁止 import：React / DOM / `editor-engine` / 旧 renderer 实现 / `useExport`。
 * （本文件对 `string` 形态的 DOM 事件做归一化，**不接触** `InputEvent` DOM 对象。）
 */

import type { EditorCommand } from "../core/commands";
import type { CommandType } from "../core/commands/types";
import type { EditorDocument } from "../core/document";
import { EditorHistory, type EditorHistoryState } from "../core/history";
import type { Caret, EditorSelection, TextPosition } from "../core/position";
import {
  createCaret,
  createCollapsedSelection,
  createSelection,
  createTextPosition,
  getRunStartOffsetInParagraph,
  paragraphOffsetToPosition,
  positionToParagraphOffset,
} from "../core/position";
import { createFontMetricsProvider, layoutTextBox, runLiveReflow } from "../core/layout";
import type {
  CaretGeometry,
  CaretResolution,
  FontMetricsProvider,
  SelectionGeometry,
  TextLayout,
} from "../core/layout";
import { buildRenderFrame, renderFrameFromLiveReflow } from "../core/render";
import type { EditorRenderFrame } from "../core/render";
import {
  createInputAdapter,
  type CompositionState,
  type InputAdapter,
  type InputAdapterOptions,
  type InputEvent,
} from "../core/input";
import type { EditableDocument } from "../../document-model/types";
import { editableDocumentToEditorDocument } from "../legacy";
import { createLegacyLineMetrics } from "./pdf-metrics";
// F3B-6.19-C（C2）：caret seeding 必须复用 **canonical 身份链**（不再是文本匹配）
import { canonicalToCoreTarget } from "./canonical-selection";
// IB-2-F6：paragraph offset → Core target（run 由 offset 推导，不依赖唯一 run）
import {
  paragraphOffsetToCaretTarget,
  paragraphOffsetToCoreTarget,
} from "./paragraph-offset-core-target";

/**
 * 生产开关名。
 *
 * F3B-6.19-E 起契约变更：**缺省 ON**（Core selection/caret presentation = production default）；
 * 只有显式 `window.__coreInput === false` 才回退 legacy（emergency rollback）。
 */
export const CORE_INPUT_FLAG = "__coreInput";

/** 输入路由（C7：二者互斥，绝不并存） */
export type InputRoute = "core" | "legacy";

/**
 * 读取生产开关。
 *
 * ── F3B-6.19-E 通过后的新默认（本轮启用）──────────────────────────────
 *
 *     ON  是 production default（Core 接管**已建模**的 DOM 输入 + selection/caret presentation）
 *     OFF 是 emergency rollback（**只有显式 `=== false` 才关闭**）
 *
 * ```text
 * __coreInput === false  ⇒ Legacy 输入 / presentation（rollback）
 * otherwise（缺省 / true / 其它） ⇒ Core 输入 / presentation
 * ```
 *
 * 与 `readCoreRenderFlag` / `readCoreTextEditInputFlag` 同契约
 * （default ON + explicit-false rollback）。SSR / 无宿主时返回 false（保守）。
 *
 * ⚠️ 安全边界（为什么开启默认不会改变"看得见的文本"）：
 *   · 未建模输入（方向键 / Home·End / 词删…）一律交回 legacy
 *     （`dispatchBeforeInput` 的 `unsupported-input-type` 分支）；
 *   · DOM 文本只有在「`enabled` ∧ **正在编辑** ∧ 该 segment **已被 Core session 接管**」
 *     三者同时成立时才让位（`isDomTextSuppressed`）⇒ 仅开启本开关**不会**让任何文本消失。
 */
export function readCoreInputFlag(scope?: { [CORE_INPUT_FLAG]?: unknown }): boolean {
  const target = scope ?? (typeof window !== "undefined" ? (window as unknown as object) : undefined);
  if (!target) return false;
  return (target as Record<string, unknown>)[CORE_INPUT_FLAG] !== false;
}

// ─────────────────────────────────────────────────────────────────────
//  DOM 事件 → Core InputEvent（纯函数；C5 的 P0 集合，不外扩）
// ─────────────────────────────────────────────────────────────────────

/**
 * `beforeinput` → `InputEvent`。
 *
 * 只映射 C5 的 P0 集合；其余 `inputType` 返回 `null`（**不猜**、不降级成插入）。
 * 返回 `null` 时调用方应把该事件交给 legacy —— 这条也由 `dispatchBeforeInput` 统一保证。
 */
export function beforeInputToInputEvent(
  inputType: string,
  data?: string | null
): InputEvent | null {
  switch (inputType) {
    case "insertText":
    case "insertReplacementText":
      return data === null || data === undefined ? null : { type: "text", text: data };
    case "insertFromPaste":
    case "insertFromPasteAsQuotation":
      return typeof data === "string" ? { type: "paste", text: data } : null;
    case "deleteContentBackward":
      return { type: "keydown", key: "Backspace" };
    case "deleteContentForward":
      return { type: "keydown", key: "Delete" };
    /**
     * ★ F3B-6.21-F2（E-C5-2）：词级删除**建模**。
     *
     *   ⚠️ 关键语义：**浏览器只提供 intent，不提供区间**。
     *   `deleteWordBackward` 不带任何 `[start,end)`；区间由 **Core 自己的
     *   word boundary resolver**（`core/input/word-boundary.ts`，依
     *   `docs/Word-Boundary-Design.md`）在**段落级 UTF-16** 上算出
     *   ⇒ 本仓库的 Word 语义与 Chromium 的 ICU 分词**解耦**
     *   （F1 §8 实测：Chromium 对 `你好世界` 只删 `世界`，而本契约删整段）。
     *
     *   以 `ctrlKey: true` 进入既有 `keydown` 通道 ⇒ `resolveKeyAction` 产出
     *   `unit: "word"` ⇒ `commandsForAction` 走 `wordRangeInDocument`。
     *   （不新增 InputEvent 形态 —— 复用既有「唯一入口」，避免第三条路径。）
     */
    case "deleteWordBackward":
      return { type: "keydown", key: "Backspace", ctrlKey: true };
    case "deleteWordForward":
      return { type: "keydown", key: "Delete", ctrlKey: true };
    case "insertParagraph":
    case "insertLineBreak":
      return { type: "keydown", key: "Enter" };
    /**
     * ★ F3B-6.21-H1-B：文本样式切换**建模**（bold/italic/underline/strike）。
     *
     * 只携带 `format` 意图；toggle 解析（读 Core selection 当前 style → 翻转）由
     * `InputAdapter.handle` → `resolveTextStyleToggle` 在 Core document 上完成，
     * **不**在此处携带最终 style、也**不**读 DOM（约束：selection 只来自 Core session）。
     * 对应 `beforeinput` 的 `formatBold / formatItalic / formatUnderline / formatStrikeThrough`。
     */
    case "formatBold":
      return { type: "set-text-style", format: "bold" };
    case "formatItalic":
      return { type: "set-text-style", format: "italic" };
    case "formatUnderline":
      return { type: "set-text-style", format: "underline" };
    case "formatStrikeThrough":
      return { type: "set-text-style", format: "strike" };
    default:
      // 明确未建模：historyUndo/Redo、insertCompositionText 等
      return null;
  }
}

/**
 * `composition*` → `InputEvent`。
 *
 * F3B-6.21-E（D1）：增加 **`"cancel"`** phase —— 补齐既有契约
 * （`core/input/types.ts:73` 早已定义 `{type:"compositionCancel"}` 且 `InputAdapter` 已按状态型输入处理它），
 * 此前只缺一条映射入口。**接线层不得绕过本函数直接调 `CompositionTracker.cancel()`**。
 *
 * ⚠️ 浏览器实测（F3B-6.21-D1 Addendum D1.3）：cancel **没有**独立 `inputType`，
 *    其可观测形态是「`compositionend` 且 `data` 为空」⇒ 接线层据此分流到 `"cancel"`，
 *    而**不要**表示成 `compositionEnd("")`（那会与「正常但为空的 commit」混淆）。
 */
export function compositionToInputEvent(
  phase: "start" | "update" | "end" | "cancel",
  data = ""
): InputEvent {
  if (phase === "start") return { type: "compositionStart" };
  if (phase === "update") return { type: "compositionUpdate", text: data };
  if (phase === "cancel") return { type: "compositionCancel" };
  return { type: "compositionEnd", text: data };
}

// ─────────────────────────────────────────────────────────────────────
//  Session（C2：Core 编辑状态从 legacy 引导一次，之后由 EditorHistory 拥有）
// ─────────────────────────────────────────────────────────────────────

export interface CoreInputSessionOptions {
  /** 要编辑的 TextBox；缺省取文档中第一个有文本的 TextBox */
  textBoxId?: string;
  /** 初始选区（缺省：文档起点折叠） */
  initialSelection?: EditorSelection;
  /** 初始插入点（缺省：`initialSelection.focus`） */
  initialCaret?: Caret;
  /**
   * 度量提供者。缺省 = Core 兜底估算（advanceSource 会如实标成 `"canvas"`）。
   *
   * ⚠️ 012-C **不承诺编辑后的 advance 保真**：新插入的字符本来就没有 PDF 度量。
   * 需要保真时由调用方注入（例如 012-A 的 legacy-line L2 provider）。
   * 之所以不默认复用 legacy-line L2：编辑会移动 `textIndex`，逐 glyph 查表会错位，
   * 反而制造**更难发现的错误度量**。默认兜底是"如实粗略"而非"看似精确的错误"。
   */
  metrics?: FontMetricsProvider;
  adapterOptions?: InputAdapterOptions;
}

export interface CoreInputSession {
  /** Core 编辑状态的唯一持有者（document + selection + caret） */
  readonly history: EditorHistory;
  /** 持有 IME 组合状态 —— 必须 session 级复用，不能每次新建（CORE-009 契约） */
  readonly adapter: InputAdapter;
  readonly textBoxId: string;
  readonly metrics: FontMetricsProvider;
}

export type CoreInputSessionOutcome =
  | { ok: true; session: CoreInputSession; warnings: string[] }
  | { ok: false; reason: string; warnings: string[] };

/**
 * 用**已有**的 Core `EditorDocument` 创建输入 session（F3B-1 主路径）。
 *
 * 与旧 `createCoreInputSession(legacy)` 的关键区别：
 *   · **不再**经 `editableDocumentToEditorDocument()` 重新转换 —— 文档以引用形式进入 `EditorHistory`，
 *     因此 session 的编辑直接修改"唯一的 Core 文档"，且 `documentOf(session)` 与传入的 `document`
 *     是**同一对象**（满足 T28/T29「同一 document identity」，绝不出现 import→A / input→B / export→C）。
 *   · `document` 由 import-time 的 `initializeCoreDocument()` 创建并持久化在 `coreDocumentRef`，
 *     session 只是"使用"它，而非"拥有"它。
 *
 * @param extraWarnings 仅 legacy 分支（适配器 warnings）透传用，主路径传空即可。
 */
export function createCoreInputSessionFromDocument(
  document: EditorDocument,
  options: CoreInputSessionOptions = {},
  extraWarnings: readonly string[] = []
): CoreInputSessionOutcome {
  const warnings = [...extraWarnings];
  const start = options.initialSelection?.range.focus ?? documentStartPosition(document);
  if (!start) {
    return { ok: false, reason: "no-text-target: 文档中没有可编辑的文本（无 TextBox/Paragraph/Run）", warnings };
  }

  const textBoxId = options.textBoxId ?? start.textBoxId;
  const box = document.pages.flatMap((p) => p.objects).find((o) => o.id === textBoxId);
  if (!box) {
    return { ok: false, reason: `text-box-not-found: ${textBoxId}`, warnings };
  }

  const selection = options.initialSelection ?? createCollapsedSelection(start);
  const caret = options.initialCaret ?? createCaret(selection.range.focus);
  const history = new EditorHistory({ document, selection, caret });

  return {
    ok: true,
    warnings,
    session: {
      history,
      adapter: createInputAdapter(options.adapterOptions),
      textBoxId,
      metrics: options.metrics ?? createFontMetricsProvider({}),
    },
  };
}

/**
 * 用既有的 legacy `EditableDocument` 引导一个 Core 输入 session。
 *
 * ⚠️ F3B-1 起，这是**遗留/兼容分支**：生产路径应直接使用
 * `createCoreInputSessionFromDocument(coreDocumentRef.current, ...)`（消费 import-time 已创建的
 * 唯一 Core 文档），避免每次输入都重新 adapter 一次 legacy doc。
 *
 * 粒度固定 `visual-line`（与 012-A 渲染源一致）：1 视觉行 = 1 TextBox = 1 Paragraph。
 */
export function createCoreInputSession(
  legacy: EditableDocument,
  options: CoreInputSessionOptions = {}
): CoreInputSessionOutcome {
  const warnings: string[] = [];
  let imported;
  try {
    imported = editableDocumentToEditorDocument(legacy, { layoutGranularity: "visual-line" });
  } catch (error) {
    return { ok: false, reason: `import-failed: ${describe(error)}`, warnings };
  }
  warnings.push(...imported.warnings);
  return createCoreInputSessionFromDocument(imported.document, options, warnings);
}

/** 会话当前文档（Core 编辑真相） */
export function documentOf(session: CoreInputSession): EditorDocument {
  return session.history.state.document;
}

/**
 * F3B-6.21-F2（与 E-C5-1 的 D6 同源）：Core caret 的**段落内 UTF-16 偏移**。
 *
 * 用途：词删后把 **DOM caret** 移到删除后的位置。
 *   · DOM 文本**不**随 Core 变化（守卫 T6a 禁止 Core → DOM 文本投影）；
 *   · 因此 `preventDefault()` 之后 DOM caret 仍停在**旧** offset，
 *     若不纠正，下一次输入会从错误位置播种。
 *   · 这里用 **Core 自己的 caret 位移量**（同一段落内的 UTF-16 delta）反推 DOM offset，
 *     而不是复制一份「段落 ↔ DOM」映射 ⇒ 不引入第二套坐标换算。
 *
 * 返回 `null` ⇒ 无法判定（调用方**不得**猜，放弃对账即可 —— fail-open）。
 */
export function coreCaretParagraphOffset(
  session: CoreInputSession | null | undefined,
  caret: Caret | null | undefined
): number | null {
  if (!session || !caret) return null;
  try {
    return positionToParagraphOffset(documentOf(session), caret.position);
  } catch {
    return null;
  }
}

/** 会话当前 IME 组合状态（只读） */
export function compositionStateOf(session: CoreInputSession): CompositionState {
  return session.adapter.compositionState;
}

/**
 * **C2（F3B-6.19-C）· DOM caret → Core 插入点的「身份解析」= primary 路径。**
 *
 *     (blockId, lineId)   = **身份**
 *     offsetUtf16         = **位置**（行文本的 UTF-16 半开区间口径）
 *                ↓  复用 canonical 身份链（**唯一** hierarchy 实现）
 *     Core TextBox / Paragraph / Run + run-local offset
 *                ↓
 *     { caret, selection }（折叠）
 *
 * ── 为什么必须走身份（真实缺陷证据：F3B-6.19-B）────────────────────
 * B1 实测：`CanonicalSelection → canonicalToCoreTarget` 在**重复行**（两行都是 "HELLO"）
 * 下仍**唯一**命中第二行（`(blockId,lineId)` 与文本无关）。
 * B2 实测：文本匹配的 caret seeding 会**选错行** ——
 * 用户在 Line B 输入 `Z`，字符被写进 Line A（`["HELLO","HELLO",…]` → `["HEZLLO",…]`）。
 * ⇒ **内容匹配 ≠ 身份匹配**，caret 必须复用同一套身份规则。
 *
 * ── fail-closed ───────────────────────────────────────────────────
 * 身份缺失 / 未命中 / 越界 ⇒ 返回 `null`（调用方保持当前插入点，**不猜**）。
 * 调用方在本函数返回 null 时，**可以**显式回退到
 * {@link coreCaretForSegment}（Legacy 兼容回退），但不得把它当 primary。
 */
export function coreCaretForBinding(
  document: EditorDocument,
  binding: { readonly blockId: string; readonly lineId: string },
  offsetUtf16: number,
  /** ★ IB-2-B：segment 在 paragraph 内的 UTF-16 起点 base（多段行时 > 0）。单段行传 0 / 省略。 */
  segmentStartUtf16 = 0
): CoreInputHandleOptions | null {
  if (!binding.blockId || !binding.lineId) return null;
  // ★ IB-2-B：segment-local → paragraph-relative（唯一换算点：调用方提供 base）
  const offset = (Number.isFinite(offsetUtf16) ? Math.max(0, Math.trunc(offsetUtf16)) : 0) + segmentStartUtf16;
  const resolved = canonicalToCoreTarget(
    {
      blockId: binding.blockId,
      lineId: binding.lineId,
      startOffsetUtf16: offset,
      endOffsetUtf16: offset,
    },
    document
  );
  if (!resolved.ok) return null;
  const t = resolved.target;
  try {
    // `canonicalToCoreTarget` 已给出 **run-local** offset（`TextPosition.offset` 同口径）
    const position = createTextPosition(t.textBoxId, t.paragraphId, t.runId, t.startOffsetUtf16);
    return { selection: createCollapsedSelection(position), caret: createCaret(position) };
  } catch {
    return null;
  }
}

/**
 * **最小 DOM caret → Core 插入点映射**（C6 接线所需）。
 *
 * ⚠️ **F3B-6.19-C 起降级为「Legacy 兼容回退」**，**不是** primary identity resolver。
 *    primary = {@link coreCaretForBinding}（`(blockId,lineId)` + UTF-16 位置）。
 *    本函数只在 segment **缺 provenance**（无 `source.blockId/lineId`）时被调用。
 *    保留其既有行为（有回归测试钉住），不改变语义。
 *
 * ⚠️ 它**不是** C5 排除的"DOM selection → Core selection 完整替换"：
 *   · 只做「一个段内、折叠插入点、按文本匹配定位」这一件事
 *   · 不做 range / 跨段 / 方向键 / Home/End / 词删 等未建模输入
 *   · 返回 `null` 表示**定位失败** → 调用方应保持 session 当前插入点（不猜）
 *
 * 定位方式：把 `segmentText` 与某个段落的**整段文本**做全等匹配（视觉行粒度下
 * 1 个 TextBox = 1 段落 = 1 段文本），再按 `domOffset` 收窄到段落偏移。
 * 用 `paragraphOffsetToPosition` 而不是直接构造 TextPosition —— 因为
 * `TextPosition.offset` 是 **run-local**，段落偏移必须换算（012-C 实测结论）。
 *
 * ⚠️ **已知歧义（B2 实证）**：匹配返回**第一个**全等段落 ⇒ 重复行文档会选错行。
 *    因此**禁止**在 Core caret 主路径中使用本函数。
 */
export function coreCaretForSegment(
  session: CoreInputSession,
  segmentText: string,
  domOffset: number
): CoreInputHandleOptions | null {
  const document = session.history.state.document;
  const target = textBoxForText(document, segmentText);
  if (!target) return null;
  const offset = Math.max(0, Math.min(Math.trunc(domOffset), target.text.length));
  try {
    const position = paragraphOffsetToPosition(document, target.paragraphId, offset);
    return { selection: createCollapsedSelection(position), caret: createCaret(position) };
  } catch {
    return null;
  }
}

/**
 * **F3B-6.21-H1-B· DOM 非折叠选区 → Core range 选区的「身份解析」= primary 路径。**
 *
 * 与 {@link coreCaretForBinding} 同源：用 `(blockId, lineId) + UTF-16 偏移` 经
 * canonical 身份链解析成 Core TextBox / Paragraph / Run + run-local offset，再构造
 * **非折叠**的 `TextRange`（anchor = start、focus = end）。
 *
 * ── 用途 ────────────────────────────────────────────────────────────
 * `beforeinput(format*)` / `onSelectionChange` 在「段内存在非折叠 DOM 选区」时，
 * 需要把该 range 同步进 Core session，使 `resolveTextStyleToggle` 能读到真正的 range
 * （约束 #1：selection 只来自 Core session，本函数只是把 DOM range **播种**进 session，
 *   command 解析**不**再读 DOM）。
 *
 * ── 与 caret 路径的区别 ────────────────────────────────────────────
 * `coreCaretForBinding` 只处理折叠（单 offset）；本函数处理 `end > start` 的 range。
 * 退化折叠（`end <= start`）⇒ 返回 `null`（调用方回退到 caret 路径，**不得**认领为 range）。
 *
 * ── fail-closed ───────────────────────────────────────────────────
 * 身份缺失 / 未命中 / 越界 / 起点终点落在不同段落 ⇒ 返回 `null`（调用方**不猜**）。
 *   （视觉行粒度下 1 段 = 1 段落，段内 range 一定同段落；跨段落属于未建模，交由
 *    `resolveTextStyleToggle` 的 cross-paragraph fail-closed 兜底。）
 */
export function coreRangeForBinding(
  document: EditorDocument,
  binding: { readonly blockId: string; readonly lineId: string },
  startOffsetUtf16: number,
  endOffsetUtf16: number,
  /** ★ IB-2-B：segment 在 paragraph 内的 UTF-16 起点 base（多段行时 > 0）。单段行传 0 / 省略。 */
  segmentStartUtf16 = 0
): CoreInputHandleOptions | null {
  if (!binding.blockId || !binding.lineId) return null;
  // ★ IB-2-B：segment-local → paragraph-relative（唯一换算点：调用方提供 base）
  const base = segmentStartUtf16;
  const lo = Math.min(startOffsetUtf16, endOffsetUtf16) + base;
  const hi = Math.max(startOffsetUtf16, endOffsetUtf16) + base;
  const start = Number.isFinite(lo) ? Math.max(0, Math.trunc(lo)) : 0;
  const end = Number.isFinite(hi) ? Math.max(0, Math.trunc(hi)) : 0;
  if (end <= start) return null; // 退化折叠 ⇒ 不认领为 range（交给 caret 路径）
  const startResolved = canonicalToCoreTarget(
    {
      blockId: binding.blockId,
      lineId: binding.lineId,
      startOffsetUtf16: start,
      endOffsetUtf16: start,
    },
    document
  );
  const endResolved = canonicalToCoreTarget(
    {
      blockId: binding.blockId,
      lineId: binding.lineId,
      startOffsetUtf16: end,
      endOffsetUtf16: end,
    },
    document
  );
  if (!startResolved.ok || !endResolved.ok) return null;
  try {
    const anchor = createTextPosition(
      startResolved.target.textBoxId,
      startResolved.target.paragraphId,
      startResolved.target.runId,
      startResolved.target.startOffsetUtf16
    );
    const focus = createTextPosition(
      endResolved.target.textBoxId,
      endResolved.target.paragraphId,
      endResolved.target.runId,
      endResolved.target.startOffsetUtf16
    );
    return { selection: createSelection(anchor, focus), caret: createCaret(focus) };
  } catch {
    return null;
  }
}

/**
 * **IB-2-F6 · caret 播种的新路径：paragraphId + paragraph-relative offset。**
 *
 * 与 {@link coreCaretForBinding} 的差别（case 10 的根因）：
 *   旧路径先按 `run.source.(blockId,lineId)` **找唯一 run**，
 *   而 A 段被编辑后 paragraph 会拆成多个同 source 的 run ⇒ `multi-run` 拒绝
 *   ⇒ caret 播种失败 ⇒ Core 沿用陈旧 caret。
 *   本函数**不找 run**，直接由 paragraph offset 推导 run（§20 确定性规则），
 *   因此与 run 数量 / run 归属完全解耦。
 *
 * ⚠️ `paragraphId` **必须**来自当前可信的 Core session caret（表达「正在编辑哪一段」），
 *    绝不可由 `segment.source.blockId` 猜测（F6 硬边界：不猜 paragraphId）。
 */
export function coreCaretForSegmentParagraph(
  document: EditorDocument,
  paragraphId: string,
  offsetUtf16: number
): CoreInputHandleOptions | null {
  if (!paragraphId) return null;
  const resolved = paragraphOffsetToCaretTarget(document, paragraphId, offsetUtf16);
  if (!resolved.ok) return null;
  try {
    const position = resolved.target.anchor;
    return { selection: createCollapsedSelection(position), caret: createCaret(position) };
  } catch {
    return null;
  }
}

/** IB-2-F6：非折叠 range 版本（与 {@link coreRangeForBinding} 对应，同样不依赖唯一 run）。 */
export function coreRangeForSegmentParagraph(
  document: EditorDocument,
  paragraphId: string,
  startOffsetUtf16: number,
  endOffsetUtf16: number
): CoreInputHandleOptions | null {
  if (!paragraphId) return null;
  const lo = Math.min(startOffsetUtf16, endOffsetUtf16);
  const hi = Math.max(startOffsetUtf16, endOffsetUtf16);
  if (!(hi > lo)) return null; // 折叠 ⇒ 交给 caret 路径
  const resolved = paragraphOffsetToCoreTarget(document, paragraphId, lo, hi);
  if (!resolved.ok) return null;
  try {
    const { anchor, focus } = resolved.target;
    return { selection: createSelection(anchor, focus), caret: createCaret(focus) };
  } catch {
    return null;
  }
}

/** 整段文本与 `text` 全等的第一个段落（返回其 textBoxId / paragraphId / 文本） */
function textBoxForText(
  document: EditorDocument,
  text: string
): { textBoxId: string; paragraphId: string; text: string } | null {
  for (const page of document.pages) {
    for (const textBox of page.objects) {
      if (textBox.type !== "text") continue; // F3B-6.24-B3：图片对象无段落
      for (const paragraph of textBox.paragraphs) {
        const paragraphText = paragraph.runs.map((run) => run.text).join("");
        if (paragraphText === text) {
          return { textBoxId: textBox.id, paragraphId: paragraph.id, text: paragraphText };
        }
      }
    }
  }
  return null;
}

/** 文档起点（第一页 → 第一个 TextBox → 第一个 Paragraph → 第一个 Run → offset 0） */
export function documentStartPosition(document: EditorDocument): TextPosition | null {
  for (const page of document.pages) {
    for (const textBox of page.objects) {
      if (textBox.type !== "text") continue; // F3B-6.24-B3：图片对象无段落
      for (const paragraph of textBox.paragraphs) {
        const run = paragraph.runs[0];
        if (!run) continue;
        return createTextPosition(textBox.id, paragraph.id, run.id, 0);
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
//  C3（F3B-6.19-C）：Core presentation ownership / lifecycle contract
// ─────────────────────────────────────────────────────────────────────

/**
 * Core selection/caret **presentation** 的几何快照（唯一权威形态）。
 *
 * ⚠️ 与旧 `coreGeometryRef` 的本质区别：它**自带计算输入**
 * （`documentVersion` + `sourceCaret` / `sourceSelection` 的**引用**），
 * 因此「这份几何是否仍对应当前状态」**可被判定**。
 * 旧的裸几何无法回答"这是哪一次编辑产出的几何"（B3 实测缺陷的根源）。
 */
export interface CorePresentationState {
  /** 计算该几何时的 Core document version */
  readonly documentVersion: number;
  readonly caret: CaretGeometry | null;
  readonly selection: SelectionGeometry | null;
  /** 计算该几何时所用的 session 输入（**引用**比较用；`null` = 当时无 caret/selection） */
  readonly sourceCaret: Caret | null;
  readonly sourceSelection: EditorSelection | null;
  /**
   * F3B-6.21-A-Impl：派生该几何时的 **Core Session Revision** 令牌。
   *
   * 由调用方（PDFEditor）在包装 `corePresentationFor(...)` 时注入 —— 纯函数本身不持有 revision。
   *
   * ── 为什么除了上面三维还需要 revision 令牌 ──────────────────────────
   * `documentVersion` 只覆盖「**文档**变了」；而 edit-enter / segment-switch / caret seed /
   * selection change **都不改文档**，却必须让几何重算。旧实现靠 `useMemo` 的 dependency
   * 数组隐式保证这件事；一旦 dependency 丢失，三维判据可能**碰巧仍成立**
   * （document 没变、caret 引用没变）⇒ 复用 stale 几何。
   * 有了令牌，dependency 丢失 ⇒ 令牌失配 ⇒ **fail-closed**（回落非 Core 呈现），
   * 把「静默复用 stale 几何」变成「可观测的降级」。
   */
  readonly revision?: number;
}

/**
 * **统一刷新入口（唯一）**：由 session **当前**状态重算 presentation 几何。
 *
 *     session.history.state（document + selection + caret）
 *          ↓  layoutTextBox(document, textBoxId, metrics, { caret, selection })   ← CORE-006-B 同周期
 *     { caretGeometry, selectionGeometry }
 *
 * ── 为什么必须只有这一个入口（B3 实测）──────────────────────────────
 * presentation 的权威性来自「**它对应当前 document + 当前 selection/caret**」，
 * 而不是「某一次 mutation 顺手写了一份几何」。
 * 让 `beforeinput` / Toolbar / Capability / Segment **各自**去写几何，等于维护 N 份
 * 会互相漂移的快照 —— B3 实测：`coreGeometryRef` **只有一个写点**，
 * 于是 Toolbar / Capability / Segment 的 Core mutation 之后，presentation 仍被视为
 * "Core authoritative"，而它读到的是 `null` 或**陈旧几何** ⇒ legacy 选区高亮被静默吞掉。
 *
 * ⇒ 本函数是**纯函数**（不持有、不写入任何 ref）；调用方在**单一**信号
 *   （`coreInputTick`，所有 Core mutation 都会 bump）上重算即可 ——
 *   **不再需要、也不再允许**在任何 mutation 点写几何。
 */
export function corePresentationFor(session: CoreInputSession): CorePresentationState | null {
  const document = documentOf(session);
  const state = session.history.state;
  const caret = state.caret ?? null;
  const selection = state.selection ?? null;

  // ⚠️ F3B-6.19-D 缺陷修复：**必须按 caret / selection 各自所在的 TextBox 布局**，
  //    不能硬编码 `session.textBoxId`。
  //    原因：C2 把 caret seeding 换成**身份**路径后，caret 可以落在**任意** TextBox
  //    （例如用户点的是第二行 ⇒ caret 在第二个 TextBox），而 `session.textBoxId` 仍是
  //    创建 session 时的起点 TextBox（= 第一段）。在错误的 TextBox 布局里查 caret 段落
  //    必然查不到 ⇒ `caretGeometry = null` ⇒ CaretLayer 不可见
  //    （真实 UI 表现：在第二行输入时 caret 消失；首行则正常 —— 6.19-D 的 D5 实测）。
  const caretBoxId = caret?.position.textBoxId ?? selection?.range.focus.textBoxId ?? session.textBoxId;
  const selectionBoxId = selection?.range.focus.textBoxId ?? caretBoxId;

  try {
    if (caretBoxId === selectionBoxId) {
      const result = layoutTextBox(document, caretBoxId, session.metrics, {
        caret: caret ?? undefined,
        selection: selection ?? undefined,
      });
      return {
        documentVersion: document.version,
        caret: result.caretGeometry,
        selection: result.selectionGeometry,
        sourceCaret: caret,
        sourceSelection: selection,
      };
    }
    // caret 与 selection 位于不同 TextBox ⇒ 各自布局取几何（一次调用只能服务一个 TextBox）
    const caretResult = caret
      ? layoutTextBox(document, caretBoxId, session.metrics, { caret })
      : null;
    const selectionResult = selection
      ? layoutTextBox(document, selectionBoxId, session.metrics, { selection })
      : null;
    return {
      documentVersion: document.version,
      caret: caretResult?.caretGeometry ?? null,
      selection: selectionResult?.selectionGeometry ?? null,
      sourceCaret: caret,
      sourceSelection: selection,
    };
  } catch {
    return null;
  }
}

/**
 * presentation 是否**仍然对应当前** Core 状态 —— **fail-closed 判据**。
 *
 * 三个维度必须同时成立：
 *   ① `documentVersion` 相同（**document 变了而几何没重算 ⇒ 过期**）
 *   ② `sourceCaret` 与当前 session caret **同一引用**（caret 变了而几何没重算 ⇒ 过期）
 *   ③ `sourceSelection` 同上
 *
 * 任一不成立 ⇒ 调用方**必须不使用**该几何（回落到非 Core 的展示来源），
 * **绝不**复用 stale geometry。
 */
export function isCorePresentationCurrent(
  state: CorePresentationState | null | undefined,
  session: CoreInputSession | null | undefined,
  revision?: number
): boolean {
  if (!state || !session) return false;
  // ★ F3B-6.21-A-Impl：revision 令牌必须匹配（调用方传入**当前** revision）。
  //   丢失 memo dependency ⇒ 令牌失配 ⇒ fail-closed（回落非 Core 呈现），
  //   **绝不**复用 stale geometry（旧行为是「静默复用」，现为「可观测降级」）。
  if (revision !== undefined && state.revision !== revision) return false;
  const document = documentOf(session);
  const current = session.history.state;
  return (
    state.documentVersion === document.version &&
    state.sourceCaret === (current.caret ?? null) &&
    state.sourceSelection === (current.selection ?? null)
  );
}

// ─────────────────────────────────────────────────────────────────────
//  输入处理（C3 / C4）
// ─────────────────────────────────────────────────────────────────────

/** 每次输入可覆盖的上下文（例如把 DOM 选区同步过来；不产生 history entry） */
export interface CoreInputHandleOptions {
  selection?: EditorSelection;
  caret?: Caret;
  /** 临时切换目标 TextBox（缺省用 session 的） */
  textBoxId?: string;
}

export interface CoreInputResult {
  /** C8·T2：本次输入产出的命令数（P0 集合恒为 0 或 1） */
  commands: EditorCommand[];
  /** 是否真的产生了一次 history transaction */
  committed: boolean;
  /**
   * 01H（PARAGRAPH-EDIT-ACCEPTANCE）：已提交事务的**只读透出**。
   *
   * 用途：让上层能引用「本次 mutation 的事实」，避免事后靠结构相似性推断。
   * 约束：
   *   · 只在事务**已提交**时非 null；失败 / 未提交 ⇒ null
   *   · `createdParagraphIds` 是 after\before 的确定性差集；无新增段落 ⇒ []
   *   · 它**不是**归属证据；归属必须由 binding 层结合当前状态另行验证
   */
  readonly transactionId: string | null;
  readonly transactionType: CommandType | null;
  readonly createdParagraphIds: readonly string[] | null;
  /** mutation **后**的文档（与 `history.state.document` 同一对象） */
  document: EditorDocument;
  selection: EditorSelection;
  caret: Caret;
  /** 基于 after-document 的布局（C4：同一周期完成） */
  layout: TextLayout;
  /** 基于 after-document 的帧（C4：同一周期完成） */
  renderFrame: EditorRenderFrame;
  caretResolution: CaretResolution;
  /** C7 排他性证据：本次输入由谁处理 */
  handledBy: InputRoute;
  /** 恒为 `false` —— Core 输入不反写 legacy */
  legacyMutation: false;
  /** 事务提交前后的 history 规模（C8·T1/T5 断言用） */
  historySize: number;
  historyApplied: number;
  warnings: string[];
}

export type CoreInputOutcome =
  | { ok: true; result: CoreInputResult }
  | { ok: false; reason: string; warnings: string[] };

/**
 * 处理一个归一化输入事件：InputEvent → Command → History → Layout → Frame。
 *
 * **同步**完成（C4）：函数返回时 `document` / `layout` / `renderFrame` 都已是新文本的形态，
 * 不存在"等 blur 再布局"的中间态。
 */
export function handleCoreInput(
  session: CoreInputSession,
  event: InputEvent,
  options: CoreInputHandleOptions = {}
): CoreInputOutcome {
  const warnings: string[] = [];

  // 选区/插入点同步：CORE-004 明确"移动选区不占 undo 步"
  if (options.selection !== undefined || options.caret !== undefined) {
    session.history.updateSelection({ selection: options.selection, caret: options.caret });
  }

  const textBoxId = options.textBoxId ?? session.textBoxId;
  try {
    const reflow = runLiveReflow(session.history, event, {
      adapter: session.adapter,
      textBoxId,
      metrics: session.metrics,
    });
    warnings.push(...reflow.warnings);

    const renderFrame = renderFrameFromLiveReflow(reflow);

    return {
      ok: true,
      result: {
        commands: reflow.commands,
        committed: reflow.committed,
        transactionId: reflow.transactionId,
        transactionType: reflow.transactionType,
        createdParagraphIds: reflow.createdParagraphIds,
        document: reflow.document,
        selection: reflow.selection,
        caret: reflow.caret,
        layout: reflow.layout,
        renderFrame,
        caretResolution: reflow.caretResolution,
        handledBy: "core",
        legacyMutation: false,
        historySize: session.history.size,
        historyApplied: session.history.appliedCount,
        warnings: dedupe(warnings),
      },
    };
  } catch (error) {
    return { ok: false, reason: `live-reflow-failed: ${describe(error)}`, warnings };
  }
}

/** 便捷：直接吃 `beforeinput` 的 `(inputType, data)`（生产接线用同一个入口） */
export function handleCoreBeforeInput(
  session: CoreInputSession,
  inputType: string,
  data: string | null | undefined,
  options: CoreInputHandleOptions = {}
): CoreInputOutcome {
  const event = beforeInputToInputEvent(inputType, data);
  if (!event) {
    return {
      ok: false,
      reason: `unsupported-input-type: ${inputType}`,
      warnings: ["未建模的 beforeinput.inputType → 应交由 legacy 处理（不猜）"],
    };
  }
  return handleCoreInput(session, event, options);
}

/** 便捷：IME 组合事件（F3B-6.21-E：+ `"cancel"`，保持**单一入口**） */
export function handleCoreComposition(
  session: CoreInputSession,
  phase: "start" | "update" | "end" | "cancel",
  data = "",
  options: CoreInputHandleOptions = {}
): CoreInputOutcome {
  return handleCoreInput(session, compositionToInputEvent(phase, data), options);
}

// ─────────────────────────────────────────────────────────────────────
//  C7：唯一派发点（结构性保证"同一次输入只有一个处理器"）
// ─────────────────────────────────────────────────────────────────────

export interface DispatchBeforeInputArgs {
  coreEnabled: boolean;
  /** flag on 但 session 不可用时的回退（例如无文本目标） */
  session: CoreInputSession | null;
  inputType: string;
  data?: string | null;
  options?: CoreInputHandleOptions;
  /** legacy 处理器（onBlur/onChange 路径）。**只有** Core 未接管时才可能被调用。 */
  handleInLegacy: () => void;
}

export interface DispatchBeforeInputOutcome {
  route: InputRoute;
  /** Core 接管时的结果；legacy 路由时为 `null` */
  core: CoreInputOutcome | null;
  /** legacy 处理器是否真的被调用（C7 断言：Core 路由时必须为 false） */
  legacyCalled: boolean;
  /** 未接管的原因（诊断） */
  reason: string | null;
}

/**
 * **唯一**输入派发点。
 *
 * 结构性保证排他性：先决定路由，再**只调用**其中一条路径。
 * 因此不可能出现「Core 插了一次 + legacy 又插一次」→ `"A"` 变 `"AA"`。
 */
export function dispatchBeforeInput(args: DispatchBeforeInputArgs): DispatchBeforeInputOutcome {
  const corePath = args.coreEnabled && args.session !== null;
  const event = corePath ? beforeInputToInputEvent(args.inputType, args.data) : null;

  if (corePath && event) {
    const core = handleCoreInput(args.session as CoreInputSession, event, args.options ?? {});
    if (core.ok) {
      return { route: "core", core, legacyCalled: false, reason: null };
    }
    // Core 处理失败 → 仍**不**同时交给 legacy（那会造成双重插入）；
    // 明确报错，让调用方决定（默认：本次输入丢弃并告警）。
    return { route: "core", core, legacyCalled: false, reason: core.reason };
  }

  const reason = !args.coreEnabled
    ? "flag-off"
    : args.session === null
      ? "no-session"
      : `unsupported-input-type: ${args.inputType}`;
  args.handleInLegacy();
  return { route: "legacy", core: null, legacyCalled: true, reason };
}

// ─────────────────────────────────────────────────────────────────────
//  C9：Undo / Redo（document + selection + caret 一起恢复）
// ─────────────────────────────────────────────────────────────────────

export interface CoreUndoRedoOutcome {
  applied: boolean;
  document: EditorDocument;
  selection: EditorSelection;
  caret: Caret;
  /** 恢复后的帧（同一周期，便于页面直接重绘） */
  renderFrame: EditorRenderFrame;
  layout: TextLayout;
  historyApplied: number;
}

/** Undo：document / selection / caret 全部回到 before（CORE-004 契约） */
export function undoCoreInput(
  session: CoreInputSession,
  options: { textBoxId?: string } = {}
): CoreUndoRedoOutcome {
  const result = session.history.undo();
  return snapshotSession(session, options.textBoxId ?? session.textBoxId, result.applied);
}

/** Redo：document / selection / caret 全部回到 after */
export function redoCoreInput(
  session: CoreInputSession,
  options: { textBoxId?: string } = {}
): CoreUndoRedoOutcome {
  const result = session.history.redo();
  return snapshotSession(session, options.textBoxId ?? session.textBoxId, result.applied);
}

/**
 * 用当前 history 状态重建 layout + frame（undo/redo 后同步页面用）。
 *
 * 只调用 `layoutTextBox` + `buildRenderFrame`，**不经过 InputAdapter**
 * （undo/redo 不是输入，不该碰 IME 组合状态，也不该产生任何命令）。
 *
 * `applied` 必须由调用方从 `history.undo()/redo()` 的结果传入 ——
 * **不能硬编码 `true`**（栈到底时 `applied === false`，硬编码会掩盖"没有可撤销步"）。
 */
export function snapshotSession(
  session: CoreInputSession,
  textBoxId?: string,
  applied = true
): CoreUndoRedoOutcome {
  const state: EditorHistoryState = session.history.state;
  const target = textBoxId ?? session.textBoxId;
  const layoutResult = layoutTextBox(state.document, target, session.metrics, {
    caret: state.caret,
    selection: state.selection,
  });
  return {
    applied,
    document: state.document,
    selection: state.selection,
    caret: state.caret,
    layout: layoutResult.layout,
    renderFrame: buildRenderFrame(state.document, layoutResult.layout, {
      caret: layoutResult.caretGeometry,
      selection: layoutResult.selectionGeometry,
    }),
    historyApplied: session.history.appliedCount,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  工具
// ─────────────────────────────────────────────────────────────────────

/**
 * runId → 该 run 在本段落中的 UTF-16 起点。
 *
 * ⚠️ `getRunStartOffsetInParagraph(paragraph, runIndex)` 取的是 **runIndex（数字）**，
 * 不是 runId。这里先定位下标再调用，避免把字符串当索引用。
 */
export function paragraphOffsetOf(session: CoreInputSession, runId: string): number | null {
  const document = session.history.state.document;
  for (const page of document.pages) {
    for (const textBox of page.objects) {
      if (textBox.type !== "text") continue; // F3B-6.24-B3：图片对象无段落
      for (const paragraph of textBox.paragraphs) {
        const runIndex = paragraph.runs.findIndex((r) => r.id === runId);
        if (runIndex >= 0) return getRunStartOffsetInParagraph(paragraph, runIndex);
      }
    }
  }
  return null;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** 供测试/守卫使用：Core 编辑状态里**不应出现**的 legacy 字段（C2） */
export const CORE_INPUT_FORBIDDEN_STATE_KEYS = [
  "docBlocks",
  "segments",
  "localText",
  "editSession",
  "blocks",
] as const;
