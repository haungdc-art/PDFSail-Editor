/**
 * useToolState — Commit 1 / Step 4
 *
 * Toolbar 工具格式 + 工具开关 state。
 * 迁移后 Toolbar JSX 可直接从 useEditor() 拿全部工具状态，不再混杂业务 state。
 *
 * 注意：原 L88-99 "选中 block 时同步工具栏" 的 useEffect 跨 selection/tool 两个 domain，
 *      暂留在 PDFEditor.tsx 中（Commit 2 拆 Toolbar 组件时再处理）。
 */

import { useState } from "react";
import type {
  AddingType,
  AnnoFormat,
  HighlightFormat,
  TextFormat,
} from "../core/editorTypes";

export function useToolState() {
  const [textFormat, setTextFormat] = useState<TextFormat>({
    fontFamily: "'SimSun','Songti SC','Noto Serif CJK SC',serif",
    fontSize: 14,
    color: "#000000",
  });
  const [highlightFormat, setHighlightFormat] = useState<HighlightFormat>({
    type: "text",
    color: "#facc15",
    opacity: 40,
  });
  const [annoFormat, setAnnoFormat] = useState<AnnoFormat>({
    aType: "note",
    color: "#3b82f6",
  });
  const [showTools, setShowTools] = useState(false);
  const [showSignature, setShowSignature] = useState(false);
  const [addingType, setAddingType] = useState<AddingType>(null);
  // V12: Find & Replace 面板开关
  const [showFindReplace, setShowFindReplace] = useState(false);

  return {
    textFormat,
    setTextFormat,
    highlightFormat,
    setHighlightFormat,
    annoFormat,
    setAnnoFormat,
    showTools,
    setShowTools,
    showSignature,
    setShowSignature,
    addingType,
    setAddingType,
    showFindReplace,
    setShowFindReplace,
  };
}

export type UseToolState = ReturnType<typeof useToolState>;
