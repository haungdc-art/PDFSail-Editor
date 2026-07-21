/**
 * useWorkspaceState — Commit 1 / Step 2
 *
 * Workspace 模式相关 state：意图识别、推荐动作、流程提示。
 * 不依赖 PDF 渲染 / 坐标 / blocks，最安全的迁移起点。
 *
 * 后续会通过 EditorProvider 与 useDocument / useOperation 互调：
 *   - useDocument.handleUpload 完成后触发 setShowIntentModal
 *   - useOperation.processInline 内读取 workspaceMode / 写入 wsActionsDone
 */

import { useCallback, useState } from "react";
import type {
  WorkspaceAction,
  WorkspaceHint,
} from "../core/editorTypes";

export function useWorkspaceState() {
  const [workspaceMode, setWorkspaceMode] = useState(false);
  const [showIntentModal, setShowIntentModal] = useState(false);
  const [wsAction, setWsAction] = useState<WorkspaceAction | null>(null);
  const [wsHints, setWsHints] = useState<WorkspaceHint[]>([]);
  const [wsActionsDone, setWsActionsDone] = useState<string[]>([]);
  const [wsShowFlow, setWsShowFlow] = useState(false);

  /**
   * 根据文本层 items 推断可能的后续动作（表格/财务/合同/扫描件）。
   * 纯函数，无副作用。
   */
  const generateLocalHints = useCallback((items: any[]): WorkspaceHint[] => {
    const hints: WorkspaceHint[] = [];
    const allText = items.map((t: any) => t.text || "").join(" ").toLowerCase();
    if (allText.includes("|") || allText.includes("table") || /\d{2,}%/.test(allText)) {
      hints.push({ type: "STRUCTURED_DATA", text: "Table-like content detected — extract", action: "extract_tables" });
    }
    if (["invoice", "amount", "total", "tax", "payment", "balance", "usd"].some((k) => allText.includes(k))) {
      hints.push({ type: "FINANCIAL", text: "Financial data found — ready for analysis", action: "extract_tables" });
    }
    if (["agreement", "contract", "party", "terms"].some((k) => allText.includes(k))) {
      hints.push({ type: "CONTRACT", text: "Contract terms detected — convert to editable", action: "convert_word" });
    }
    if (items.length < 10) {
      hints.push({ type: "SCANNED", text: "Scanned content — OCR available", action: "ocr_text" });
    }
    return hints.slice(0, 2);
  }, []);

  return {
    // state
    workspaceMode,
    showIntentModal,
    wsAction,
    wsHints,
    wsActionsDone,
    wsShowFlow,
    // setters
    setWorkspaceMode,
    setShowIntentModal,
    setWsAction,
    setWsHints,
    setWsActionsDone,
    setWsShowFlow,
    // helpers
    generateLocalHints,
  };
}

export type UseWorkspaceState = ReturnType<typeof useWorkspaceState>;
