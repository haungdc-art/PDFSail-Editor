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
import type { TextOperation } from "./text-operation";
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
  beforeCaret?: GlyphCaret;
  afterCaret?: GlyphCaret;
  beforeSelection?: HistorySelection;
  afterSelection?: HistorySelection;
  timestamp: number;
}

export interface UndoRedoResult {
  success: boolean;
  document: EditableDocument;
  caret?: GlyphCaret;
  selection?: HistorySelection;
}

let _id = 0;

/** 应用 inverse，把文档恢复到 operation 前状态（Document State 恢复）。 */
export function applyInverseToDocument(
  doc: EditableDocument,
  inverse: InverseData,
  blockId: string,
  lineId: string
): EditableDocument {
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
          return { ...line, glyphs: [...prefix, ...restored, ...suffix] };
        }

        if (inverse.kind === "replace") {
          // 用 beforeGlyphs 替换 afterGlyphs 区间
          const a0 = inverse.afterGlyphs[0];
          const idx = glyphs.findIndex((g) => a0 && g.char === a0.char && g.bbox.x === a0.bbox.x);
          if (idx < 0) return line;
          const prefix = glyphs.slice(0, idx);
          const suffix = glyphs.slice(idx + inverse.afterGlyphs.length);
          const before = inverse.beforeGlyphs.map((g) => ({
            ...g,
            bbox: g.originalBBox ? { ...g.originalBBox } : { ...g.bbox },
          }));
          return { ...line, glyphs: [...prefix, ...before, ...suffix] };
        }

        return line;
      });
      return { ...block, lines };
    }),
  }));
  return { ...doc, pages };
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

  /** 记录一次 operation（含 inverse + caret/selection 前后）。 */
  push(entry: Omit<HistoryEntry, "id" | "timestamp">): void {
    const full: HistoryEntry = { ...entry, id: `op_${++_id}`, timestamp: Date.now() };
    this.undoStack.push(full);
    this.redoStack = []; // 新操作清空 redo
    if (this.undoStack.length > this.maxSize) this.undoStack.shift();
  }

  /** 撤销：应用 inverse 恢复文档 + 恢复到 beforeCaret/beforeSelection。 */
  undo(doc: EditableDocument): UndoRedoResult {
    const entry = this.undoStack.pop();
    if (!entry) return { success: false, document: doc };
    const { blockId, lineId } = operationTarget(entry.operation);
    const restored = applyInverseToDocument(doc, entry.inverse, blockId, lineId);
    this.redoStack.push(entry);
    return {
      success: true,
      document: restored,
      caret: entry.beforeCaret,
      selection: entry.beforeSelection,
    };
  }

  /** 重做：重放 forward operation。 */
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

export function applyInverse(doc: EditableDocument, entry: HistoryEntry): EditableDocument {
  const { blockId, lineId } = operationTarget(entry.operation);
  return applyInverseToDocument(doc, entry.inverse, blockId, lineId);
}
