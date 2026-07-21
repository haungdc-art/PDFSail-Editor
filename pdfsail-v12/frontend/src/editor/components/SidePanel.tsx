/**
 * SidePanel — Commit 2
 *
 * 右侧统一上下文面板：页面控制 / Workspace 推荐 / 工具选项 / Blocks 列表。
 * 从 PDFEditor.tsx L970-1167 提取。
 *
 * State 来自 useEditor()，跨 domain 回调通过 props 注入：
 *   handleAddBlankPage / handleDeletePage / handleMovePageUp /
 *   handleMovePageDown / updateSelectedFormat / processInline / handleExport
 */

import { useEditor } from "../core/EditorProvider";

interface SidePanelProps {
  handleAddBlankPage: () => void;
  handleDeletePage: () => void;
  handleMovePageUp: () => void;
  handleMovePageDown: () => void;
  updateSelectedFormat: (patch: Partial<{ fontFamily: string; fontSize: number; color: string }>) => void;
  processInline: (tool: string, extra?: any) => void;
  handleExport: () => void;
}

export function SidePanel({
  handleAddBlankPage,
  handleDeletePage,
  handleMovePageUp,
  handleMovePageDown,
  updateSelectedFormat,
  processInline,
  handleExport,
}: SidePanelProps) {
  const {
    pdfDoc,
    page,
    totalPages,
    workspaceMode,
    wsAction,
    wsActionsDone,
    wsHints,
    wsShowFlow,
    setProcessingTool,
    setProcessingLog,
    setShowPayModal,
    processingTool,
    addingType,
    selectedBlockId,
    textFormat,
    setTextFormat,
    highlightFormat,
    setHighlightFormat,
    annoFormat,
    setAnnoFormat,
    docBlocks,
    setBlocks,
  } = useEditor();

  if (!pdfDoc) return null;

  const pageBlocks = docBlocks.filter((b) => b.page === page);

  return (
    <div
      style={{
        width: 240,
        flexShrink: 0,
        borderLeft: "1px solid #e2e8f0",
        padding: 16,
        background: "#fafafa",
        fontSize: 12,
        color: "#475569",
        maxHeight: "calc(100vh - 80px)",
        overflowY: "auto",
      }}
    >
      {/* 页面控制 */}
      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            fontWeight: 700,
            marginBottom: 8,
            color: "#1e293b",
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          Page Controls
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
          <button
            onClick={handleAddBlankPage}
            title="Add blank page"
            style={{
              width: 28, height: 28, borderRadius: 4, border: "1px solid #e2e8f0",
              background: "#fff", cursor: "pointer", fontSize: 16,
              display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
            }}
          >
            +
          </button>
          <button
            onClick={handleDeletePage}
            title="Delete this page"
            disabled={totalPages <= 1}
            style={{
              width: 28, height: 28, borderRadius: 4, border: "1px solid #e2e8f0",
              background: totalPages <= 1 ? "#e2e8f0" : "#fff",
              cursor: totalPages <= 1 ? "not-allowed" : "pointer",
              opacity: totalPages <= 1 ? 0.5 : 1, fontSize: 16,
              display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
            }}
          >
            −
          </button>
          <span style={{ padding: "0 6px", fontWeight: 600, color: "#1e293b", fontSize: 13 }}>{totalPages}</span>
          <span style={{ fontSize: 11, color: "#94a3b8" }}>pages</span>
          <div style={{ width: 1, height: 20, background: "#e2e8f0", margin: "0 4px" }} />
          <button
            onClick={handleMovePageUp}
            title="Move page up"
            disabled={page <= 1}
            style={{
              width: 28, height: 28, borderRadius: 4, border: "1px solid #e2e8f0",
              background: page <= 1 ? "#e2e8f0" : "#fff",
              cursor: page <= 1 ? "not-allowed" : "pointer",
              opacity: page <= 1 ? 0.5 : 1, fontSize: 14,
              display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
            }}
          >
            ↑
          </button>
          <button
            onClick={handleMovePageDown}
            title="Move page down"
            disabled={page >= totalPages}
            style={{
              width: 28, height: 28, borderRadius: 4, border: "1px solid #e2e8f0",
              background: page >= totalPages ? "#e2e8f0" : "#fff",
              cursor: page >= totalPages ? "not-allowed" : "pointer",
              opacity: page >= totalPages ? 0.5 : 1, fontSize: 14,
              display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
            }}
          >
            ↓
          </button>
        </div>
        <div style={{ marginTop: 6, fontSize: 11, color: "#94a3b8" }}>Page {page} of {totalPages}</div>
      </div>

      {/* ── Workspace Section ── */}
      {workspaceMode && wsAction && (
        <div style={{ marginBottom: 16, padding: "12px", background: "#1a1a2e", borderRadius: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#7c5cfc", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
            {wsActionsDone.length === 0 ? "Recommended Action" : "Next Step"}
          </div>
          <div style={{ color: "#e0e0e0", fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{wsAction.label}</div>
          <div style={{ color: "#888", fontSize: 11, lineHeight: 1.4, marginBottom: 10 }}>{wsAction.reason}</div>
          <button
            onClick={() => processInline(wsAction.action)}
            disabled={processingTool !== null}
            style={{
              width: "100%", padding: "10px", border: "none", borderRadius: 6,
              background: "linear-gradient(135deg,#7c5cfc,#9f7aea)", color: "#fff",
              fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: processingTool ? 0.5 : 1,
            }}
          >
            Execute
          </button>
        </div>
      )}
      {workspaceMode && wsHints.length > 0 && wsActionsDone.length === 0 && !wsAction && (
        <div style={{ marginBottom: 12, padding: "8px 12px", background: "#0d0d1a", borderRadius: 8, fontSize: 11, color: "#b0b0b0" }}>
          <div style={{ fontWeight: 600, color: "#94a3b8", marginBottom: 4 }}>Detected</div>
          {wsHints.map((h, i) => <div key={i}>• {h.text}</div>)}
        </div>
      )}
      {workspaceMode && wsActionsDone.length > 0 && (
        <div style={{ marginBottom: 12, padding: "8px 12px", background: "#0d0d1a", borderRadius: 8, fontSize: 11 }}>
          <div style={{ color: "#4ade80", fontWeight: 600, marginBottom: 4 }}>✓ Completed ({wsActionsDone.length})</div>
          {wsActionsDone.map((a, i) => <div key={i} style={{ color: "#b0b0b0" }}>✔ {a}</div>)}
        </div>
      )}
      {workspaceMode && wsShowFlow && (
        <div style={{ marginBottom: 16, padding: "12px", background: "rgba(124,92,252,0.08)", borderRadius: 8, border: "1px solid rgba(124,92,252,0.2)" }}>
          <div style={{ color: "#c0b0e0", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>✔ Your document is ready</div>
          <div style={{ color: "#888", fontSize: 11, marginBottom: 10, lineHeight: 1.4 }}>Send directly or download?</div>
          <button
            onClick={() => {
              setProcessingTool("flow");
              setProcessingLog(["[Flow] Sending via email..."]);
              setTimeout(() => {
                setProcessingLog((p) => [...p, "[Flow] Paywall required"]);
                setProcessingTool(null);
                setShowPayModal(true);
              }, 1000);
            }}
            style={{
              width: "100%", padding: "8px", border: "none", borderRadius: 6,
              background: "#7c5cfc", color: "#fff", fontSize: 12, fontWeight: 600,
              cursor: "pointer", marginBottom: 4,
            }}
          >
            📧 Send via Email
          </button>
          <button
            onClick={() => { handleExport(); }}
            style={{
              width: "100%", padding: "8px", border: "1px solid #444", borderRadius: 6,
              background: "transparent", color: "#ccc", fontSize: 12, cursor: "pointer",
            }}
          >
            ⬇️ Download
          </button>
        </div>
      )}

      <div style={{ height: 1, background: "#e2e8f0", margin: "12px 0" }} />

      {/* 活跃工具选项 */}
      <div style={{ marginBottom: 16 }}>
        {!addingType && !selectedBlockId && pdfDoc && !workspaceMode && (
          <div style={{ color: "#94a3b8", fontSize: 11, lineHeight: 1.5 }}>
            Select a tool from the toolbar above, or click on text to edit it. Tool options will appear here.
          </div>
        )}

        {(!addingType || addingType === "text") && pdfDoc && (
          <div>
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#1e293b", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Text Style</div>
            <div style={{ marginBottom: 8 }}>
              <div style={{ marginBottom: 4, fontSize: 11, color: "#64748b" }}>Font</div>
              <select
                value={textFormat.fontFamily}
                onChange={(e) => { setTextFormat((p) => ({ ...p, fontFamily: e.target.value })); updateSelectedFormat({ fontFamily: e.target.value }); }}
                style={{ width: "100%", padding: "4px 8px", borderRadius: 4, border: "1px solid #e2e8f0", fontSize: 12 }}
              >
                <option value="'SimSun','Songti SC','Noto Serif CJK SC',serif">宋体</option>
                <option value="sans-serif">Sans-serif</option>
                <option value="monospace">Monospace</option>
                <option value="serif">Serif</option>
                <option value="'KaiTi','STKaiti','Noto Serif CJK SC',serif">楷体</option>
                <option value="'FangSong','STFangsong',serif">仿宋</option>
                <option value="'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif">微软雅黑</option>
              </select>
            </div>
            <div style={{ marginBottom: 8 }}>
              <div style={{ marginBottom: 4, fontSize: 11, color: "#64748b" }}>Size</div>
              <input
                type="number"
                value={textFormat.fontSize}
                onChange={(e) => {
                  const v = Math.max(8, Math.min(72, Number(e.target.value) || 14));
                  setTextFormat((p) => ({ ...p, fontSize: v }));
                  updateSelectedFormat({ fontSize: v });
                }}
                style={{ width: "100%", padding: "4px 8px", borderRadius: 4, border: "1px solid #e2e8f0", fontSize: 12 }}
                min={8}
                max={72}
              />
            </div>
            <div>
              <div style={{ marginBottom: 4, fontSize: 11, color: "#64748b" }}>Color</div>
              <input
                type="color"
                value={textFormat.color}
                onChange={(e) => { setTextFormat((p) => ({ ...p, color: e.target.value })); updateSelectedFormat({ color: e.target.value }); }}
                style={{ width: "100%", height: 32, padding: 0, border: "1px solid #e2e8f0", borderRadius: 4, cursor: "pointer" }}
              />
            </div>
          </div>
        )}

        {addingType === "highlight" && (
          <div>
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#1e293b", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Highlight Options</div>
            <div style={{ marginBottom: 8 }}>
              <div style={{ marginBottom: 4, fontSize: 11, color: "#64748b" }}>Type</div>
              <select
                value={highlightFormat.type}
                onChange={(e) => setHighlightFormat((p) => ({ ...p, type: e.target.value as any }))}
                style={{ width: "100%", padding: "4px 8px", borderRadius: 4, border: "1px solid #fde047", fontSize: 12 }}
              >
                <option value="text">Text</option>
                <option value="freehand">Freehand</option>
                <option value="underline">Underline</option>
                <option value="strike">Strike</option>
                <option value="wavy">Wavy</option>
              </select>
            </div>
            <div style={{ marginBottom: 8 }}>
              <div style={{ marginBottom: 4, fontSize: 11, color: "#64748b" }}>Color</div>
              <div style={{ display: "flex", gap: 4 }}>
                {["#facc15", "#f87171", "#4ade80", "#60a5fa", "#a78bfa"].map((c) => (
                  <button
                    key={c}
                    onClick={() => setHighlightFormat((p) => ({ ...p, color: c }))}
                    style={{
                      width: 24, height: 24, borderRadius: 12,
                      border: highlightFormat.color === c ? "2px solid #1e293b" : "1px solid #e2e8f0",
                      background: c, cursor: "pointer",
                    }}
                  />
                ))}
              </div>
            </div>
            <div>
              <div style={{ marginBottom: 4, fontSize: 11, color: "#64748b" }}>Opacity ({highlightFormat.opacity}%)</div>
              <input
                type="range"
                min={10}
                max={100}
                value={highlightFormat.opacity}
                onChange={(e) => setHighlightFormat((p) => ({ ...p, opacity: Number(e.target.value) }))}
                style={{ width: "100%" }}
              />
            </div>
          </div>
        )}

        {addingType === "annotate" && (
          <div>
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#1e293b", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Annotation Options</div>
            <div style={{ marginBottom: 8 }}>
              <div style={{ marginBottom: 4, fontSize: 11, color: "#64748b" }}>Type</div>
              <select
                value={annoFormat.aType}
                onChange={(e) => setAnnoFormat((p) => ({ ...p, aType: e.target.value as any }))}
                style={{ width: "100%", padding: "4px 8px", borderRadius: 4, border: "1px solid #bfdbfe", fontSize: 12 }}
              >
                <option value="note">📝 Note</option>
                <option value="highlight">🟡 Highlight</option>
                <option value="strike">~~ Strike</option>
                <option value="underline">_ Underline</option>
              </select>
            </div>
            <div style={{ marginBottom: 8 }}>
              <div style={{ marginBottom: 4, fontSize: 11, color: "#64748b" }}>Color</div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {["#3b82f6", "#facc15", "#f87171", "#4ade80", "#a78bfa", "#1e293b"].map((c) => (
                  <button
                    key={c}
                    onClick={() => setAnnoFormat((p) => ({ ...p, color: c }))}
                    style={{
                      width: 24, height: 24, borderRadius: 12,
                      border: annoFormat.color === c ? "2px solid #1e293b" : "1px solid #e2e8f0",
                      background: c, cursor: "pointer",
                    }}
                  />
                ))}
              </div>
            </div>
            <div style={{ color: "#94a3b8", fontSize: 11 }}>Click on text to annotate</div>
          </div>
        )}

        {addingType === "redact" && (
          <div>
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#1e293b", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Redact Options</div>
            <div style={{ color: "#64748b", fontSize: 11, lineHeight: 1.5 }}>
              Draw a rectangle over the content you want to permanently redact.
            </div>
          </div>
        )}

        {addingType === "ocr" && (
          <div>
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#1e293b", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>OCR Options</div>
            <div style={{ color: "#64748b", fontSize: 11, lineHeight: 1.5 }}>
              Select a region to run text recognition (OCR) on that area.
            </div>
          </div>
        )}
      </div>

      <div style={{ height: 1, background: "#e2e8f0", margin: "12px 0" }} />

      {/* Blocks 列表 */}
      <div>
        <div
          style={{
            fontWeight: 700, marginBottom: 8, color: "#1e293b", fontSize: 11,
            textTransform: "uppercase", letterSpacing: 0.5,
            display: "flex", alignItems: "center", justifyContent: "space-between",
          }}
        >
          <span>Blocks ({pageBlocks.length})</span>
          {pageBlocks.length > 0 && (
            <button
              onClick={() => setBlocks([])}
              style={{
                background: "none", border: "1px solid #fecaca", borderRadius: 4,
                color: "#ef4444", cursor: "pointer", fontSize: 10, padding: "2px 6px",
              }}
            >
              Clear All
            </button>
          )}
        </div>
        {pageBlocks.length === 0 && <div style={{ color: "#94a3b8", fontSize: 11 }}>No blocks on this page</div>}
        {pageBlocks.map((b) => (
          <div
            key={b.id}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "5px 8px", background: "#f8fafc", borderRadius: 4, marginBottom: 4, fontSize: 11,
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
              {b.type}{b.type === "text" && b.text ? `: "${b.text.slice(0, 20)}..."` : ""}
            </span>
            <button
              onClick={() => setBlocks((p) => p.filter((x) => x.id !== b.id))}
              style={{
                background: "none", border: "none", color: "#ef4444",
                cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1, marginLeft: 6,
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
