/**
 * useSelection — Commit 1 / Step 5  →  Commit 4 改造  →  F3B-6.23-C-Impl 改造
 *
 * 核心编辑数据 + 选中状态。
 * 涉及 pdf.js 坐标（ocrSelect / editingBlock），风险较高。
 *
 * 包含：
 *   - docBlocks / textItems / showTextLayer / selectedBlockId / editingBlock / ocrSelect
 *   - setBlocks wrapper（C-Impl-2：**纯** docBlocks 写入 —— docBlocks 不再拥有自己的历史）
 *   - handleUndo / handleRedo（C-Impl-1：canonical 请求转发 —— 路由在 PDFEditor 执行器）
 *   - undoRef（C-Impl-1：可用性快照，替代旧 CommandHistory 实例的 canUndo/canRedo 读取面）
 *
 * F3B-6.23-C-Impl 变更（History Boundary Cleanup）：
 *   - 删除 CommandHistory / PatchBlocksCommand / window Ctrl+Z 监听 /
 *     clearHistory —— docBlocks 独立 history 栈整体退出。
 *     docBlocks 回归「派生投影」：唯一 projection 路径 =
 *     PDFEditor undo/redo 执行器与 legacy mutation 后的 `renderToBlocks(...)` → `setDocBlocks`。
 *   - handleUndo/handleRedo 不再有任何本地 history 语义，只转发
 *     `requestUndo()/requestRedo()`（唯一入口；路由由 ownership 决定）。
 *   - undoRef 由实例改为只读可用性快照（{canUndo, canRedo, owner}），
 *     MainToolbar 的 `undoRef.canUndo/canRedo` 读取面不变。
 *   - 不再做 `__replaceMode` gate：其防护对象（CommandHistory 的 docBlocks-only 回退）
 *     已不存在；undo/redo 现在统一走 ownership 路由（Core / Legacy），
 *     且 Legacy 分支写 EditableDocument 后重投影 docBlocks ⇒ 结构上无撕裂面。
 *
 * 不包含：
 *   - "选中 block 同步工具栏" 的 useEffect（跨 tool domain，留在 PDFEditor.tsx）
 *   - drag/resize mousemove（Canvas 冻结区，Commit 2 才动）
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Block } from "../types";
import type { Segment } from "../../editor-engine/types";
import type { EditingBlock } from "../core/editorTypes";
import {
  requestRedo,
  requestUndo,
  subscribeUndoRedoAvailability,
  type UndoRedoAvailability,
} from "../features/undo-redo-request";
// F3B-6.4B-3：canonical commit 后的 reconciliation（纯函数，无 React 依赖）
import { reconcileSegmentEdit } from "../features/segmentCommit";
// F3B-6.28-F（第六刀阶段 2 · 路线 A）：segments 呈现态随 Core Document 同步（纯函数）
import { resyncSegmentsPresentationToCore } from "../features/segmentCorePresentationResync";
import type { EditorDocument } from "../core/document/types";

/**
 * 稳定 key：lineId（含 pageIndex）+ 段首坐标 + 原文；重建后仍可匹配同一段。
 *
 * F3B-6.4B-2：提升为模块级并导出，供 canonical commit 复用同一 Segment identity。
 * 纯函数、无闭包依赖，提升后行为不变。
 */
