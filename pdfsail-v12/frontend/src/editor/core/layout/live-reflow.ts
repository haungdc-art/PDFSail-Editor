/**
 * editor/core/layout/live-reflow.ts — EDITOR-CORE-009
 *
 * Live Reflow：把前 8 个任务建好的零件串成**一次同步调用**（规范 §48）。
 *
 *     InputEvent
 *         ↓  CORE-008  InputAdapter.handle()
 *     EditorCommand[]
 *         ↓  CORE-004  EditorHistory.commit()
 *     EditorDocument + Selection + Caret
 *         ↓  CORE-002  从 **after document** 重新解析 caret（不猜）
 *     TextLayout + CaretGeometry + SelectionGeometry
 *
 * 一次按键结束后，**同一个同步函数调用内**即可同时拿到
 * document / selection / caret / layout / caretGeometry / selectionGeometry。
 * 不等 blur、不等 Enter、不等 React render、不等 DOM mutation、不等 export。
 *
 * ── 与 CORE-008 的分工（关键）──────────────────────────────────────
 * 008 刻意**不预测** caret：真实位置取决于 Command 执行后的文档
 * （带 provenance 的 run 上插入会新建 run，runId 无法从输入推导；
 *  含 "\n" 时还会新建段落，段落 id 由命令内部生成）。
 * 009 的顺序因此是 **先 commit、再在 after document 上解析**：
 *
 *     ✗  InputAdapter → 猜 newCaret → commit
 *     ✓  InputAdapter → Command → commit → afterDocument → resolve → layout
 *
 * **不从 before document 推导 runId**：本文件全部通过
 * `paragraphOffsetToPosition(afterDocument, ...)` 在**结果文档**上定位，
 * 因此「provenance run 插入后落在新 run 上」这类情形自然正确。
 *
 * ── 无法可靠推导时不猜 ─────────────────────────────────────────────
 * 返回 `caretResolution: "unresolved"` 并给出 warning，而不是猜一个位置。
 *
 * ── 依赖边界 ───────────────────────────────────────────────────────
 * 运行时只依赖 `./reflow`、`./types`、`../position`；
 * 对 `../input` / `../history` / `../commands` **只有 type-only import**
 * （适配器、历史实例、命令类都由调用方注入）—— 因此本文件不把
 * layout 层在运行期绑到 input/history 上，也不新增任何真相。
 * 无 React / DOM / PDF / legacy / glyphIndex。
 */

import type {
  DeleteTextCommand,
  InsertTextCommand,
  MergeParagraphCommand,
  ReplaceTextCommand,
  SplitParagraphCommand,
} from "../commands/index";
import type { EditorCommand, CommandType } from "../commands/types";
import { isTextBox } from "../document/query";
import type { EditorDocument, Paragraph, TextBoxObject } from "../document/types";
import type { EditorHistory, EditorHistoryState, EditorTransaction } from "../history/index";
import type { InputAdapter, InputEvent } from "../input/index";
import { normalizeTextRange, paragraphOffsetToPosition, positionToParagraphOffset } from "../position/index";
import type { Caret, EditorSelection, TextPosition } from "../position/types";
import type { FontMetricsProvider } from "./metrics";
import { layoutTextBox } from "./reflow";
import type {
  CaretGeometry,
  LayoutOptions,
  SelectionGeometry,
  TextLayout,
} from "./types";

// ─────────────────────────────────────────────────────────────────────
//  类型
// ─────────────────────────────────────────────────────────────────────

/** caret 的解析结果 */
export type CaretResolution =
  /** 已根据 after document 解析出新的插入点 */
  | "resolved"
  /** 命令不改文本（如 SetTextStyle）→ 沿用原插入点 */
  | "unchanged"
  /** 无 Command（no-op 输入）→ 状态与几何都保持原样 */
  | "noop"
  /** **不猜**：无法可靠推导，调用方应保守处理（例如等待用户下一次点击） */
  | "unresolved";

export interface LiveReflowContext {
  /**
   * 输入适配器（**由调用方持有**）。
   * IME 组合状态存在适配器内部，因此不能每次调用新建一个。
   */
  adapter: InputAdapter;
  /** 要布局的 TextBox（§16：布局约束来自 TextBox.width） */
  textBoxId: string;
  /** 度量提供者（注入；Core 不内置字体度量） */
  metrics: FontMetricsProvider;
  /** 透传给 layoutTextBox 的选项 */
  layoutOptions?: LayoutOptions;
}

