/**
 * EditableTextNode — Commit 5
 *
 * 单个可编辑文本节点组件。
 *
 * 特性：
 *   - 应用 FontMeta（font-family/size/weight/color/line-height）保持原字体保真度
 *   - 双击进入编辑模式（contentEditable）
 *   - 编辑完成 onBlur 触发 onChange，把新文本回传
 *   - 单击选中（选中态高亮）
 *   - 不选中时背景透明，hover 浅蓝
 *
 * 替代原 PDFCanvas 里的 textItems.map 渲染逻辑。
 */

import React, { useRef, useState, useEffect } from "react";
import type { Segment } from "./types";

/**
 * 根据屏幕坐标获取光标位置 Range。
 * - Chrome/Safari: document.caretRangeFromPoint(x, y) → Range
 * - Firefox: document.caretPositionFromPoint(x, y) → CaretPosition（需转换为 Range）
 * - 失败返回 null
 */
function getCaretRangeFromPoint(x: number, y: number): Range | null {
  // Chrome/Safari
  if (typeof document.caretRangeFromPoint === "function") {
    return document.caretRangeFromPoint(x, y);
  }
  // Firefox
  const docAny = document as any;
  if (typeof docAny.caretPositionFromPoint === "function") {
    const pos = docAny.caretPositionFromPoint(x, y);
    if (pos && pos.offsetNode) {
      const range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
      return range;
    }
  }
  return null;
}

interface EditableTextNodeProps {
  segment: Segment;
  isSelected: boolean;
  isEditing: boolean;
  onSelect: (id: string) => void;
  onStartEdit: (id: string) => void;
  onChange: (id: string, newText: string) => void;
  onEndEdit: () => void;
}

export function EditableTextNode({
  segment,
  isSelected,
  isEditing,
  onSelect,
  onStartEdit,
  onChange,
  onEndEdit,
}: EditableTextNodeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [localText, setLocalText] = useState(segment.text);
  const [isHovering, setIsHovering] = useState(false);
  // 记录双击坐标，用于进入编辑模式时定位光标到双击位置（而非选中全部或跑到最左）
  const doubleClickPosRef = useRef<{ x: number; y: number } | null>(null);

  // 同步外部 segment.text 变化（如 undo/redo）
  useEffect(() => {
    if (!isEditing) setLocalText(segment.text);
  }, [segment.text, isEditing]);

  // 进入编辑模式时聚焦 + 定位光标到双击位置
  useEffect(() => {
    if (!isEditing || !ref.current) return;
    ref.current.focus();

    const pos = doubleClickPosRef.current;
    doubleClickPosRef.current = null;

    // 优先用 caretRangeFromPoint 定位光标到双击位置（符合用户"双击哪里编辑哪里"的直觉）
    let caretPlaced = false;
    if (pos) {
      const range = getCaretRangeFromPoint(pos.x, pos.y);
      if (range && ref.current.contains(range.startContainer)) {
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        caretPlaced = true;
      }
    }

    // Fallback：光标放在文本末尾（不选中全部，避免光标跑到最左）
    if (!caretPlaced && ref.current.firstChild) {
      const range = document.createRange();
      range.selectNodeContents(ref.current);
      range.collapse(false); // false = 末尾
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [isEditing]);

  const handleBlur = () => {
    const newText = ref.current?.textContent || "";
    if (newText !== segment.text) {
      onChange(segment.id, newText);
    }
    onEndEdit();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ref.current?.blur();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setLocalText(segment.text); // 撤销编辑
      ref.current?.blur();
    }
  };

  const handleInput = () => {
    if (ref.current) {
      setLocalText(ref.current.textContent || "");
    }
  };

  const { font, cssX, cssY, cssW, cssH } = segment;

  // 重影修复策略：
  //   - PDF.js canvas 已渲染原始 PDF 文字（位图，最底层）
  //   - SEGMENTS LAYER 叠加在 canvas 上方
  //   - 未修改 segment：文字 + 背景全透明（看到底层 canvas 原文，避免重影）
  //   - 修改过的 segment（text !== originalText）：不透明文字 + 白色背景（覆盖 canvas 原文，显示修改后的文本）
  //   - hover：浅蓝背景提示（未修改时文字仍透明）
  //   - 选中：浅紫背景 + 紫色边框
  //   - 编辑：白色背景 + 不透明文字
  const isModified = segment.text !== segment.originalText;
  const showText = isEditing || isModified;
  const baseStyle: React.CSSProperties = {
    position: "absolute",
    left: cssX,
    top: cssY,
    minWidth: cssW,
    height: cssH,
    fontFamily: font.family,
    fontSize: font.size,
    fontWeight: font.weight,
    color: showText ? font.color : "transparent",
    lineHeight: font.lineHeight,
    padding: 0,
    margin: 0,
    border: isEditing
      ? "2px solid #8b5cf6"
      : isSelected
      ? "2px solid #8b5cf6"
      : isHovering
      ? "1px dashed rgba(59,130,246,0.4)"
      : "1px solid transparent",
    borderRadius: 2,
    outline: "none",
    whiteSpace: "nowrap",
    overflow: "visible",
    cursor: isEditing ? "text" : "pointer",
    background: isEditing
      ? "rgba(255,255,255,0.95)"
      : isModified
      ? "rgba(255,255,255,1)"
      : isSelected
      ? "rgba(139,92,246,0.1)"
      : isHovering
      ? "rgba(59,130,246,0.08)"
      : "transparent",
    transition: "background 0.15s, border 0.15s",
    pointerEvents: "auto",
    boxSizing: "border-box",
  };

  return (
    <div
      ref={ref}
      style={baseStyle}
      contentEditable={isEditing}
      suppressContentEditableWarning
      onClick={(e) => {
        e.stopPropagation();
        if (!isEditing) onSelect(segment.id);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        // 记录双击坐标，用于进入编辑模式后定位光标到双击位置
        doubleClickPosRef.current = { x: e.clientX, y: e.clientY };
        onStartEdit(segment.id);
      }}
      onMouseEnter={() => {
        if (!isEditing) setIsHovering(true);
      }}
      onMouseLeave={() => {
        setIsHovering(false);
      }}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onInput={handleInput}
    >
      {localText}
    </div>
  );
}
