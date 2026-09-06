/**
 * FloatingToolbar — V12
 *
 * 当用户在 segment 上选中文字时，浮出菜单出现在选区上方：
 *   - Replace：展开输入框，回车替换选中文本
 *   - Delete：一键删除选中文字
 *   - Rewrite：调用 /api/llm/rewrite 让 AI 润色后替换
 *   - Translate：调用 /api/llm/translate 翻译后替换
 *
 * 实现：监听 document mouseup，检查 window.getSelection() 是否在
 * 带 data-segment-id 的元素内；若是，渲染工具条在选区上方。
 *
 * 替换通过 handleSegmentChange(segmentId, newText) 写回，
 * 同步在 PDFCanvas 中作为 seg_block_* 镜像到 docBlocks 供导出。
 */

import { useEffect, useState, useRef, useCallback } from "react";
import { useEditor } from "../core/EditorProvider";
import { useI18n } from "../../i18n/I18nProvider";
// Task-011B: EditTool 依赖注入（Strangler 双路径，Toolbar 只调 execute，保留 legacy）
import type { EditTool } from "../../document-model/edit-tool";

const API_BASE = import.meta.env.VITE_API_BASE || "";

/**
 * M4-IMPL-001: Replace Runtime Cutover —— New / Legacy 严格 XOR 开关。
 * 读 window.__replaceMode：
 *   - 默认（undefined / 非 "new"）→ legacy：Replace 走 segments/docBlocks/CommandHistory
 *   - "new" → New：Replace 走 ReplaceCommand → EditableDocument → renderToBlocks
 * 运行时读取（无需重新编译），支持 Gate 4 的运行时切换。
 */
function isNewReplaceMode(): boolean {
  return typeof window !== "undefined" && (window as any).__replaceMode === "new";
}

interface SelectionInfo {
  segmentId: string;
  selectedText: string;
  rect: { left: number; top: number; width: number; height: number };
  // 选区在 segment 文本中的起止字符偏移
  startOffset: number;
  endOffset: number;
  // segment 全文（用于替换时拼接）
  fullText: string;
}

type ActionPhase = "idle" | "rewriting" | "translating";

