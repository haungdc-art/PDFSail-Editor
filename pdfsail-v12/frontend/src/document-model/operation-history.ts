/**
 * Operation History — M6-IMPLEMENT-001B（ADR-052）
 *
 * 用户编辑 Undo/Redo 栈（operation-inverse 模型，非 snapshot）。
 * 与 ExecutionHistory（Agent 计划级 snapshot undo）分离。
 *
 * 分层（PM）：
 *   Mutation = "如何改变文档"
 *   History  = "如何记录变化"（不进入 mutation 内部）
 *
 * HistoryEntry：
 *   - operation + inverse：恢复 Document State
 *   - beforeCaret/afterCaret + beforeSelection/afterSelection：恢复 Interaction State
 *
 * Undo = 应用 inverse 恢复文档 + 恢复到 beforeCaret/beforeSelection
 * Redo = 重放 forward operation
 */
import type { EditableDocument, EditableGlyph, EditableLine } from "./types";
import type { GlyphRange, TextOperation } from "./text-operation";
import { applyTextOperation } from "./text-operation";
import type { InverseData } from "./document-mutation";
import type { GlyphCaret } from "./edit-session";
import type { SelectionRange } from "./current-selection";

export interface HistorySelection {
  ranges?: SelectionRange[];
  text?: string;
  blockId?: string;
  lineId?: string;
}

export interface HistoryEntry {
  id: string;
  operation: TextOperation;
  inverse: InverseData;
  /**
   * F3B-6.4B-4.4A —— 该 entry 是否由 **Segment canonical commit** 产生，以及它属于哪个 Segment。
   *
   * 取值 = `sourceSegmentKey(segment.source)`（canonical position identity，
   * 形状 `blockId::lineId::startGlyphIndex::endGlyphIndex`）。
   *
   * 非 Segment 的 entry（glyph delete / onTextEditSave 等）保持 `undefined`，
   * **不得伪造**一个 key —— 无 key 就是「与 Segment ledger 无关」。
   *
   * 语义边界（重要，勿越界）：
   *   · 这是**纯 metadata**：OperationHistory **不读它**、**不据此改变任何行为**
   *     （push / undo / redo / maxSize / redo-clear 语义完全不变）；
   *   · OperationHistory **不依赖** SegmentPositionLedger（禁止反向依赖）；
   *   · 它只让 **orchestration 层**（PDFEditor）在 undo/redo 前后知道
   *     「该回退/重放哪一条 ledger record」。
   *
   * 依据：docs/editor-core-012f3b6.4b4.3 —— 现有 `operation` 字段**无法**反推
   * sourceSegmentKey（`operation.range` 是当前坐标、`(lineId,range)` 会重复、
   * `type:"replace"` 被两个 producer 共用），故必须在此显式携带。
   */
  segmentKey?: string;
  beforeCaret?: GlyphCaret;
  afterCaret?: GlyphCaret;
  beforeSelection?: HistorySelection;
  afterSelection?: HistorySelection;
  timestamp: number;
}

/** F3B-6.4B-6.2a-2 —— inverse 未能应用的原因（fail-closed 诊断）。 */
export type InverseFailureReason = "target-not-found" | "anchor-not-found";

/**
 * F3B-6.4B-6.2a-2 —— inverse 应用结果（**fail-closed** contract）。
 *
 * `mutated === false` 的语义（**精确**）：
 *   该 inverse **未能定位目标 / 未能应用**（原先表现为静默 no-op）。此时：
 *     · `document` = **原文档**（**引用不变**）；
 *     · `undo()` **不得**消费 entry、**不得**改动 redoStack、**不得**触发 ledger 同步。
 *
 * 与之相对：定位**成功**但「内容恰好与当前相同」（例如 undo 一次空操作式编辑）
 *   仍为 `mutated: true` —— 它是一次**合法** undo，History 必须正常消费；
 *   否则该 entry 会永久卡在栈顶（Ctrl+Z 变成永不动）。
 */
export interface InverseApplicationResult {
  document: EditableDocument;
  mutated: boolean;
  reason?: InverseFailureReason;
}

export interface UndoRedoResult {
  success: boolean;
  document: EditableDocument;
  caret?: GlyphCaret;
  selection?: HistorySelection;
  /** F3B-6.4B-6.2a-2 —— `success === false` 时的原因（inverse 失败透传）。 */
  reason?: string;
}

let _id = 0;