export interface LiveReflowResult {
  /** 本次输入产出的命令（0 或 1，见 CORE-008 契约） */
  commands: EditorCommand[];
  /** 是否真的产生了一次 history transaction */
  committed: boolean;
  /** 命令执行**前**的状态快照（对比/测试用） */
  before: EditorHistoryState;
  /** 命令执行**后**的状态（与 `history.state` 同一对象） */
  document: EditorDocument;
  /**
   * 01H（PARAGRAPH-EDIT-ACCEPTANCE）：已提交事务的**只读透出**（不改历史语义、不改命令语义）。
   *
   * 只用于让上层能够引用「本次 mutation 的事实」，
   * **不**作为段落归属的推断来源：归属判定由 binding 层结合当前状态另行验证。
   *
   * · 未提交 / 无事务 ⇒ `null`
   * · 已提交但无新增段落 ⇒ `createdParagraphIds: []`
   */
  readonly transactionId: string | null;
  readonly transactionType: CommandType | null;
  readonly createdParagraphIds: readonly string[] | null;
  selection: EditorSelection;
  caret: Caret;
  /** 基于 **after document** 的布局 */
  layout: TextLayout;
  caretGeometry: CaretGeometry | null;
  selectionGeometry: SelectionGeometry | null;
  caretResolution: CaretResolution;
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────
//  document 导航（只读；不做几何）
// ─────────────────────────────────────────────────────────────────────

function textBoxOf(document: EditorDocument, textBoxId: string): TextBoxObject | null {
  for (const page of document.pages) {
    const textBox = page.objects.find((o) => o.id === textBoxId);
    if (textBox && isTextBox(textBox)) return textBox;
  }
  return null;
}

function textBoxIdOfParagraph(document: EditorDocument, paragraphId: string): string | null {
  for (const page of document.pages) {
    for (const textBox of page.objects) {
      if (textBox.type !== "text") continue;
      if (textBox.paragraphs.some((p) => p.id === paragraphId)) return textBox.id;
    }
  }
  return null;
}

function paragraphIndexOf(
  document: EditorDocument,
  textBoxId: string,
  paragraphId: string
): number {
  const textBox = textBoxOf(document, textBoxId);
  if (!textBox) return -1;
  return textBox.paragraphs.findIndex((p) => p.id === paragraphId);
}

function paragraphAt(
  document: EditorDocument,
  textBoxId: string,
  index: number
): Paragraph | null {
  const textBox = textBoxOf(document, textBoxId);
  if (!textBox) return null;
  return textBox.paragraphs[index] ?? null;
}

function paragraphLength(paragraph: Paragraph): number {
  let n = 0;
  for (const run of paragraph.runs) n += run.text.length;
  return n;
}

// ─────────────────────────────────────────────────────────────────────
//  Command → 目标段落偏移（§4 的最小规则）
// ─────────────────────────────────────────────────────────────────────

export interface CaretTarget {
  paragraphId: string;
  /** 段落内 UTF-16 偏移 */
  offset: number;
}

/**
 * 根据 before 状态 + command + **after document** 推导插入点的目标段落偏移。
 *
 * 返回：
 *   · `{ paragraphId, offset }` —— 目标（随后在 after document 上解析成 TextPosition）
 *   · `"keep"`                  —— 文本未变，沿用原 caret
 *   · `null`                    —— **不猜**（调用方标记 unresolved）
 *
 * 注意本函数**只看段落偏移**，绝不从 before 推导 runId；runId 一律由
 * `paragraphOffsetToPosition(after, ...)` 在结果文档上解析。
 *
 * 本函数即规范 §4 要求的「Command → 结果位置」最小规则表，单独导出以便
 * 直接测试与后续阶段（010 Renderer / 013 legacy 切换）复用。
 */
export function resolveCaretTarget(
  before: EditorDocument,
  command: EditorCommand,
  after: EditorDocument
): CaretTarget | "keep" | null {
  switch (command.type) {
    case "insert-text": {
      const cmd = command as InsertTextCommand;
      const base = positionToParagraphOffset(before, cmd.position);
      const textBoxId = cmd.position.textBoxId;
      const segments = cmd.text.split("\n");
      if (segments.length === 1) {
        // 单段：同一段落内右移
        return { paragraphId: cmd.position.paragraphId, offset: base + cmd.text.length };
      }
      // 含 "\n" → 段落拆分：插入点落在**最后一个新段落**的末尾
      const idx = paragraphIndexOf(before, textBoxId, cmd.position.paragraphId);
      if (idx < 0) return null;
      const last = paragraphAt(after, textBoxId, idx + segments.length - 1);
      if (!last) return null;
      return { paragraphId: last.id, offset: segments[segments.length - 1].length };
    }

    case "delete-text": {
      const cmd = command as DeleteTextCommand;
      const normalized = normalizeTextRange(before, cmd.range);
      // 删除后插入点 = 选区起点（§4）
      return {
        paragraphId: normalized.anchor.paragraphId,
        offset: positionToParagraphOffset(before, normalized.anchor),
      };
    }

    case "replace-text": {
      const cmd = command as ReplaceTextCommand;
      const normalized = normalizeTextRange(before, cmd.range);
      const base = positionToParagraphOffset(before, normalized.anchor);
      const textBoxId = normalized.anchor.textBoxId;
      const segments = cmd.text.split("\n");
      if (segments.length === 1) {
        // 单段（含 text === "" 即退化为删除）：起点右移插入文本长度
        return { paragraphId: normalized.anchor.paragraphId, offset: base + cmd.text.length };
      }
      // 含 "\n" → 以选区起点所在段落为第 1 段，插入点落在最后一个新段落末尾
      const idx = paragraphIndexOf(before, textBoxId, normalized.anchor.paragraphId);
      if (idx < 0) return null;
      const last = paragraphAt(after, textBoxId, idx + segments.length - 1);
      if (!last) return null;
      return { paragraphId: last.id, offset: segments[segments.length - 1].length };
    }

    case "split-paragraph": {
      const cmd = command as SplitParagraphCommand;
      const textBoxId = cmd.position.textBoxId;
      const idx = paragraphIndexOf(before, textBoxId, cmd.position.paragraphId);
      if (idx < 0) return null;
      // 新段落 id 由命令内部生成 → 从 after document 按下标取
      const created = paragraphAt(after, textBoxId, idx + 1);
      if (!created) return null;
      return { paragraphId: created.id, offset: 0 };
    }

    case "merge-paragraph": {
      const cmd = command as MergeParagraphCommand;
      const textBoxId = textBoxIdOfParagraph(before, cmd.paragraphId);
      if (!textBoxId) return null;
      const idx = paragraphIndexOf(before, textBoxId, cmd.paragraphId);
      if (idx <= 0) return null;
      const prev = paragraphAt(before, textBoxId, idx - 1);
      if (!prev) return null;
      // CORE-003 的合并保留**前一个**段落的 id，插入点 = 合并边界
      return { paragraphId: prev.id, offset: paragraphLength(prev) };
    }

    case "set-text-style":
      // 文本结构未变 → 沿用原插入点（后续会校验其在新文档中仍合法）
      return "keep";

    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  主入口
// ─────────────────────────────────────────────────────────────────────

/**
 * 一次输入 → 命令 → 提交 → 重新定位 caret → 布局，全部同步完成。
 *
 * 调用方持有 `history` 与 `adapter`（IME 状态在 adapter 内）。
 */
/** 文档内全部段落 id（只用于「新增段落」的确定性差集，不作为归属证据） */
function allParagraphIds(document: EditorDocument): Set<string> {
  const out = new Set<string>();
  for (const page of document.pages ?? []) {
    for (const textBox of page.objects ?? []) {
      if (textBox.type !== "text") continue;
      for (const paragraph of textBox.paragraphs ?? []) out.add(paragraph.id);
    }
  }
  return out;
}

/**
 * 01H：事务**实际新增**的段落 id（确定性差集）。
 *
 * 只描述「这次 mutation 新建了哪些段落」，**不**声称这些段落属于哪个编辑目标；
 * 归属仍由调用方结合当前状态验证。
 */
function createdParagraphIdsOf(transaction: EditorTransaction): readonly string[] {
  const beforeIds = allParagraphIds(transaction.before.document);
  const created: string[] = [];
  for (const id of allParagraphIds(transaction.after.document)) {
    if (!beforeIds.has(id)) created.push(id);
  }
  return created;
}

export function runLiveReflow(
  history: EditorHistory,
  event: InputEvent,
  context: LiveReflowContext
): LiveReflowResult {
  const warnings: string[] = [];
  const before = history.state;

  // ① 输入 → Command（adapter 不改文档、不建 history）
  const input = context.adapter.handle(event, {
    document: before.document,
    selection: before.selection.range,
    caret: before.caret,
  });
  warnings.push(...input.warnings);

  const commands = input.commands;
  let committed = false;
  let resolution: CaretResolution = commands.length === 0 ? "noop" : "resolved";

  // 01H：事务只读透出（只记录**已提交**事务的事实；失败/未提交 ⇒ 保持 null）
  let lastTransactionId: string | null = null;
  let lastTransactionType: CommandType | null = null;
  let lastCreatedParagraphIds: readonly string[] | null = null;

  // ② 逐条执行并提交；每条之后都从 **结果文档** 重新定位插入点
  for (const command of commands) {
    const beforeCommand = history.state;
    let commitResult;
    try {
      commitResult = history.commit(command);
    } catch (error) {
      warnings.push(`命令执行失败（${command.type}）：${describeError(error)}`);
      resolution = "unresolved";
      break;
    }
    if (!commitResult.changed) continue;
    committed = true;

    // 01H：仅在**已提交**时记录事务事实（失败/未提交不产生可用证据）
    if (commitResult.transaction) {
      lastTransactionId = commitResult.transaction.id;
      lastTransactionType = commitResult.transaction.type;
      lastCreatedParagraphIds = createdParagraphIdsOf(commitResult.transaction);
    }

    let target: CaretTarget | "keep" | null = null;
    try {
      target = resolveCaretTarget(beforeCommand.document, command, commitResult.state.document);
    } catch (error) {
      warnings.push(`caret 解析失败（${command.type}）：${describeError(error)}`);
      target = null;
    }

    if (target === "keep") {
      resolution = "unchanged";
      continue;
    }
    if (target === null) {
      // §4：无法可靠推导时不猜
      resolution = "unresolved";
      warnings.push(
        `无法从 after document 可靠推导 caret（${command.type}）：保持 History clamp 结果，不猜测`
      );
      continue;
    }

    const position = toPosition(commitResult.state.document, target);
    if (!position) {
      resolution = "unresolved";
      warnings.push(`caret 目标段落已不存在（${command.type}）：保持 History clamp 结果，不猜测`);
      continue;
    }

    // updateSelection 不产生新的 history entry（CORE-004）
    const settledSelection = collapseSelection(position);
    const settledCaret: Caret = { position, affinity: "forward" };
    history.updateSelection({ selection: settledSelection, caret: settledCaret });

    // 012-D：把「命令执行后才知道」的解析结果**补进栈顶事务的 after**。
    // 少了这一步 → `transaction.after.caret` 停留在 commit 时刻的 clamp 值 →
    // `redo()` 会恢复旧插入点（undo 正确、redo 错误），违反 CORE-004 的可恢复性契约。
    // 本调用不产生新的 history entry（size 不变），只让 `after` 成为完整快照。
    history.finalizeLatestTransaction({ selection: settledSelection, caret: settledCaret });
  }

  // ③ 基于 **after document** 布局（不是旧文档）
  const state = history.state;
  const layoutResult = layoutTextBox(state.document, context.textBoxId, context.metrics, {
    caret: state.caret,
    selection: state.selection,
    options: context.layoutOptions,
  });
  warnings.push(...layoutResult.warnings);

  return {
    commands,
    committed,
    before,
    document: state.document,
    transactionId: lastTransactionId,
    transactionType: lastTransactionType,
    createdParagraphIds: lastCreatedParagraphIds,
    selection: state.selection,
    caret: state.caret,
    layout: layoutResult.layout,
    caretGeometry: layoutResult.caretGeometry,
    selectionGeometry: layoutResult.selectionGeometry,
    caretResolution: resolution,
    warnings,
  };
}

/** 在 after document 上把「段落 id + 偏移」解析成合法 TextPosition（runId 来自结果文档） */
function toPosition(document: EditorDocument, target: CaretTarget): TextPosition | null {
  try {
    return paragraphOffsetToPosition(document, target.paragraphId, target.offset);
  } catch {
    return null;
  }
}

function collapseSelection(position: TextPosition): EditorSelection {
  return { range: { anchor: position, focus: position } };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 便捷入口：折叠选区（判断是否已折叠时使用 CORE-002 的相等语义） */
export function isLiveReflowCommitted(result: LiveReflowResult): boolean {
  return result.committed;
}
