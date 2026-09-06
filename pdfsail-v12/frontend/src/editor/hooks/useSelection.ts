/**
 * useSelection — Commit 1 / Step 5  →  Commit 4 改造
 *
 * 核心编辑数据 + 选中状态 + Undo/Redo（基于 Command Pattern）。
 * 涉及 pdf.js 坐标（ocrSelect / editingBlock），风险较高。
 *
 * 包含：
 *   - docBlocks / textItems / showTextLayer / selectedBlockId / editingBlock / ocrSelect
 *   - historyRef (CommandHistory 实例，供 JSX 读取 canUndo/canRedo)
 *   - setBlocks wrapper (setDocBlocks + 同步 push PatchBlocksCommand)
 *   - handleUndo / handleRedo + Ctrl+Z 监听
 *
 * Commit 4 变更：
 *   - UndoRedo<Block[]> → CommandHistory + PatchBlocksCommand
 *   - setBlocks 去掉 setTimeout(pushUndo, 0) hack，改为在 updater 中捕获 prev/next，同步 push Command
 *   - undoRef 改名为 historyRef（保留 undoRef 别名向后兼容 MainToolbar 的 canUndo/canRedo 读取）
 *   - 新增 clearHistory() 用于 handleUpload 时清空历史
 *
 * 不包含：
 *   - "选中 block 同步工具栏" 的 useEffect（跨 tool domain，留在 PDFEditor.tsx）
 *   - drag/resize mousemove（Canvas 冻结区，Commit 2 才动）
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Block } from "../types";
import { CommandHistory, PatchBlocksCommand } from "../core/engine";
import type { Segment } from "../../editor-engine/types";
import type { EditingBlock } from "../core/editorTypes";

export function useSelection() {
  const [docBlocks, setDocBlocks] = useState<Block[]>([]);
  const [textItems, setTextItems] = useState<any[]>([]);
  const [showTextLayer, setShowTextLayer] = useState(false);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [editingBlock, setEditingBlock] = useState<EditingBlock | null>(null);
  const [ocrSelect, setOcrSelect] = useState<{
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null>(null);

  // ── Commit 5: Text Intelligence Layer（segments 替代原 textItems 渲染） ──
  const [segments, setSegments] = useState<Segment[]>([]);
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);

  // ── Document Action Panel: 当前选中的文本（Interaction Layer，不进入编辑核心） ──
  // Editor 只知道"选中了什么"，剩下的交给 Action Layer。
  const [selectedText, setSelectedText] = useState<string | null>(null);
  // 点击文字时解析出的"编辑意图"（等用户点 Update Text 才真正进入编辑）
  const [pendingEdit, setPendingEdit] = useState<{
    blockId: string;
    text: string;
    bbox: { x: number; y: number; width: number; height: number };
    fontSize: number;
    // M5-IMPLEMENT-002C-FIX: 字符级 target（从 onGlyphClick 的 info.glyph.lineId + info.index 忠实传递）
    lineId?: string;
    startGlyphIndex?: number;
    endGlyphIndex?: number;
  } | null>(null);
  // Update Text 保存后的反馈状态（B-2：保存后不"什么都不发生"）
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved">("idle");

  // M7.8-020-PROD：segment 编辑跨页持久化。
  // PDFEditor 每渲染一页都会 setSegments(该页新 segments) 整份替换，翻页会把上一页的编辑冲掉。
  // 这里按稳定 key 记录被改过的文本，重建 segments 后回放。
  const editedSegmentsRef = useRef<Map<string, string>>(new Map());

  // M7.8-041(M7.8-040R-3 导出跨页丢失)：跨页 segment 累积（导出专用）。
  // 全局 segments state 仍只保留当前页（供逐页 canvas 渲染，避免其它页 segment 串到当前页）。
  // 但每渲染一页把该页 segments 存入此 Map，导出时展开全部页 → 回写 EditableDocument。
  const segmentsByPageRef = useRef<Map<number, Segment[]>>(new Map());

  /** 稳定 key：lineId（含 pageIndex）+ 段首坐标 + 原文；重建后仍可匹配同一段 */
  const segEditKey = (s: Segment) =>
    `${s.lineId ?? ""}|${(s.pdfX ?? 0).toFixed(1)}|${(s.pdfY ?? 0).toFixed(1)}|${s.originalText ?? ""}`;

  /** 修改 segment 文本（编辑框 onBlur 时调用） */
  const handleSegmentChange = useCallback((id: string, newText: string) => {
    setSegments((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s;
        editedSegmentsRef.current.set(segEditKey(s), newText);
        return { ...s, text: newText };
      })
    );
  }, []);

  /** 新构建的 segments 回放已保存的编辑（翻页/重渲染后恢复） */
  const applySegmentEdits = useCallback((segs: Segment[]) => {
    const store = editedSegmentsRef.current;
    if (!store.size) return segs;
    return segs.map((s) => {
      const edited = store.get(segEditKey(s));
      return edited !== undefined && edited !== s.text ? { ...s, text: edited } : s;
    });
  }, []);

  /** 展开全部已渲染页的 segments（回放跨页编辑），供导出回写 EditableDocument。 */
  const getAllPageSegments = useCallback((): Segment[] => {
    const all: Segment[] = [];
    for (const segs of segmentsByPageRef.current.values()) {
      all.push(...applySegmentEdits(segs));
    }
    return all;
  }, [applySegmentEdits]);

  /** 清空已保存的 segment 编辑（新文档加载时调用） */
  const clearSegmentEdits = useCallback(() => {
    editedSegmentsRef.current.clear();
    segmentsByPageRef.current.clear();
  }, []);

  // ── CommandHistory（替代 UndoRedo） ──
  // 用 useState lazy init 保证实例稳定 + 类型不含 null（避免 useRef lazy init 的 `current: T | null` 陷阱）
  // CommandContext.setDocBlocks 直接用 React state setter（引用稳定）
  const [history] = useState(() => new CommandHistory({ setDocBlocks }));
  // 兼容旧 API：MainToolbar 通过 undoRef.canUndo/canRedo 读取状态（注意：是 instance，不是 ref）
  const undoRef = history;

  /**
   * setBlocks wrapper：包裹 setDocBlocks，同时 push PatchBlocksCommand 到 history。
   *
   * 实现细节：
   *   - 在 setDocBlocks 的 updater 里捕获 prev/next（updater 同步执行）
   *   - updater 返回后同步 push Command（不依赖 setTimeout / useEffect）
   *   - React 18 严格模式下 updater 双调用，holder.captured 会被覆盖为最终值，push 只发生一次
   *   - 用 holder 对象绕过 TypeScript 闭包 narrowing 限制
   *    （TS 不识别 updater 同步执行，认为 captured 永远是初始 null）
   *
   * 与原 UndoRedo 的差异：
   *   - 原实现用 setTimeout(pushUndo, 0)，依赖闭包里的 docBlocks（渲染时旧值），不可靠
   *   - 新实现直接在 updater 里拿 prev，无闭包陷阱
   */
  const setBlocks = useCallback(
    (fn: Block[] | ((prev: Block[]) => Block[])) => {
      const holder: { captured: { prev: Block[]; next: Block[] } | null } = { captured: null };
      setDocBlocks((prev) => {
        // 防御性过滤：移除可能的 null/undefined 条目
        const safePrev = Array.isArray(prev) ? prev.filter(Boolean) : [];
        const next = typeof fn === "function" ? (fn as (p: Block[]) => Block[])(safePrev) : fn;
        const safeNext = Array.isArray(next) ? next.filter(Boolean) : [];
        holder.captured = { prev: safePrev, next: safeNext };
        return safeNext;
      });
      if (holder.captured) {
        history.push(new PatchBlocksCommand(holder.captured.prev, holder.captured.next));
      }
    },
    []
  );

  // M4-IMPL-001 (Gate 6): New Replace 模式下禁用 Undo/Redo，阻止 "docBlocks 回退但 EditableDocument 未回退" 的撕裂。
  // 原因：New Replace 走 raw setDocBlocks（不进 CommandHistory），EditableDocument 由 New 路径管理，
  //       此刻 undo 回退 CommandHistory 里的 legacy 命令会制造双态不一致。
  // 仅读取 window.__replaceMode，不改造 CommandHistory / CommandContext；Legacy 模式行为完全不变。
  const replaceNewMode = () => typeof window !== "undefined" && (window as any).__replaceMode === "new";

  const handleUndo = useCallback(() => {
    if (replaceNewMode()) {
      console.warn("[M4] New Replace mode: Undo disabled (EditableDocument history not implemented)");
      return;
    }
    history.undo();
  }, []);

  const handleRedo = useCallback(() => {
    if (replaceNewMode()) {
      console.warn("[M4] New Replace mode: Redo disabled (EditableDocument history not implemented)");
      return;
    }
    history.redo();
  }, []);

  /** 清空 history（用于新文档加载 / handleUpload） */
  const clearHistory = useCallback(() => {
    history.clear();
  }, []);

  // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z 监听
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "y") {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [handleUndo, handleRedo]);

  return {
    // state
    docBlocks,
    textItems,
    showTextLayer,
    selectedBlockId,
    editingBlock,
    ocrSelect,
    // Commit 5: segments
    segments,
    editingSegmentId,
    // setters
    setDocBlocks,
    setTextItems,
    setShowTextLayer,
    setSelectedBlockId,
    setEditingBlock,
    setOcrSelect,
    setSegments,
    setEditingSegmentId,
    handleSegmentChange,
    // M7.8-020-PROD: 跨页编辑持久化
    applySegmentEdits,
    clearSegmentEdits,
    // M7.8-041: 跨页 segment 累积（导出专用）
    segmentsByPageRef,
    getAllPageSegments,
    // Document Action Panel
    selectedText,
    setSelectedText,
    pendingEdit,
    setPendingEdit,
    saveStatus,
    setSaveStatus,
    // undo/redo (Commit 4: CommandHistory — instance，不是 ref)
    undoRef,
    history,
    setBlocks,
    handleUndo,
    handleRedo,
    clearHistory,
  };
}

export type UseSelection = ReturnType<typeof useSelection>;
