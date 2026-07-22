/**
 * PDFCanvas — Commit 2
 *
 * Canvas 冻结区：仅 JSX 提取，不改动 PDF.js + WASM 渲染逻辑。
 * 从 PDFEditor.tsx L675-968 提取。
 *
 * Ref 由 PDFEditorInner 持有并传入（render + drag/resize useEffect 仍在 PDFEditorInner）：
 *   canvasRef / wrapperRef / dragRef / resizeRef
 *
 * 跨 domain 回调通过 props 注入：
 *   addBlock / handleOCRRegion
 */

import { createPortal } from "react-dom";
import { v4 as uuid } from "uuid";
import type { RefObject } from "react";
import type { Block, TextBlock } from "../types";
import { useEditor } from "../core/EditorProvider";
import { EditableTextNode } from "../../editor-engine/EditableTextNode";

const navBtn: React.CSSProperties = {
  padding: "4px 10px",
  background: "rgba(0,0,0,0.55)",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
};

interface PDFCanvasProps {
  canvasRef: RefObject<HTMLCanvasElement>;
  wrapperRef: RefObject<HTMLDivElement>;
  dragRef: React.MutableRefObject<{ id: string; ox: number; oy: number; ox0: number; oy0: number } | null>;
  resizeRef: React.MutableRefObject<{ id: string; startX: number; startY: number; initW: number; initH: number } | null>;
  addBlock: (type: Block["type"], extra?: any) => void;
  handleOCRRegion: (x: number, y: number, w: number, h: number) => void;
}