export function FloatingToolbar({ editTool }: { editTool: EditTool }) {
  const { segments, handleSegmentChange, setBlocks, page } = useEditor();
  const { t } = useI18n();
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [replaceInput, setReplaceInput] = useState("");
  const [showReplaceInput, setShowReplaceInput] = useState(false);
  const [phase, setPhase] = useState<ActionPhase>("idle");
  const toolbarRef = useRef<HTMLDivElement>(null);

  // 监听全局 mouseup，检测 segment 内的文本选区
  useEffect(() => {
    const handleMouseUp = (e: MouseEvent) => {
      // 点击工具条本身时不丢失选区
      if (toolbarRef.current?.contains(e.target as Node)) return;

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        // 延迟清空，避免 click 处理时选区已被清空
        setTimeout(() => {
          setSelection(null);
          setShowReplaceInput(false);
        }, 50);
        return;
      }

      const range = sel.getRangeAt(0);
      const container = range.commonAncestorContainer;
      // 找到包含选区的 segment 元素
      let elem: HTMLElement | null = container.nodeType === Node.ELEMENT_NODE
        ? (container as HTMLElement)
        : container.parentElement;
      let segmentElem: HTMLElement | null = null;
      while (elem) {
        if (elem.dataset?.segmentId) {
          segmentElem = elem;
          break;
        }
        elem = elem.parentElement;
      }

      if (!segmentElem) {
        setSelection(null);
        setShowReplaceInput(false);
        return;
      }

      const segmentId = segmentElem.dataset.segmentId!;
      const segment = segments.find((s) => s.id === segmentId);
      if (!segment) return;

      const selectedText = sel.toString();
      if (!selectedText) {
        setSelection(null);
        setShowReplaceInput(false);
        return;
      }

      // 计算字符偏移（基于 segment 文本节点）
      const fullText = segment.text;
      let startOffset = -1;
      let endOffset = -1;
      try {
        // 遍历 segment 元素内的文本节点，累加长度直到找到选区起止
        const walker = document.createTreeWalker(segmentElem, NodeFilter.SHOW_TEXT);
        let charCount = 0;
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const textNode = node as Text;
          const nodeLen = textNode.length;
          if (textNode === range.startContainer) {
            startOffset = charCount + range.startOffset;
          }
          if (textNode === range.endContainer) {
            endOffset = charCount + range.endOffset;
            break;
          }
          charCount += nodeLen;
        }
      } catch (err) {
        // 字符偏移计算失败，fallback 用 indexOf
        const idx = fullText.indexOf(selectedText);
        if (idx >= 0) {
          startOffset = idx;
          endOffset = idx + selectedText.length;
        }
      }

      if (startOffset < 0 || endOffset < 0) {
        const idx = fullText.indexOf(selectedText);
        if (idx >= 0) {
          startOffset = idx;
          endOffset = idx + selectedText.length;
        } else {
          // 找不到位置，放弃
          return;
        }
      }

      const rect = range.getBoundingClientRect();
      setSelection({
        segmentId,
        selectedText,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        startOffset,
        endOffset,
        fullText,
      });
      setReplaceInput(selectedText);
      setShowReplaceInput(false);
    };

    document.addEventListener("mouseup", handleMouseUp);
    return () => document.removeEventListener("mouseup", handleMouseUp);
  }, [segments]);

  // ESC 关闭
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelection(null);
        setShowReplaceInput(false);
        window.getSelection()?.removeAllRanges();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // 应用文本替换到 segment
  const applyReplace = useCallback((newText: string) => {
    if (!selection) return;

    // ── M4-IMPL-001: Replace Runtime Cutover —— New / Legacy 严格 XOR ──
    // New 模式：仅走 ReplaceCommand → EditableDocument → renderToBlocks → docBlocks。
    //   绝不执行 legacy 段（handleSegmentChange / setBlocks / PatchBlocksCommand），避免双写。
    if (isNewReplaceMode()) {
      void editTool.execute({ capability: "replace", payload: { text: newText } });
      setSelection(null);
      setShowReplaceInput(false);
      window.getSelection()?.removeAllRanges();
      return;
    }

    // ── Legacy 模式（默认）：保持现状，仅走 segments/docBlocks/CommandHistory ──
    const { segmentId, fullText, startOffset, endOffset } = selection;
    const updated = fullText.slice(0, startOffset) + newText + fullText.slice(endOffset);
    handleSegmentChange(segmentId, updated);
    // 同步到 docBlocks（与 PDFCanvas 中 EditableTextNode.onChange 一致）
    const blockId = `seg_block_${segmentId}`;
    const seg = segments.find((s) => s.id === segmentId);
    if (seg) {
      setBlocks((prev) => {
        const existingIdx = prev.findIndex((b) => b.id === blockId);
        const newBlock = {
          id: blockId,
          type: "text" as const,
          page,
          x: seg.cssX,
          y: seg.cssY,
          w: seg.cssW,
          h: seg.cssH,
          text: updated,
          fontSize: seg.font.size,
          fontFamily: seg.font.family,
          color: seg.font.color,
        };
        if (existingIdx >= 0) {
          return prev.map((b, i) => (i === existingIdx ? { ...b, text: updated } : b));
        }
        return [...prev, newBlock];
      });
    }
    setSelection(null);
    setShowReplaceInput(false);
    window.getSelection()?.removeAllRanges();
  }, [selection, segments, handleSegmentChange, setBlocks, page, editTool]);

  const handleReplaceSubmit = () => {
    if (!selection) return;
    if (!replaceInput.trim()) return;
    applyReplace(replaceInput);
  };

  const handleDelete = () => {
    if (!selection) return;
    applyReplace("");
  };

  const handleRewrite = async () => {
    if (!selection) return;
    // M4-IMPL-001: 仅 New 模式执行 RewriteCommand 预写入；Legacy 模式跳过（避免与最终 applyReplace 双写）。
    if (isNewReplaceMode()) {
      void editTool.execute({ capability: "rewrite", payload: { text: selection.selectedText, task: "rewrite" } });
    }
    setPhase("rewriting");
    try {
      const res = await fetch(`${API_BASE}/api/llm/rewrite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: selection.selectedText }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rewritten = data.rewritten || data.text || data.result;
      if (rewritten) {
        applyReplace(rewritten);
      } else {
        alert("Rewrite returned empty result.");
      }
    } catch (err: any) {
      alert(`Rewrite failed: ${err.message}`);
    } finally {
      setPhase("idle");
    }
  };

  const handleTranslate = async () => {
    if (!selection) return;
    // M4-IMPL-001: 仅 New 模式执行预写入；Legacy 模式跳过（避免与最终 applyReplace 双写）。
    if (isNewReplaceMode()) {
      void editTool.execute({ capability: "rewrite", payload: { text: selection.selectedText, task: "translate" } });
    }
    setPhase("translating");
    try {
      const res = await fetch(`${API_BASE}/api/llm/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: selection.selectedText,
          targetLang: "zh",  // 默认译成中文；可扩展为弹窗选择
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const translated = data.translated || data.text || data.result;
      if (translated) {
        applyReplace(translated);
      } else {
        alert("Translation returned empty result.");
      }
    } catch (err: any) {
      alert(`Translation failed: ${err.message}`);
    } finally {
      setPhase("idle");
    }
  };

  if (!selection) return null;

  // 工具条位置：选区上方居中
  const toolbarLeft = selection.rect.left + selection.rect.width / 2;
  const toolbarTop = selection.rect.top - 10;

  return (
    <div
      ref={toolbarRef}
      // onMouseDown preventDefault 防止点击工具条时丢失选区
      onMouseDown={(e) => e.preventDefault()}
      style={{
        position: "fixed",
        left: toolbarLeft,
        top: toolbarTop,
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
    >
      {phase !== "idle" && (
        <div style={{
          padding: "6px 12px", color: "#8ab4f8", fontSize: 12,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <div style={{
            width: 12, height: 12,
            border: "2px solid #8ab4f8", borderTopColor: "transparent",
            borderRadius: "50%", animation: "spin 0.6s linear infinite",
          }} />
          {phase === "rewriting" ? t("float.rewriting") : t("float.translating")}
        </div>
      )}

      {phase === "idle" && !showReplaceInput && (
        <>
          <span style={{
            color: "#94a3b8", fontSize: 11, padding: "0 6px",
            maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            "{selection.selectedText.slice(0, 30)}{selection.selectedText.length > 30 ? "…" : ""}"
          </span>
          <ToolbarBtn onClick={() => setShowReplaceInput(true)} title={t("float.replaceTip")}>
            {t("float.replace")}
          </ToolbarBtn>
          <ToolbarBtn onClick={handleDelete} title={t("float.deleteTip")} color="#ef4444">
            {t("float.delete")}
          </ToolbarBtn>
          <ToolbarBtn onClick={handleRewrite} title={t("float.rewriteTip")} color="#8ab4f8">
            {t("float.rewrite")}
          </ToolbarBtn>
          <ToolbarBtn onClick={handleTranslate} title={t("float.translateTip")} color="#b4a0f8">
            {t("float.translate")}
          </ToolbarBtn>
        </>
      )}

      {phase === "idle" && showReplaceInput && (
        <>
          <input
            autoFocus
            type="text"
            value={replaceInput}
            onChange={(e) => setReplaceInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); handleReplaceSubmit(); }
              if (e.key === "Escape") { setShowReplaceInput(false); }
            }}
            placeholder={t("float.typeReplacement")}
            style={{
              padding: "4px 8px", fontSize: 12, width: 180,
              background: "#0f0f23", color: "#e0e0e0",
              border: "1px solid #2a2a4a", borderRadius: 4,
              outline: "none", boxSizing: "border-box",
            }}
          />
          <ToolbarBtn onClick={handleReplaceSubmit} title={t("float.applyTip")} color="#10b981">
            {t("float.apply")}
          </ToolbarBtn>
          <ToolbarBtn onClick={() => setShowReplaceInput(false)} title={t("float.cancelTip")}>
            {t("float.cancel")}
          </ToolbarBtn>
        </>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function ToolbarBtn({
  children, onClick, title, color = "#e0e0e0",
}: { children: React.ReactNode; onClick: () => void; title: string; color?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        padding: "4px 8px",
        background: "transparent",
        color,
        border: "1px solid #2a2a4a",
        borderRadius: 4,
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.08)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
    >
      {children}
    </button>
  );
}
