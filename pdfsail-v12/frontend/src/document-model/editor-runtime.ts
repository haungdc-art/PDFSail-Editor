/**
 * EditorRuntime — Editor 运行上下文（Task-011C · Composition Root 内部对象）
 *
 * 重要：这不是 Contract（非 interface），而是 Composition Root 装配给 Command 的运行时容器。
 * Command 不依赖 Provider / Store / React，只依赖构造时注入的 runtime。
 *
 * runtime 只提供两个能力：
 *   - getDocument()  —— 读取当前 EditableDocument（由 Composition Root 用 editableDocumentRef.current 填充）
 *   - applyDocument() —— 把 MutationResult 写回（由 Composition Root 用 setEditableDocVersion / setDocBlocks 填充）
 *
 * 依赖方向（保持 Principle-12 不变）：
 *   Composition Root ──注入──▶ ReplaceCommand ──读/写──▶ runtime
 *
 * 不修改任何已有 Contract。EditTool / Registry / CapabilityCommand / CurrentSelection 全部不变。
 */
import type { EditableDocument } from "./types";
import type { MutationResult } from "./document-mutation";

export interface EditorRuntimeDeps {
  /** 读取当前 document；无文档时返回 null */
  getDocument: () => EditableDocument | null;
  /** 把一次 mutation 结果写回 Runtime（ref 更新 + version++ + docBlocks 同步） */
  applyDocument: (result: MutationResult) => void;
}

export class EditorRuntime {
  constructor(private readonly deps: EditorRuntimeDeps) {}

  getDocument(): EditableDocument | null {
    return this.deps.getDocument();
  }

  apply(result: MutationResult): void {
    this.deps.applyDocument(result);
  }
}