/**
 * 应用 inverse，把文档恢复到 operation 前状态（Document State 恢复）。
 *
 * ── F3B-6.4B-6.2a-1 —— replace inverse **索引优先定位** ──
 *
 * 历史问题（B-6.2a 审计 Q1/Q2）：replace 分支原先**只用** `afterGlyphs[0]`
 * 作 anchor（`char + bbox.x`）定位；而「**纯删除型替换**」的 `afterGlyphs` 为空 ⇒
 * anchor 必然失配 ⇒ `idx < 0` ⇒ 静默 `return line`。触发条件远不止整行清空：
 *
 *   · 整行段清空       `"AAAAA.....BBBBB"` → `""`
 *   · 中段清空         `"AAAAA.....BBBBB"` → `"AAAAA....."`
 *   · 普通行尾局部删除  `"AAAAA"` → `"AAA"`（选中 [3,4] 删除）
 *
 * 三者共同点：该次替换**没有产出任何新 glyph** ⇒ `afterGlyphs = []`。
 * 后果是 `undo()` 消费了 entry（`success: true`、栈前进）但文档未回退 ⇒
 * **History state 与 Document state 分叉**。
 *
 * 定位规则（本参数引入后）：
 *   1. `range` 提供时以 `range.start` 为**主要定位依据**（undo 为 LIFO，
 *      此刻文档正是该 operation 的 `after` 状态，替换片段起点恰为 `range.start`）；
 *   2. `afterGlyphs[0]` 仍作**交叉校验**：anchor 命中且与索引不一致 ⇒ 以**内容锚点**
 *      为准（内容寻址比索引更抗漂移）⇒ **anchor 能命中时行为与修复前逐字节一致**；
 *   3. 移除数量恒为 `inverse.afterGlyphs.length`（**不是** `range` 跨度）——
 *      纯删除型替换移除 0 个，prefix/suffix 因此完整保留；
 *   4. `range` 未传时行为与修复前**逐字节一致**（旧调用方/旧 inverse 不受影响）。
 *
 * ── F3B-6.4B-6.2a-2 —— **fail-closed** 返回契约 ──
 * 返回类型由 `EditableDocument` 改为 `InverseApplicationResult`：
 *   · 定位 / 应用成功            ⇒ `{ document, mutated: true }`
 *   · 未能定位目标 / 未能应用    ⇒ `{ document: <原文档，引用不变>, mutated: false, reason }`
 * 原因取值：`target-not-found`（block/line 不存在）· `anchor-not-found`（replace 且无 range 可定位）。
 * `undo()` 据此**只在 `mutated === true` 时**消费 entry（见 undo()）。
 */
