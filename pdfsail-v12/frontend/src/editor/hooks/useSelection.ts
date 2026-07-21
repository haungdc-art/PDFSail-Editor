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

import { useCallback, useEffect, useState } from "react";
import type { Block } from "../types";
import { CommandHistory, PatchBlocksCommand } from "../core/engine";

export function useSelection() {
  const [docBlocks, setDocBlocks] = useState<Block[]>([]);
  const [textItems, setTextItems] = useState<any[]>([]);
  const [showTextLayer, setShowTextLayer] = useState(true);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [editingBlock, setEditingBlock] = useState<{
    id: string;
    text: string;
    x: number;
    y: number;
    w: number;
    h: number;
    fontSize: number;
  } | null>(null);
  const [ocrSelect, setOcrSelect] = useState<{
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null>(null);

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
        const next = typeof fn === "function" ? (fn as (p: Block[]) => Block[])(prev) : fn;
        holder.captured = { prev, next };
        return next;
      });
      if (holder.captured) {
        history.push(new PatchBlocksCommand(holder.captured.prev, holder.captured.next));
      }
    },
    []
  );

  const handleUndo = useCallback(() => {
    history.undo();
  }, []);

  const handleRedo = useCallback(() => {
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
    // setters
    setDocBlocks,
    setTextItems,
    setShowTextLayer,
    setSelectedBlockId,
    setEditingBlock,
    setOcrSelect,
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