export function segEditKey(s: Segment): string {
  return `${s.lineId ?? ""}|${(s.pdfX ?? 0).toFixed(1)}|${(s.pdfY ?? 0).toFixed(1)}|${s.originalText ?? ""}`;
}

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
  // F3B-6.28-F：编排层（Core undo/redo）读取当前 segments 的同步 ref（每渲染对齐）
  const segmentsRef = useRef<Segment[]>([]);
  segmentsRef.current = segments;

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

  /**
   * F3B-6.28-F（第六刀阶段 2 · 路线 A）：segments 呈现态随 Core Document 重放同步。
   *
   * Core undo/redo 成功后由 PDFEditor 编排调用：`editedSegments` / `segments.text`
   * 跟随 Core 真值（fail-open），消除 ① segment-mask 滞留（undo 后行空白）
   * ② 翻页回放复活已撤销编辑。纯逻辑在 `segmentCorePresentationResync.ts`。
   */
  const resyncSegmentPresentationToCore = useCallback(
    (
      document: EditorDocument | null | undefined,
      originDocument?: EditorDocument | null,
      helpers?: {
        carriesWhole?: (segmentId: string, paragraphId: string) => boolean;
        sliceText?: (segmentId: string, paragraphId: string, paragraphText: string) => string | null;
      },
    ) => {
      const resync = (segs: Segment[]) =>
        resyncSegmentsPresentationToCore(segs, document, {
          keyOf: segEditKey,
          editedSegments: editedSegmentsRef.current,
          originDocument,
          carriesWhole: helpers?.carriesWhole,
          sliceText: helpers?.sliceText,
        });
      // 跨页快照（每页独立数组；含当前页 —— 双重处理幂等，第二次为同引用 no-op）
      let entriesTouched = 0;
      for (const [page, segs] of [...segmentsByPageRef.current]) {
        const r = resync(segs);
        entriesTouched += r.summary.entriesRemoved + r.summary.entriesUpdated;
        if (r.segments !== segs) segmentsByPageRef.current.set(page, r.segments);
      }
      const r = resync(segmentsRef.current);
      if (r.segments !== segmentsRef.current) setSegments(r.segments);
      return { ...r.summary, entriesTouched };
    },
    [setSegments],
  );

  /**
   * F3B-6.4B-3：canonical commit **成功**后调用 —— 把该 Segment 标记为已对账。
   *
   * 只有 mutation 真正成功才能 reconcile（见 segmentCommit.test.ts T17）：
   * 失败时必须继续保持 pending，让旧 export safety-net 仍有机会处理。
   *
   * Segment state 的真正 owner 仍在本 hook；这里只是调用纯函数做不可变更新，
   * 不产生第三套 Segment truth。
   */
  const reconcileSegmentCommit = useCallback((segmentId: string, newText: string) => {
    setSegments((prev) =>
      reconcileSegmentEdit(
        {
          segments: prev,
          editedSegments: editedSegmentsRef.current,
          segmentsByPage: segmentsByPageRef.current,
          keyOf: segEditKey,
        },
        segmentId,
        newText,
      ).segments,
    );
  }, []);

  // ── F3B-6.23-C-Impl-1：canonical Undo/Redo 请求 + 可用性快照 ──
  // handleUndo/handleRedo 只是请求转发；真正的路由（decideUndoRedoRoute →
  // Core EditorHistory / Legacy OperationHistory）在 PDFEditor 的唯一执行器里。
  const [undoRedoAvailability, setUndoRedoAvailability] =
    useState<UndoRedoAvailability>({ canUndo: false, canRedo: false, owner: null });
  useEffect(
    () =>
      subscribeUndoRedoAvailability((next) =>
        // 相等则保持引用，避免无谓的全 Context re-render
        setUndoRedoAvailability((prev) =>
          prev.canUndo === next.canUndo && prev.canRedo === next.canRedo && prev.owner === next.owner
            ? prev
            : next
        )
      ),
    []
  );
  // 兼容旧 API：MainToolbar 通过 undoRef.canUndo/canRedo 读取状态（现在是只读快照，不是实例）
  const undoRef = undoRedoAvailability;

  const handleUndo = useCallback(() => {
    requestUndo();
  }, []);

  const handleRedo = useCallback(() => {
    requestRedo();
  }, []);

  /**
   * C-Impl-2：**纯** docBlocks 写入 —— 不再 push 任何 Command。
   *
   * docBlocks 不再拥有自己的历史；「新建 docBlocks 快照进历史」的能力已随
   * CommandHistory 一并退出（C-Impl-3）。需要 undo 语义的操作必须走 canonical
   * 侧（Core Command / OperationHistory entry），undo 后由执行器经
   * `renderToBlocks(...)` → `setDocBlocks` 重投影（C0 裁决的 projection 路径）。
   */
  const setBlocks = useCallback(
    (fn: Block[] | ((prev: Block[]) => Block[])) => {
      setDocBlocks((prev) => {
        // 防御性过滤：移除可能的 null/undefined 条目
        const safePrev = Array.isArray(prev) ? prev.filter(Boolean) : [];
        const next = typeof fn === "function" ? (fn as (p: Block[]) => Block[])(safePrev) : fn;
        return Array.isArray(next) ? next.filter(Boolean) : next;
      });
    },
    []
  );

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
    // F3B-6.4B-3: canonical commit 后对账（reconciliation）
    reconcileSegmentCommit,
    // F3B-6.28-F（第六刀阶段 2）：Core undo/redo 后 segments 呈现态随 Core 真值同步
    resyncSegmentPresentationToCore,
    // Document Action Panel
    selectedText,
    setSelectedText,
    pendingEdit,
    setPendingEdit,
    saveStatus,
    setSaveStatus,
    // undo/redo（F3B-6.23-C-Impl：canonical 请求转发 + 可用性快照）
    undoRef,
    setBlocks,
    handleUndo,
    handleRedo,
  };
}

export type UseSelection = ReturnType<typeof useSelection>;