export function applyInverseToDocument(
  doc: EditableDocument,
  inverse: InverseData,
  blockId: string,
  lineId: string,
  range?: GlyphRange
): InverseApplicationResult {
  // F3B-6.4B-6.2a-2：fail-closed 追踪 —— 只有真正命中并应用才置 true
  let mutated = false;
  let reason: InverseFailureReason | undefined;

  const pages = doc.pages.map((page) => ({
    ...page,
    blocks: page.blocks.map((block) => {
      if (block.id !== blockId) return block;
      const lines = block.lines.map((line): EditableLine => {
        if (line.id !== lineId) return line;
        const glyphs = line.glyphs;

        if (inverse.kind === "insert") {
          // 删除 createdGlyphs，suffix 左移恢复
          const insW = inverse.createdGlyphs.reduce((a, g) => a + g.bbox.width, 0);
          const prefix = glyphs.slice(0, inverse.insertedRange.start);
          const suffix = glyphs.slice(inverse.insertedRange.end + 1).map((g) => ({ ...g, bbox: { ...g.bbox, x: g.bbox.x - insW } }));
          mutated = true;
          return { ...line, glyphs: [...prefix, ...suffix] };
        }

        if (inverse.kind === "delete") {
          // 插入 removedGlyphs（恢复原始 identity/geometry），suffix 右移恢复
          const remW = inverse.removedGlyphs.reduce((a, g) => a + g.bbox.width, 0);
          const prefix = glyphs.slice(0, inverse.removedRange.start);
          const restored = inverse.removedGlyphs.map((g) => ({
            ...g,
            bbox: g.originalBBox ? { ...g.originalBBox } : { ...g.bbox },
          }));
          const suffix = glyphs.slice(inverse.removedRange.start).map((g) => ({ ...g, bbox: { ...g.bbox, x: g.bbox.x + remW } }));
          mutated = true;
          return { ...line, glyphs: [...prefix, ...restored, ...suffix] };
        }

        if (inverse.kind === "replace") {
          // 用 beforeGlyphs 替换 afterGlyphs 区间
          // F3B-6.4B-6.2a-1：索引优先定位（详见函数头「定位规则」）
          const a0 = inverse.afterGlyphs[0];
          const anchorIdx = a0
            ? glyphs.findIndex((g) => g.char === a0.char && g.bbox.x === a0.bbox.x)
            : -1;

          let idx: number;
          if (range) {
            // 主要依据：operation.range.start（LIFO undo 下即为 after 文档中的插入点）
            const rangeIdx = Math.max(0, Math.min(range.start, glyphs.length));
            // 交叉校验：anchor 命中且与索引不一致 ⇒ 以内容锚点为准（抗索引漂移）；
            //           anchor 未命中 ⇒ 采用索引 —— **这正是本次修复新增的路径**
            idx = anchorIdx >= 0 && anchorIdx !== rangeIdx ? anchorIdx : rangeIdx;
          } else {
            // 无 range（旧调用方）⇒ 与修复前完全一致：仅 anchor
            idx = anchorIdx;
          }
          if (idx < 0) {
            // F3B-6.4B-6.2a-2：原为静默 `return line`（undo 仍报成功）⇒ 现**如实上报失败**
            reason = "anchor-not-found";
            return line;
          }

          const prefix = glyphs.slice(0, idx);
          // 移除数量 = afterGlyphs.length（**不是** range 跨度）：
          // 纯删除型替换（afterGlyphs 为空）移除 0 个 ⇒ prefix/suffix 完整保留
          const suffix = glyphs.slice(idx + inverse.afterGlyphs.length);
          const before = inverse.beforeGlyphs.map((g) => ({
            ...g,
            bbox: g.originalBBox ? { ...g.originalBBox } : { ...g.bbox },
          }));
          mutated = true;
          return { ...line, glyphs: [...prefix, ...before, ...suffix] };
        }

        return line;
      });
      return { ...block, lines };
    }),
  }));

  // F3B-6.4B-6.2a-2 —— fail-closed：未能应用 ⇒ **返回原文档引用**并报告原因
  if (!mutated) {
    return { document: doc, mutated: false, reason: reason ?? "target-not-found" };
  }
  return { document: { ...doc, pages }, mutated: true };
}

/** 获取 operation 的目标 blockId/lineId（供 inverse 应用定位）。 */
export function operationTarget(op: TextOperation): { blockId: string; lineId: string } {
  if (op.type === "insert") return { blockId: op.blockId, lineId: op.position.lineId };
  return { blockId: op.blockId, lineId: op.lineId };
}

export class OperationHistory {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get size(): number {
    return this.undoStack.length;
  }

