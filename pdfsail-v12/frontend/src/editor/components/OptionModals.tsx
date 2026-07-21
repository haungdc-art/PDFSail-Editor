/**
 * OptionModals — Commit 2
 *
 * 所有工具选项模态 + 支付模态 + 处理 overlay + 签名 pad + 意图模态。
 * 从 PDFEditor.tsx L1296-1487 提取，共 191 行 JSX。
 *
 * State 全部来自 useEditor()，跨 domain 回调通过 props 注入：
 *   - addBlock / handleStripePay / handlePaypalPay / processInline
 */

import { useEditor } from "../core/EditorProvider";
import { Modal } from "./Modal";
import SignaturePad from "../SignaturePad";
import type { Block } from "../types";

interface OptionModalsProps {
  addBlock: (type: Block["type"], extra?: any) => void;
  handleStripePay: () => void;
  handlePaypalPay: () => void;
  processInline: (tool: string, extra?: any) => void;
}

function formatActionLabel(action: string): string {
  const map: Record<string, string> = {
    extract_tables: "Extract Tables",
    ocr_text: "OCR Text Recognition",
    convert_word: "Convert to Word",
    compress: "Compress PDF",
    edit: "Edit Document",
    convert: "Convert Format",
  };
  return (
    map[action] ||
    action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export function OptionModals({
  addBlock,
  handleStripePay,
  handlePaypalPay,
  processInline,
}: OptionModalsProps) {
  const {
    // signature
    showSignature,
    setShowSignature,
    // pay
    showPayModal,
    setShowPayModal,
    // intent
    showIntentModal,
    setShowIntentModal,
    textItems,
    setWsHints,
    setWsAction,
    generateLocalHints,
    // processing
    processingTool,
    processingLog,
    // compress
    showCompressOptions,
    setShowCompressOptions,
    compressQuality,
    setCompressQuality,
    // split
    showSplitOptions,
    setShowSplitOptions,
    splitMode,
    setSplitMode,
    splitRange,
    setSplitRange,
    totalPages,
    // rotate
    showRotateOptions,
    setShowRotateOptions,
    rotateDeg,
    setRotateDeg,
    rotateMode,
    setRotateMode,
    page,
    // pagenum
    showPageNumOptions,
    setShowPageNumOptions,
    pageNumOpts,
    setPageNumOpts,
  } = useEditor();

  return (
    <>
      {showSignature && (
        <SignaturePad
          onSave={(dataUrl) => {
            addBlock("signature", { w: 160, h: 80, dataUrl });
            setShowSignature(false);
          }}
          onCancel={() => setShowSignature(false)}
        />
      )}

      {showPayModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 12,
              padding: 28,
              width: 380,
              boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
            }}
          >
            <h3 style={{ margin: "0 0 8px", fontSize: 18, color: "#1e293b" }}>
              Free limit reached
            </h3>
            <p
              style={{
                margin: "0 0 20px",
                fontSize: 13,
                color: "#64748b",
              }}
            >
              You've used all 3 free exports today. Pay $1.99 to export this PDF.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button
                onClick={handleStripePay}
                style={{
                  padding: "12px 20px",
                  borderRadius: 8,
                  border: "none",
                  background: "#635bff",
                  color: "#fff",
                  cursor: "pointer",
                  fontSize: 14,
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                }}
              >
                💳 Pay with Card (Stripe)
              </button>
              <button
                onClick={handlePaypalPay}
                style={{
                  padding: "12px 20px",
                  borderRadius: 8,
                  border: "1px solid #e2e8f0",
                  background: "#fff",
                  color: "#1e293b",
                  cursor: "pointer",
                  fontSize: 14,
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                }}
              >
                <span style={{ color: "#0070ba", fontWeight: 700, fontSize: 16 }}>
                  PayPal
                </span>{" "}
                Pay with PayPal
              </button>
              <button
                onClick={() => setShowPayModal(false)}
                style={{
                  padding: "8px",
                  borderRadius: 6,
                  border: "none",
                  background: "transparent",
                  color: "#94a3b8",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Workspace Intent Modal ── */}
      {showIntentModal && (
        <Modal title="What are you trying to do?" onClose={() => setShowIntentModal(false)}>
          <p
            style={{
              fontSize: 12,
              color: "#64748b",
              margin: "0 0 16px",
              lineHeight: 1.5,
            }}
          >
            Setting your intent helps us suggest the most relevant next steps for
            your document.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              { key: "compress", label: "📦 Compress", desc: "Reduce file size" },
              { key: "edit", label: "✏️ Edit", desc: "Modify document content" },
              { key: "convert", label: "🔄 Convert", desc: "Change document format" },
              { key: "other", label: "📄 Other", desc: "Something else" },
            ].map((opt) => (
              <button
                key={opt.key}
                onClick={async () => {
                  setShowIntentModal(false);
                  await fetch(
                    `${import.meta.env.VITE_API_BASE || ""}/api/workspace/intent`,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        doc_id: crypto.randomUUID(),
                        intent: opt.key,
                      }),
                    }
                  ).catch(() => null);
                  const hints = generateLocalHints(textItems);
                  setWsHints(hints);
                  if (hints.length > 0) {
                    const h = hints[0];
                    setWsAction({
                      label: formatActionLabel(h.action),
                      action: h.action,
                      reason: h.text,
                    });
                  } else {
                    setWsAction({
                      label: opt.label,
                      action: opt.key,
                      reason: opt.desc,
                    });
                  }
                }}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  padding: "12px 16px",
                  borderRadius: 8,
                  border: "1px solid #e2e8f0",
                  background: "#f8fafc",
                  cursor: "pointer",
                  fontSize: 13,
                  textAlign: "left",
                }}
              >
                <span style={{ fontWeight: 600, color: "#1e293b" }}>{opt.label}</span>
                <span style={{ fontSize: 11, color: "#64748b" }}>{opt.desc}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {/* ── Processing Overlay ── */}
      {processingTool && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            backdropFilter: "blur(2px)",
          }}
        >
          <div
            style={{
              background: "#1a1a2e",
              borderRadius: 12,
              padding: 28,
              width: 460,
              maxHeight: "70vh",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  width: 20,
                  height: 20,
                  border: "2px solid #7c5cfc",
                  borderTopColor: "transparent",
                  borderRadius: "50%",
                  animation: "spin 0.6s linear infinite",
                }}
              />
              <span style={{ color: "#e0e0e0", fontSize: 16, fontWeight: 600 }}>
                Processing: {processingTool}
              </span>
            </div>
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                fontFamily: "monospace",
                fontSize: 12,
                color: "#b0b0b0",
                lineHeight: 1.6,
              }}
            >
              {processingLog.map((msg, i) => (
                <div
                  key={i}
                  style={{
                    color: msg.includes("✅")
                      ? "#4ade80"
                      : msg.includes("❌")
                      ? "#f87171"
                      : msg.includes("⚠")
                      ? "#facc15"
                      : msg.includes("Download")
                      ? "#7c5cfc"
                      : "#b0b0b0",
                  }}
                >
                  {msg}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Compress Options Modal ── */}
      {showCompressOptions && (
        <Modal title="Compress PDF" onClose={() => setShowCompressOptions(false)}>
          <label
            style={{
              fontSize: 12,
              color: "#64748b",
              display: "block",
              marginBottom: 4,
            }}
          >
            Image Quality: {compressQuality}%
          </label>
          <input
            type="range"
            min={10}
            max={100}
            value={compressQuality}
            onChange={(e) => setCompressQuality(Number(e.target.value))}
            style={{ width: "100%", marginBottom: 12 }}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 11,
              color: "#94a3b8",
              marginBottom: 16,
            }}
          >
            <span>Smaller size</span>
            <span>Better quality</span>
          </div>
          <div
            style={{
              fontSize: 12,
              color: "#64748b",
              lineHeight: 1.5,
              marginBottom: 16,
              padding: "8px 12px",
              background: "#f8fafc",
              borderRadius: 6,
            }}
          >
            Lower quality = smaller file size but possible image degradation.
            <br />
            Recommended: 40–70 for web, 70–90 for print.
          </div>
          <button
            onClick={() => {
              setShowCompressOptions(false);
              processInline("compress", { quality: compressQuality });
            }}
            style={{
              width: "100%",
              padding: "12px",
              border: "none",
              borderRadius: 8,
              background: "#7c5cfc",
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Compress
          </button>
        </Modal>
      )}

      {/* ── Split Options Modal ── */}
      {showSplitOptions && (
        <Modal title="Split PDF" onClose={() => setShowSplitOptions(false)}>
          <label
            style={{
              fontSize: 12,
              color: "#64748b",
              display: "block",
              marginBottom: 4,
            }}
          >
            Mode
          </label>
          <select
            value={splitMode}
            onChange={(e) => setSplitMode(e.target.value as any)}
            style={{
              width: "100%",
              padding: "8px 12px",
              borderRadius: 6,
              border: "1px solid #e2e8f0",
              fontSize: 13,
              marginBottom: 12,
            }}
          >
            <option value="all">All pages (one file per page)</option>
            <option value="range">Page range</option>
          </select>
          {splitMode === "range" && (
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <div>
                <label
                  style={{
                    fontSize: 11,
                    color: "#64748b",
                    display: "block",
                    marginBottom: 2,
                  }}
                >
                  From
                </label>
                <input
                  type="number"
                  min={1}
                  max={totalPages}
                  value={splitRange[0]}
                  onChange={(e) =>
                    setSplitRange([Math.max(1, Number(e.target.value)), splitRange[1]])
                  }
                  style={{
                    width: 80,
                    padding: "6px 8px",
                    borderRadius: 6,
                    border: "1px solid #e2e8f0",
                    fontSize: 13,
                  }}
                />
              </div>
              <div>
                <label
                  style={{
                    fontSize: 11,
                    color: "#64748b",
                    display: "block",
                    marginBottom: 2,
                  }}
                >
                  To
                </label>
                <input
                  type="number"
                  min={1}
                  max={totalPages}
                  value={splitRange[1]}
                  onChange={(e) =>
                    setSplitRange([
                      splitRange[0],
                      Math.min(totalPages, Number(e.target.value)),
                    ])
                  }
                  style={{
                    width: 80,
                    padding: "6px 8px",
                    borderRadius: 6,
                    border: "1px solid #e2e8f0",
                    fontSize: 13,
                  }}
                />
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "#94a3b8",
                  alignSelf: "flex-end",
                  paddingBottom: 6,
                }}
              >
                {totalPages} pages total
              </div>
            </div>
          )}
          <button
            onClick={() => {
              setShowSplitOptions(false);
              processInline("split", {
                mode: splitMode,
                range: splitMode === "range" ? splitRange : undefined,
              });
            }}
            style={{
              width: "100%",
              padding: "12px",
              border: "none",
              borderRadius: 8,
              background: "#7c5cfc",
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Split
          </button>
        </Modal>
      )}

      {/* ── Rotate Options Modal ── */}
      {showRotateOptions && (
        <Modal title="Rotate PDF" onClose={() => setShowRotateOptions(false)}>
          <label
            style={{
              fontSize: 12,
              color: "#64748b",
              display: "block",
              marginBottom: 4,
            }}
          >
            Angle
          </label>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {[90, 180, 270].map((d) => (
              <button
                key={d}
                onClick={() => setRotateDeg(d as any)}
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: 6,
                  border:
                    rotateDeg === d
                      ? "2px solid #7c5cfc"
                      : "1px solid #e2e8f0",
                  background: rotateDeg === d ? "#eff6ff" : "#fff",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: rotateDeg === d ? 700 : 500,
                }}
              >
                {d}°
              </button>
            ))}
          </div>
          <label
            style={{
              fontSize: 12,
              color: "#64748b",
              display: "block",
              marginBottom: 4,
            }}
          >
            Apply to
          </label>
          <select
            value={rotateMode}
            onChange={(e) => setRotateMode(e.target.value as any)}
            style={{
              width: "100%",
              padding: "8px 12px",
              borderRadius: 6,
              border: "1px solid #e2e8f0",
              fontSize: 13,
              marginBottom: 12,
            }}
          >
            <option value="all">All pages</option>
            <option value="current">Current page only</option>
          </select>
          <button
            onClick={() => {
              setShowRotateOptions(false);
              processInline("rotate", {
                degrees: rotateDeg,
                mode: rotateMode,
                pageIndex: page - 1,
              });
            }}
            style={{
              width: "100%",
              padding: "12px",
              border: "none",
              borderRadius: 8,
              background: "#7c5cfc",
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Rotate
          </button>
        </Modal>
      )}

      {/* ── Page Number Options Modal ── */}
      {showPageNumOptions && (
        <Modal title="Add Page Numbers" onClose={() => setShowPageNumOptions(false)}>
          <label
            style={{
              fontSize: 12,
              color: "#64748b",
              display: "block",
              marginBottom: 4,
            }}
          >
            Position
          </label>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {["top", "bottom"].map((p) => (
              <button
                key={p}
                onClick={() => setPageNumOpts((o) => ({ ...o, position: p as any }))}
                style={{
                  flex: 1,
                  padding: "8px",
                  borderRadius: 6,
                  border:
                    pageNumOpts.position === p
                      ? "2px solid #7c5cfc"
                      : "1px solid #e2e8f0",
                  background: pageNumOpts.position === p ? "#eff6ff" : "#fff",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: pageNumOpts.position === p ? 700 : 500,
                }}
              >
                {p === "top" ? "Top" : "Bottom"}
              </button>
            ))}
          </div>
          <label
            style={{
              fontSize: 12,
              color: "#64748b",
              display: "block",
              marginBottom: 4,
            }}
          >
            Alignment
          </label>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {["left", "center", "right"].map((a) => (
              <button
                key={a}
                onClick={() => setPageNumOpts((o) => ({ ...o, align: a as any }))}
                style={{
                  flex: 1,
                  padding: "8px",
                  borderRadius: 6,
                  border:
                    pageNumOpts.align === a
                      ? "2px solid #7c5cfc"
                      : "1px solid #e2e8f0",
                  background: pageNumOpts.align === a ? "#eff6ff" : "#fff",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: pageNumOpts.align === a ? 700 : 500,
                }}
              >
                {a.charAt(0).toUpperCase() + a.slice(1)}
              </button>
            ))}
          </div>
          <label
            style={{
              fontSize: 12,
              color: "#64748b",
              display: "block",
              marginBottom: 4,
            }}
          >
            Format
          </label>
          <input
            value={pageNumOpts.format}
            onChange={(e) =>
              setPageNumOpts((o) => ({ ...o, format: e.target.value }))
            }
            style={{
              width: "100%",
              padding: "8px 12px",
              borderRadius: 6,
              border: "1px solid #e2e8f0",
              fontSize: 13,
              marginBottom: 12,
            }}
          />
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label
                style={{
                  fontSize: 11,
                  color: "#64748b",
                  display: "block",
                  marginBottom: 2,
                }}
              >
                Start from
              </label>
              <input
                type="number"
                min={1}
                value={pageNumOpts.startFrom}
                onChange={(e) =>
                  setPageNumOpts((o) => ({
                    ...o,
                    startFrom: Math.max(1, Number(e.target.value)),
                  }))
                }
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: "1px solid #e2e8f0",
                  fontSize: 13,
                }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label
                style={{
                  fontSize: 11,
                  color: "#64748b",
                  display: "block",
                  marginBottom: 2,
                }}
              >
                Font size
              </label>
              <input
                type="number"
                min={6}
                max={72}
                value={pageNumOpts.fontSize}
                onChange={(e) =>
                  setPageNumOpts((o) => ({
                    ...o,
                    fontSize: Math.max(6, Number(e.target.value)),
                  }))
                }
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: "1px solid #e2e8f0",
                  fontSize: 13,
                }}
              />
            </div>
          </div>
          <button
            onClick={() => {
              setShowPageNumOptions(false);
              processInline("pagenum", { opts: pageNumOpts });
            }}
            style={{
              width: "100%",
              padding: "12px",
              border: "none",
              borderRadius: 8,
              background: "#7c5cfc",
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Add Numbers
          </button>
        </Modal>
      )}
    </>
  );
}