export function PDFCanvas({
  canvasRef,
  wrapperRef,
  dragRef,
  resizeRef,
  addBlock,
  handleOCRRegion,
}: PDFCanvasProps) {
  const {
    pdfDoc,
    page,
    totalPages,
    setPage,
    addingType,
    setAddingType,
    ocrSelect,
    setOcrSelect,
    textItems,
    docBlocks,
    setDocBlocks,
    setSelectedBlockId,
    selectedBlockId,
    editingBlock,
    setEditingBlock,
    showTextLayer,
    highlightFormat,
    annoFormat,
    textFormat,
    setBlocks,
    // Commit 5: segments
    segments,
    editingSegmentId,
    setEditingSegmentId,
    handleSegmentChange,
  } = useEditor();

  // 过滤掉 seg_block_ 前缀的 block（它们是 segment 修改的镜像，只用于导出，不在画布上显示）
  const pageBlocks = docBlocks.filter((b) => b.page === page && !b.id.startsWith("seg_block_"));

  return (
    <>
      <div style={{ display: "flex", gap: 0, justifyContent: "center", width: "100%" }}>
        <div
          ref={wrapperRef}
          onClick={(e) => {
            setSelectedBlockId(null);
            if (!addingType || addingType === "ocr" || !wrapperRef.current) return;
            const rect = wrapperRef.current.getBoundingClientRect();
            setBlocks((prev) => [...prev, {
              id: uuid(), type: addingType, page,
              x: e.clientX - rect.left, y: e.clientY - rect.top,
              w: addingType === "image" ? 120 : 60,
              h: addingType === "image" ? 120 : 30,
              src: addingType === "image" ? "https://placehold.co/120x120" : undefined,
            } as Block]);
            setAddingType(null);
          }}
          onMouseDown={(e) => {
            if ((addingType !== "ocr" && addingType !== "highlight" && addingType !== "redact" && addingType !== "annotate") || !wrapperRef.current) return;
            const rect = wrapperRef.current.getBoundingClientRect();
            const startX = Math.max(0, e.clientX - rect.left);
            const startY = Math.max(0, e.clientY - rect.top);
            setOcrSelect({ startX, startY, endX: startX, endY: startY });
          }}
          onMouseMove={(e) => {
            if (!ocrSelect || !wrapperRef.current) return;
            const rect = wrapperRef.current.getBoundingClientRect();
            const maxW = wrapperRef.current.clientWidth;
            const maxH = wrapperRef.current.clientHeight;
            setOcrSelect((prev) => prev ? { ...prev, endX: Math.min(maxW, Math.max(0, e.clientX - rect.left)), endY: Math.min(maxH, Math.max(0, e.clientY - rect.top)) } : prev);
          }}
          onMouseUp={() => {
            if (!ocrSelect) return;
            const { startX, startY, endX, endY } = ocrSelect;
            const x = Math.min(startX, endX);
            const y = Math.min(startY, endY);
            const w = Math.abs(endX - startX);
            const h = Math.abs(endY - startY);
            setOcrSelect(null);
            if (addingType === "ocr") {
              setAddingType(null);
              handleOCRRegion(x, y, w, h);
            } else if (addingType === "highlight") {
              setAddingType(null);
              if (w > 10 && h > 10) {
                const selL = x, selR = x + w, selT = y, selB = y + h;
                const overlapping = textItems.filter((t) => {
                  const tl = t.x, tr = t.x + t.w, tt = t.y, tb = t.y + t.h;
                  return tl < selR && tr > selL && tt < selB && tb > selT;
                });
                if (overlapping.length > 0 && (highlightFormat.type === "underline" || highlightFormat.type === "strike" || highlightFormat.type === "wavy")) {
                  const midY = y + h / 2;
                  const onThisLine = overlapping.filter((t) => Math.abs(t.y + t.h / 2 - midY) < 10);
                  if (onThisLine.length > 0) {
                    const gx = Math.min(...onThisLine.map((i) => i.x));
                    const gy = Math.min(...onThisLine.map((i) => i.y));
                    const gx2 = Math.max(...onThisLine.map((i) => i.x + i.w));
                    const gy2 = Math.max(...onThisLine.map((i) => i.y + i.h));
                    addBlock("highlight", { x: gx, y: gy, w: gx2 - gx, h: gy2 - gy, hType: highlightFormat.type, color: highlightFormat.color, opacity: highlightFormat.opacity });
                  } else {
                    addBlock("highlight", { x, y, w, h, hType: highlightFormat.type, color: highlightFormat.color, opacity: highlightFormat.opacity });
                  }
                } else {
                  addBlock("highlight", { x, y, w, h, hType: highlightFormat.type, color: highlightFormat.color, opacity: highlightFormat.opacity });
                }
              }
            } else if (addingType === "redact") {
              setAddingType(null);
              if (w > 10 && h > 10) {
                addBlock("redact", { x, y, w, h });
              }
            } else if (addingType === "annotate") {
              setAddingType(null);
              if (w > 10 && h > 10) {
                addBlock("comment", { x, y, w, h, text: "Annotation", aType: annoFormat.aType, color: annoFormat.color });
              }
            }
          }}
          style={{
            position: "relative", background: "#fff", border: "1px solid #e2e8f0",
            borderRadius: 8, boxShadow: "0 1px 4px rgba(0,0,0,0.06)", overflow: "hidden",
            cursor: addingType ? "crosshair" : "default",
            aspectRatio: "210 / 297", maxWidth: 900, width: "100%",
          }}
        >
          {pdfDoc ? (
            <>
              {/* 1. PDF Canvas Layer（可缩放） */}
              <div className="pdf-canvas-layer">
                <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "auto" }} />
              </div>

              {/* 2. Interaction Layer（不缩放，1:1 px，pointer-events: none） */}
              <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, transform: "none", pointerEvents: "none" }}>
                {/* SEGMENTS LAYER — Commit 5: Text Intelligence Layer（标点切割 + 字体保真） */}
                {showTextLayer && segments.length > 0 && (
                  segments.map((seg) => (
                    <EditableTextNode
                      key={seg.id}
                      segment={seg}
                      isSelected={false}
                      isEditing={editingSegmentId === seg.id}
                      onSelect={() => setEditingSegmentId(null)}
                      onStartEdit={(id: string) => setEditingSegmentId(id)}
                      onChange={(id, newText) => {
                        // 1. 更新 segments state（即时视觉反馈）
                        handleSegmentChange(id, newText);
                        // 2. 同步到 docBlocks 作为 text block（跨页保留 + exportPDF 导出修改后内容）
                        //    用固定 blockId 便于 upsert，避免重复添加
                        const blockId = `seg_block_${id}`;
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
                            text: newText,
                            fontSize: seg.font.size,
                            fontFamily: seg.font.family,
                            color: seg.font.color,
                          };
                          if (existingIdx >= 0) {
                            return prev.map((b, i) => (i === existingIdx ? { ...b, text: newText } : b));
                          }
                          return [...prev, newBlock];
                        });
                      }}
                      onEndEdit={() => setEditingSegmentId(null)}
                    />
                  ))
                )}

                {/* TEXT LAYER — 仅显示预览，双击打开 Portal 编辑（segments 为空时 fallback） */}
                {showTextLayer && textItems.length > 0 && segments.length === 0 && (
                  textItems.map((t) => {
                    const existing = docBlocks.find((b): b is TextBlock => b.type === "text" && Math.abs(b.x - t.x) < 3 && Math.abs(b.y - t.y) < 3);
                    const displayText = existing?.text || t.text;
                    return (
                      <div
                        key={t.id}
                        onClick={() => {
                          if (addingType === "annotate") {
                            const bid = uuid();
                            addBlock("comment", { id: bid, text: t.text, x: t.x, y: t.y, w: t.w, h: t.h, aType: annoFormat.aType, color: annoFormat.color, anchor: { textId: t.id, offset: 0, length: t.text.length } });
                            setAddingType(null);
                          }
                        }}
                        onDoubleClick={() => {
                          if (addingType === "annotate") return;
                          const bid = existing?.id || uuid();
                          setEditingBlock({ id: bid, text: displayText, x: t.x, y: t.y, w: t.w, h: t.h, fontSize: t.fontSize * 0.92 });
                        }}
                        onMouseEnter={(e) => { if (document.activeElement !== e.currentTarget) e.currentTarget.style.background = "rgba(59,130,246,0.08)"; }}
                        onMouseLeave={(e) => { if (document.activeElement !== e.currentTarget) e.currentTarget.style.background = "transparent"; }}
                        onMouseDown={(e) => e.stopPropagation()}
                        style={{
                          position: "absolute",
                          left: t.x, top: t.y, width: "auto", minWidth: t.w, height: t.h,
                          fontSize: t.fontSize * 0.92, lineHeight: 1.3,
                          fontFamily: "'SimSun','Songti SC','Noto Serif CJK SC',serif",
                          outline: "none", border: "none", whiteSpace: "nowrap", overflow: "visible",
                          pointerEvents: "auto", cursor: "text",
                          color: "transparent", background: "transparent",
                          borderRadius: 1, transition: "background 0.15s",
                        }}
                      >
                        {t.text}
                      </div>
                    );
                  })
                )}

                {/* BLOCKS — 文本块双击打开 Portal 编辑，其他类型双击删除 */}
                {pageBlocks.map((b) => (
                  <div
                    key={b.id}
                    onClick={(e) => { e.stopPropagation(); setSelectedBlockId(b.id); }}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      dragRef.current = { id: b.id, ox: e.clientX, oy: e.clientY, ox0: b.x, oy0: b.y };
                    }}
                    onDoubleClick={(e) => {
                      if (b.type === "text") {
                        e.stopPropagation();
                        setEditingBlock({ id: b.id, text: b.text || "", x: b.x, y: b.y, w: b.w, h: b.h, fontSize: b.fontSize || Math.max(Math.min(b.h * 0.65, b.h - 6), 12) });
                      } else {
                        setBlocks((prev) => prev.filter((x) => x.id !== b.id));
                      }
                    }}
                    style={{
                      position: "absolute", left: b.x, top: b.y, width: b.w, height: b.h,
                      border: b.type === "highlight" && (b.hType === "underline" || b.hType === "strike" || b.hType === "wavy")
                        ? selectedBlockId === b.id ? "2px solid #8b5cf6" : "1px solid transparent"
                        : b.type === "highlight" ? `2px solid ${b.color || "#facc15"}`
                        : b.type === "redact" ? "2px solid #1e293b"
                        : b.type === "comment" ? "1px dashed #6366f1"
                        : b.type === "signature"
                        ? selectedBlockId === b.id ? "2px solid #8b5cf6" : "none"
                        : selectedBlockId === b.id ? "2px solid #8b5cf6" : "1px solid #3b82f6",
                      borderRadius: 4,
                      cursor: b.type === "text" ? "grab" : "move",
                      background: b.type === "highlight" && (b.hType === "underline" || b.hType === "strike" || b.hType === "wavy")
                        ? "transparent"
                        : b.type === "highlight" ? "rgba(250,204,21,0.25)"
                        : b.type === "comment" ? "rgba(99,102,241,0.06)"
                        : "rgba(59,130,246,0.04)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 12, overflow: "hidden", pointerEvents: "auto",
                    }}
                  >
                    {b.type === "text" && (
                      <span style={{
                        width: "100%", height: "100%", padding: 0,
                        fontSize: b.fontSize || Math.max(Math.min(b.h * 0.65, b.h - 6), 12),
                        lineHeight: 1.3,
                        fontFamily: b.fontFamily || "'SimSun','Songti SC','Noto Serif CJK SC',serif",
                        background: "#fff", whiteSpace: "nowrap", overflow: "visible",
                        color: b.color || "#000000",
                      }}>
                        {b.text}
                      </span>
                    )}
                    {b.type === "image" && b.src && (
                      <img src={b.src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 3 }} />
                    )}
                    {b.type === "signature" && b.dataUrl && (
                      <img src={b.dataUrl} alt="sig" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                    )}
                    {b.type === "highlight" && (() => {
                      const c = b.color || "#facc15";
                      const a = (b.opacity ?? 40) / 100;
                      const toRGBA = (hex: string, alpha: number) => {
                        const r = parseInt(hex.slice(1, 3), 16);
                        const g = parseInt(hex.slice(3, 5), 16);
                        const bl = parseInt(hex.slice(5, 7), 16);
                        return `rgba(${r},${g},${bl},${alpha})`;
                      };
                      const base = toRGBA(c, a);
                      const line = toRGBA(c, 0.9);
                      switch (b.hType) {
                        case "underline":
                          return <div style={{ width: "100%", height: "100%", position: "relative" }}><div style={{ position: "absolute", bottom: "20%", left: 0, right: 0, height: 2, background: line }} /></div>;
                        case "strike":
                          return <div style={{ width: "100%", height: "100%", position: "relative" }}><div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 2, background: line }} /></div>;
                        case "wavy":
                          return <div style={{ width: "100%", height: "100%", position: "relative" }}><div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 6, background: `linear-gradient(45deg, ${line} 25%, transparent 25%, transparent 50%, ${line} 50%, ${line} 75%, transparent 75%, transparent)`, backgroundSize: "8px 8px" }} /></div>;
                        case "freehand":
                        case "text":
                        default:
                          return <div style={{ width: "100%", height: "100%", background: base, borderRadius: 2 }} />;
                      }
                    })()}
                    {b.type === "redact" && <div style={{ width: "100%", height: "100%", background: "#000" }} />}
                    {b.type === "comment" && (() => {
                      const at = b.aType || "note";
                      const cc = b.color || "#3b82f6";
                      const toRGB = (hex: string, a: number) => {
                        const r = parseInt(hex.slice(1, 3), 16);
                        const g = parseInt(hex.slice(3, 5), 16);
                        const bl = parseInt(hex.slice(5, 7), 16);
                        return `rgba(${r},${g},${bl},${a})`;
                      };
                      if (at === "highlight") return <div style={{ width: "100%", height: "100%", background: toRGB(cc, 0.3), borderRadius: 3 }} />;
                      if (at === "strike") return <div style={{ width: "100%", height: "100%", position: "relative" }}><div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 2, background: cc }} /></div>;
                      if (at === "underline") return <div style={{ width: "100%", height: "100%", position: "relative" }}><div style={{ position: "absolute", bottom: "20%", left: 0, right: 0, height: 2, background: cc }} /></div>;
                      return <div style={{ width: "100%", height: "100%", padding: 6, fontSize: 12, color: cc, overflow: "hidden", display: "flex", alignItems: "flex-start", gap: 4 }}>📌 <span style={{ flex: 1 }}>{b.text}</span></div>;
                    })()}
                    {selectedBlockId === b.id && (
                      <div
                        onMouseDown={(e) => {
                          e.stopPropagation(); e.preventDefault();
                          resizeRef.current = { id: b.id, startX: e.clientX, startY: e.clientY, initW: b.w, initH: b.h };
                        }}
                        style={{
                          position: "absolute", right: -5, bottom: -5,
                          width: 12, height: 12, background: "#8b5cf6",
                          border: "2px solid #fff", borderRadius: 3,
                          cursor: "nwse-resize", pointerEvents: "auto", zIndex: 10,
                        }}
                      />
                    )}
                  </div>
                ))}

                {totalPages > 1 && (
                  <div style={{ position: "absolute", bottom: 12, left: 12, display: "flex", gap: 4, pointerEvents: "auto" }}>
                    <button onClick={() => setPage((p) => Math.max(1, p - 1))} style={{ ...navBtn, opacity: page === 1 ? 0.4 : 1 }}>◀</button>
                    <span style={{ padding: "4px 12px", background: "rgba(0,0,0,0.55)", color: "#fff", borderRadius: 4, fontSize: 12 }}>{page}/{totalPages}</span>
                    <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} style={{ ...navBtn, opacity: page === totalPages ? 0.4 : 1 }}>▶</button>
                  </div>
                )}
              </div>

              {/* 3. Portal root（编辑框脱离 transform） */}
              <div id="edit-portal-root" />
            </>
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#94a3b8", fontSize: 16, flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 40, opacity: 0.3 }}>📄</div>
              <div>Upload a PDF to start editing</div>
            </div>
          )}

          {ocrSelect && (() => {
            const x = Math.min(ocrSelect.startX, ocrSelect.endX);
            const y = Math.min(ocrSelect.startY, ocrSelect.endY);
            const w = Math.abs(ocrSelect.endX - ocrSelect.startX);
            const h = Math.abs(ocrSelect.endY - ocrSelect.startY);
            const mode = addingType === "highlight"
              ? { border: "#facc15", bg: "rgba(250,204,21,0.12)" }
              : addingType === "redact"
              ? { border: "#1e293b", bg: "rgba(30,41,59,0.15)" }
              : { border: "#8b5cf6", bg: "rgba(139,92,246,0.08)" };
            return <div style={{ position: "absolute", left: x, top: y, width: w, height: h, border: `2px dashed ${mode.border}`, background: mode.bg, pointerEvents: "none", zIndex: 999 }} />;
          })()}
        </div>

        {/* 右侧垂直分页条 */}
        {pdfDoc && totalPages > 1 && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, width: 36, flexShrink: 0, padding: "8px 0", alignSelf: "flex-start" }}>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              style={{
                width: 28, height: 28, borderRadius: 6, border: "1px solid #e2e8f0",
                background: page <= 1 ? "#f1f5f9" : "#fff",
                cursor: page <= 1 ? "not-allowed" : "pointer",
                fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center",
                padding: 0, opacity: page <= 1 ? 0.4 : 1, color: "#475569",
              }}
            >
              ▲
            </button>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#1e293b", writingMode: "vertical-lr", textOrientation: "mixed", letterSpacing: 4 }}>
              {page}/{totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              style={{
                width: 28, height: 28, borderRadius: 6, border: "1px solid #e2e8f0",
                background: page >= totalPages ? "#f1f5f9" : "#fff",
                cursor: page >= totalPages ? "not-allowed" : "pointer",
                fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center",
                padding: 0, opacity: page >= totalPages ? 0.4 : 1, color: "#475569",
              }}
            >
              ▼
            </button>
          </div>
        )}
      </div>

      {editingBlock && document.getElementById("edit-portal-root") && createPortal(
        <textarea
          autoFocus
          defaultValue={editingBlock.text}
          onBlur={(e) => {
            const val = e.currentTarget.value;
            setDocBlocks((prev) => {
              const existing = prev.find((b) => b.id === editingBlock.id);
              if (existing) return prev.map((b) => b.id === editingBlock.id ? { ...b, text: val, x: editingBlock.x, y: editingBlock.y, fontSize: editingBlock.fontSize, w: editingBlock.w, h: editingBlock.h } as Block : b);
              return [...prev, { id: editingBlock.id, type: "text", page, x: editingBlock.x, y: editingBlock.y, w: editingBlock.w, h: editingBlock.h, text: val, fontSize: editingBlock.fontSize }];
            });
            setEditingBlock(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") e.currentTarget.blur();
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); }
          }}
          style={{
            position: "absolute",
            left: editingBlock.x - 1,
            top: editingBlock.y - 1,
            width: editingBlock.w,
            height: editingBlock.h,
            fontSize: editingBlock.fontSize,
            lineHeight: 1.3,
            fontFamily: textFormat.fontFamily,
            color: textFormat.color,
            background: "#fff",
            border: "1px solid #3b82f6",
            borderRadius: 4,
            padding: 0,
            boxSizing: "content-box",
            resize: "none",
            overflow: "hidden",
            zIndex: 1000,
          }}
        />,
        document.getElementById("edit-portal-root")!
      )}
    </>
  );
}
