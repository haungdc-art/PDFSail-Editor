/**
 * EditModeToolbar — Bug 13
 *
 * Edit 模式下的浮出菜单，当某个 segment 正在编辑时显示在其上方：
 *   - ＋ 增大文本字号
 *   - − 减小文本字号
 *   - 🗑 删除整个编辑框（清空 segment 文本）
 *
 * 定位：通过 data-segment-id 查找正在编辑的 DOM 元素，获取其 boundingRect。
 */

import { useEffect, useState, useCallback } from "react";
import { useEditor } from "../core/EditorProvider";
import { useI18n } from "../../i18n/I18nProvider";

const FONT_SIZE_STEP = 2;
const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 72;

export function EditModeToolbar() {
  const {
    segments,
    setSegments,
    editingSegmentId,
    setEditingSegmentId,
    setBlocks,
    page,
  } = useEditor();
  const { t } = useI18n();
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);

  // 监听 editingSegmentId 变化 + 滚动/resize 时更新工具条位置
  const updatePosition = useCallback(() => {
    if (!editingSegmentId) {
      setRect(null);
      return;
    }
    const elem = document.querySelector(`[data-segment-id="${editingSegmentId}"]`) as HTMLElement | null;
    if (!elem) {
      setRect(null);
      return;
    }
    const r = elem.getBoundingClientRect();
    setRect({ left: r.left + r.width / 2, top: r.top, width: r.width });
  }, [editingSegmentId]);

  useEffect(() => {
    updatePosition();
    // 延迟再更新一次，等待 contentEditable 聚焦后高度可能变化
    const timer = setTimeout(updatePosition, 50);
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [editingSegmentId, updatePosition]);

  const editingSegment = segments.find((s) => s.id === editingSegmentId);

  const handleIncreaseFont = useCallback(() => {
    if (!editingSegment) return;
    const newSize = Math.min(FONT_SIZE_MAX, editingSegment.font.size + FONT_SIZE_STEP);
    setSegments((prev) => prev.map((s) =>
      s.id === editingSegment.id ? { ...s, font: { ...s.font, size: newSize } } : s
    ));
    // 同步到 docBlocks
    const blockId = `seg_block_${editingSegment.id}`;
    setBlocks((prev) => prev.map((b) =>
      b.id === blockId ? { ...b, fontSize: newSize } : b
    ));
    // 更新 DOM 元素的 font-size 以获得即时视觉反馈
    const elem = document.querySelector(`[data-segment-id="${editingSegment.id}"]`) as HTMLElement | null;
    if (elem) {
      elem.style.fontSize = `${newSize}px`;
    }
    // 重新定位工具条
    setTimeout(updatePosition, 10);
  }, [editingSegment, setSegments, setBlocks, updatePosition]);

  const handleDecreaseFont = useCallback(() => {
    if (!editingSegment) return;
    const newSize = Math.max(FONT_SIZE_MIN, editingSegment.font.size - FONT_SIZE_STEP);
    setSegments((prev) => prev.map((s) =>
      s.id === editingSegment.id ? { ...s, font: { ...s.font, size: newSize } } : s
    ));
    const blockId = `seg_block_${editingSegment.id}`;
    setBlocks((prev) => prev.map((b) =>
      b.id === blockId ? { ...b, fontSize: newSize } : b
    ));
    const elem = document.querySelector(`[data-segment-id="${editingSegment.id}"]`) as HTMLElement | null;
    if (elem) {
      elem.style.fontSize = `${newSize}px`;
    }
    setTimeout(updatePosition, 10);
  }, [editingSegment, setSegments, setBlocks, updatePosition]);

  const handleDelete = useCallback(() => {
    if (!editingSegment) return;
    // 清空 segment 文本
    setSegments((prev) => prev.map((s) =>
      s.id === editingSegment.id ? { ...s, text: "" } : s
    ));
    // 保留 docBlock 但清空 text：导出时需据此位置画白底遮罩覆盖原文，
    // 否则删除的文本仍会出现在导出 PDF / paywall 缩略图中
    const blockId = `seg_block_${editingSegment.id}`;
    setBlocks((prev) => {
      const existingIdx = prev.findIndex((b) => b.id === blockId);
      if (existingIdx >= 0) {
        return prev.map((b, i) => (i === existingIdx ? { ...b, text: "" } : b));
      }
      // 用户未编辑过该 segment 直接删除时，新建一个空文本 block 用于遮罩
      return [...prev, {
        id: blockId,
        type: "text" as const,
        page,
        x: editingSegment.cssX,
        y: editingSegment.cssY,
        w: editingSegment.cssW,
        h: editingSegment.cssH,
        text: "",
        fontSize: editingSegment.font.size,
        fontFamily: editingSegment.font.family,
        color: editingSegment.font.color,
      }];
    });
    // 退出编辑模式（针对当前 segment）
    setEditingSegmentId(null);
  }, [editingSegment, setSegments, setBlocks, setEditingSegmentId, page]);

  if (!editingSegmentId || !rect || !editingSegment) return null;

  return (
    <div
      style={{
        position: "fixed",
        left: rect.left,
        top: rect.top - 12,
        transform: "translate(-50%, -100%)",
        background: "#0e1422",
        border: "1px solid #2a2a4a",
        borderRadius: 10,
        boxShadow: "0 8px 32px rgba(0,0,0,0.45)",
        zIndex: 10000,
        padding: 6,
        display: "flex",
        alignItems: "center",
        gap: 4,
        fontSize: 12,
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {/* 当前字号显示 */}
      <span style={{
        color: "#94a3b8", fontSize: 11, padding: "0 6px",
        minWidth: 28, textAlign: "center",
      }}>
        {Math.round(editingSegment.font.size)}px
      </span>
      <div style={{ width: 1, height: 16, background: "#2a2a4a" }} />
      {/* ＋ 增大字号 */}
      <button
        onClick={handleIncreaseFont}
        title={t("editToolbar.increaseTip")}
        style={{
          padding: "4px 10px",
          background: "transparent",
          color: "#4ade80",
          border: "1px solid #2a2a4a",
          borderRadius: 4,
          cursor: "pointer",
          fontSize: 14,
          fontWeight: 700,
          whiteSpace: "nowrap",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.08)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        ＋
      </button>
      {/* − 减小字号 */}
      <button
        onClick={handleDecreaseFont}
        title={t("editToolbar.decreaseTip")}
        style={{
          padding: "4px 10px",
          background: "transparent",
          color: "#facc15",
          border: "1px solid #2a2a4a",
          borderRadius: 4,
          cursor: "pointer",
          fontSize: 14,
          fontWeight: 700,
          whiteSpace: "nowrap",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.08)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        −
      </button>
      <div style={{ width: 1, height: 16, background: "#2a2a4a" }} />
      {/* 🗑 删除编辑框 */}
      <button
        onClick={handleDelete}
        title={t("editToolbar.deleteTip")}
        style={{
          padding: "4px 8px",
          background: "transparent",
          color: "#ef4444",
          border: "1px solid #2a2a4a",
          borderRadius: 4,
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 600,
          whiteSpace: "nowrap",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.15)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        🗑
      </button>
    </div>
  );
}
