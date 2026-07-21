/**
 * EditorProvider — Commit 1 / Step 7
 *
 * 单一 Context，内部组合 5 个 domain hook（document/selection/tool/operation/workspace）。
 * 通过 useEditor() 暴露所有 state + setter + helper。
 *
 * 设计权衡：
 *   - 单一 Context 简单，符合 "Commit 1 风险最低" 原则
 *   - 任何 state 变化会让所有消费组件 re-render（Commit 2 拆组件后如遇性能问题再拆 Context）
 *   - hook 之间无依赖（每个 hook 内部自包含），可直接组合
 *
 * 跨 domain 协调逻辑（如"选中 block 同步工具栏"effect）留在 PDFEditorInner 中，
 * 通过 useEditor() 拿所需 state + setter。
 */

import { createContext, useContext, type ReactNode } from "react";
import { useDocument } from "../hooks/useDocument";
import { useSelection } from "../hooks/useSelection";
import { useToolState } from "../hooks/useToolState";
import { useOperationState } from "../hooks/useOperationState";
import { useWorkspaceState } from "../hooks/useWorkspaceState";

type EditorContextValue = ReturnType<typeof useDocument>
  & ReturnType<typeof useSelection>
  & ReturnType<typeof useToolState>
  & ReturnType<typeof useOperationState>
  & ReturnType<typeof useWorkspaceState>;

const EditorContext = createContext<EditorContextValue | null>(null);

export function EditorProvider({ children }: { children: ReactNode }) {
  const documentState = useDocument();
  const selectionState = useSelection();
  const toolState = useToolState();
  const operationState = useOperationState();
  const workspaceState = useWorkspaceState();

  const value: EditorContextValue = {
    ...documentState,
    ...selectionState,
    ...toolState,
    ...operationState,
    ...workspaceState,
  };

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) {
    throw new Error("useEditor must be used within <EditorProvider>");
  }
  return ctx;
}

export type { EditorContextValue };