  /**
   * F3B-6.4B-4.4A —— 只读查看**下一次 undo 将消费**的 entry。
   *
   * 纯读取：**不移动任何栈、不改变任何状态、不依赖 Ledger**。
   * `maxSize` 截断与 `redoStack` 清空行为在 `push()` 内，不受本方法影响。
   *
   * 用途：orchestration 层在 `undo()` 之前先 peek，取得该次操作的 `segmentKey`，
   * 以便在文档回滚后同步 SegmentPositionLedger（4.4B）。
   *
   * 返回内部 entry 的**引用**（保持 identity 可比，便于与 `undo()` 消费的条目对照）。
   * 调用方**不得修改**返回值。
   */
  peekUndo(): HistoryEntry | null {
    return this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1] : null;
  }

  /** F3B-6.4B-4.4A —— 只读查看**下一次 redo 将消费**的 entry。语义同 `peekUndo()`。 */
  peekRedo(): HistoryEntry | null {
    return this.redoStack.length > 0 ? this.redoStack[this.redoStack.length - 1] : null;
  }

  /**
   * F3B-6.4B-P1-1 —— **只读**枚举「当前仍被应用（位于 undoStack）的 entry 所涉及的行」。
   *
   * 用途：派生 render state（`editedLines` / `editedLineBoxes` / DOM mask）的判据 ——
   * 「该行是否仍处于已编辑状态」。undo 后 entry 会从 undoStack 移到 redoStack，
   * 因此该集合天然表达「当前文档状态下**仍然生效**的编辑」。
   *
   * 纯读取：**不移动栈、不改变任何状态、不依赖 Ledger**（与 peekUndo/peekRedo 同族）。
   *
   * 已知边界（**文档化，不在本轮解决**）：
   *   · `maxSize`（默认 100）截断会丢弃最旧 entry ⇒ 若某行最旧的编辑已被截断，
   *     本集合会**漏判**该行仍在编辑状态（保守方向见 P1-1 报告）；
   *   · 它表达「是否发生过仍生效的编辑 op」，不表达「内容是否恰好等于原文」
   *     （用户把文本改回原样仍算已编辑）。
   */
  appliedLineIds(): Set<string> {
    const ids = new Set<string>();
    for (const e of this.undoStack) {
      const t = operationTarget(e.operation);
      if (t.lineId) ids.add(t.lineId);
    }
    return ids;
  }

  /** 记录一次 operation（含 inverse + caret/selection 前后）。 */
  push(entry: Omit<HistoryEntry, "id" | "timestamp">): void {
    const full: HistoryEntry = { ...entry, id: `op_${++_id}`, timestamp: Date.now() };
    this.undoStack.push(full);
    this.redoStack = []; // 新操作清空 redo
    if (this.undoStack.length > this.maxSize) this.undoStack.shift();
  }

  /**
   * 撤销：应用 inverse 恢复文档 + 恢复到 beforeCaret/beforeSelection。
   *
   * ── F3B-6.4B-6.2a-2 —— **fail-closed** ──
   * **只有 inverse 真正应用成功**（`mutated === true`）才消费 entry：
   *   · 成功 ⇒ `undoStack.pop()` + `redoStack.push(entry)`（**成功路径的 LIFO 语义完全不变**）；
   *   · 失败 ⇒ **不动任何栈**、文档不变，返回 `success: false` + `reason`。
   *
   * 修复前：`pop()` 先行且 `applyInverseToDocument` 不报错 ⇒ 「inverse 未生效」会表现为
   * 「History 假装前进」（entry 进 redoStack、文档不动）。该 entry 现**留在栈顶**。
   */
  undo(doc: EditableDocument): UndoRedoResult {
    // 先 peek（**不移除**）—— 只有应用成功才真正消费
    const entry = this.undoStack[this.undoStack.length - 1];
    if (!entry) return { success: false, document: doc };
    const { blockId, lineId } = operationTarget(entry.operation);
    // F3B-6.4B-6.2a-1：把 operation.range 交给 inverse 作**索引定位依据**
    // （replace 分支不再只能依赖 afterGlyphs[0] anchor）。
    // range 是既有字段 ⇒ HistoryEntry 结构**不变**，无需新增定位信息。
    const range = entry.operation.type === "replace" ? entry.operation.range : undefined;
    const applied = applyInverseToDocument(doc, entry.inverse, blockId, lineId, range);

    if (!applied.mutated) {
      // fail-closed：不消费 entry、不改动 redoStack、不改变文档
      return { success: false, document: doc, reason: applied.reason };
    }

    this.undoStack.pop();
    this.redoStack.push(entry);
    return {
      success: true,
      document: applied.document,
      caret: entry.beforeCaret,
      selection: entry.beforeSelection,
    };
  }

  /**
   * 重做：重放 forward operation。
   *
   * ⚠️ **本轮（B-6.2a-2）刻意不改 redo 的失败语义** —— 范围纪律：
   *   `applyTextOperation` 已返回 `mutated/reason`，这里本可同样 fail-closed；
   *   但 redo 的 `mutated === false` 存在**合法**来源（例如重放一个当前状态下
   *   恰好无需变更的 operation），贸然 fail-closed 会让正常 redo 卡住。
   *   该不对称已作为**观察项**记录在 B-6.2a-2 文档，另行授权再处理。
   */
  redo(doc: EditableDocument): UndoRedoResult {
    const entry = this.redoStack.pop();
    if (!entry) return { success: false, document: doc };
    const result = applyTextOperation(doc, entry.operation);
    this.undoStack.push(entry);
    return {
      success: true,
      document: result.document,
      caret: entry.afterCaret,
      selection: entry.afterSelection,
    };
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

/**
 * 应用某个 entry 的 inverse（`undo()` 的 entry 级等价物）。
 *
 * F3B-6.4B-6.2a-2：返回类型与 `applyInverseToDocument` 一致（**fail-closed**），
 * 不再静默丢弃失败信息。调用方须判 `mutated` 后再消费 History。
 */
export function applyInverse(doc: EditableDocument, entry: HistoryEntry): InverseApplicationResult {
  const { blockId, lineId } = operationTarget(entry.operation);
  // F3B-6.4B-6.2a-1：与 undo() 保持一致的定位依据（range 为可选，缺失时退回 anchor）
  const range = entry.operation.type === "replace" ? entry.operation.range : undefined;
  return applyInverseToDocument(doc, entry.inverse, blockId, lineId, range);
}
