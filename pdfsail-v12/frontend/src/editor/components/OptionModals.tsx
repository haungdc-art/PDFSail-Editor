/**
 * OptionModals — Commit 2
 *
 * 所有工具选项模态 + 支付模态 + 处理 overlay + 签名 pad + 意图模态。
 * 从 PDFEditor.tsx L1296-1487 提取，共 191 行 JSX。
 *
 * State 全部来自 useEditor()，跨 domain 回调通过 props 注入：
 *   - addBlock / handleStripePay / handlePaypalPay / processInline
 */

import { useState } from "react";
import { useEditor } from "../core/EditorProvider";
import { Modal } from "./Modal";
import SignaturePad from "../SignaturePad";
import type { Block } from "../types";
import type { CompressQuality } from "../../compress/compress-core";
import { useI18n } from "../../i18n/I18nProvider";
import { uploadToR2AndRedirect } from "../utils/r2Redirect";

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
    // 完成弹框
    completionResult,
    setCompletionResult,
  } = useEditor();
  const { t } = useI18n();
  const [downloading, setDownloading] = useState(false);

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
              {t("modal.freeLimit")}
            </h3>
            <p
              style={{
                margin: "0 0 20px",
                fontSize: 13,
                color: "#64748b",
              }}
            >
              {t("modal.payHint")}
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
                💳 {t("modal.payCard")}
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
                {t("modal.payPaypal")}
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
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Workspace Intent Modal ── */}
      {showIntentModal && (
        <Modal title={t("modal.intentTitle")} onClose={() => setShowIntentModal(false)}>
          <p
            style={{
              fontSize: 12,
              color: "#64748b",
              margin: "0 0 16px",
              lineHeight: 1.5,
            }}
          >
            {t("modal.intentDesc")}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              { key: "compress", label: "📦 Compress", desc: t("modal.intentCompress") },
              { key: "edit", label: "✏️ Edit", desc: t("modal.intentEdit") },
              { key: "convert", label: "🔄 Convert", desc: t("modal.intentConvert") },
              { key: "other", label: "📄 Other", desc: t("modal.intentOther") },
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
                {t("modal.processing")}: {processingTool}
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
        <Modal title={t("modal.compressTitle")} onClose={() => setShowCompressOptions(false)}>
          {(() => {
            const levels: { id: CompressQuality; title: string; desc: string; accent: string; recommended?: boolean }[] = [
              { id: "printer", title: t("modal.compressLow"), desc: t("modal.compressLowDesc"), accent: "#38bdf8" },
              { id: "ebook", title: t("modal.compressMedium"), desc: t("modal.compressMediumDesc"), accent: "#a78bfa", recommended: true },
              { id: "screen", title: t("modal.compressHigh"), desc: t("modal.compressHighDesc"), accent: "#34d399" },
            ];
            return (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
                {levels.map((opt) => {
                  const selected = compressQuality === opt.id;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => setCompressQuality(opt.id)}
                      style={{
                        position: "relative",
                        textAlign: "left",
                        padding: "12px 10px",
                        borderRadius: 10,
                        border: selected ? `2px solid ${opt.accent}` : "2px solid #e2e8f0",
                        background: selected ? `${opt.accent}0d` : "#fff",
                        cursor: "pointer",
                        transition: "all 0.15s",
                      }}
                    >
                      {opt.recommended && (
                        <span style={{
                          position: "absolute", top: -8, right: 8,
                          fontSize: 9, fontWeight: 700, color: "#fff",
                          background: opt.accent, padding: "2px 6px", borderRadius: 999,
                        }}>
                          ★
                        </span>
                      )}
                      <div style={{ fontSize: 13, fontWeight: 700, color: selected ? opt.accent : "#1e293b", marginBottom: 2 }}>
                        {opt.title}
                      </div>
                      <div style={{ fontSize: 10, color: "#64748b", lineHeight: 1.4 }}>
                        {opt.desc}
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })()}
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
            {t("modal.compressHint")}
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
            {t("modal.compressBtn")}
          </button>
        </Modal>
      )}

      {/* ── Split Options Modal ── */}
      {showSplitOptions && (
        <Modal title={t("modal.splitTitle")} onClose={() => setShowSplitOptions(false)}>
          <label
            style={{
              fontSize: 12,
              color: "#64748b",
              display: "block",
              marginBottom: 4,
            }}
          >
            {t("modal.mode")}
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
            <option value="all">{t("modal.allPages")}</option>
            <option value="range">{t("modal.pageRange")}</option>
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
                  {t("modal.from")}
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
                  {t("modal.to")}
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
                {totalPages} {t("modal.pagesTotal")}
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
            {t("modal.splitBtn")}
          </button>
        </Modal>
      )}

      {/* ── Rotate Options Modal ── */}
      {showRotateOptions && (
        <Modal title={t("modal.rotateTitle")} onClose={() => setShowRotateOptions(false)}>
          <label
            style={{
              fontSize: 12,
              color: "#64748b",
              display: "block",
              marginBottom: 4,
            }}
          >
            {t("modal.angle")}
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
            {t("modal.applyTo")}
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
            <option value="all">{t("modal.allPages2")}</option>
            <option value="current">{t("modal.currentPage")}</option>
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
            {t("modal.rotateBtn")}
          </button>
        </Modal>
      )}

      {/* ── Page Number Options Modal ── */}
      {showPageNumOptions && (
        <Modal title={t("modal.pageNumTitle")} onClose={() => setShowPageNumOptions(false)}>
          <label
            style={{
              fontSize: 12,
              color: "#64748b",
              display: "block",
              marginBottom: 4,
            }}
          >
            {t("modal.position")}
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
                {p === "top" ? t("modal.top") : t("modal.bottom")}
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
            {t("modal.alignment")}
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
            {t("modal.format")}
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
                {t("modal.startFrom")}
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
                {t("modal.fontSize")}
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
            {t("modal.addNumbers")}
          </button>
        </Modal>
      )}

      {/* ── Completion Modal ── */}
      {completionResult && (
        <Modal title={t("modal.completionTitle")} onClose={() => !downloading && setCompletionResult(null)}>
          <div style={{ textAlign: "center", marginBottom: 16 }}>
            <div style={{
              width: 56, height: 56, borderRadius: "50%",
              background: "#dcfce7", margin: "0 auto 12px",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 28, color: "#16a34a",
            }}>
              ✓
            </div>
            <div style={{ fontSize: 14, color: "#1e293b", fontWeight: 600, marginBottom: 4 }}>
              {t("modal.completionReady")}
            </div>
            <div style={{ fontSize: 12, color: "#64748b" }}>{completionResult.info}</div>
          </div>

          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16,
            padding: "10px 12px", background: "#f8fafc", borderRadius: 8,
          }}>
            <div>
              <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 2 }}>{t("modal.completionFile")}</div>
              <div style={{ fontSize: 12, color: "#1e293b", fontWeight: 500, wordBreak: "break-all" }}>
                {completionResult.fileName}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 2 }}>{t("modal.completionSize")}</div>
              <div style={{ fontSize: 12, color: "#1e293b", fontWeight: 500 }}>
                {(completionResult.originalSize / 1024).toFixed(0)}KB
                {completionResult.resultSize !== completionResult.originalSize && (
                  <> → {(completionResult.resultSize / 1024).toFixed(0)}KB</>
                )}
              </div>
              {completionResult.savings !== undefined && completionResult.savings > 0 && (
                <div style={{ fontSize: 11, color: "#16a34a", fontWeight: 600 }}>
                  −{completionResult.savings}% saved
                </div>
              )}
            </div>
          </div>

          <div style={{
            fontSize: 11, color: "#64748b", lineHeight: 1.5, marginBottom: 16,
            padding: "8px 12px", background: "#fffbeb", borderRadius: 6, border: "1px solid #fef3c7",
          }}>
            {t("modal.completionHint")}
          </div>

          <button
            onClick={async () => {
              if (downloading) return;
              setDownloading(true);
              try {
                await uploadToR2AndRedirect(completionResult.blob, completionResult.fileName, completionResult.tool);
              } catch (e) {
                console.error("Download redirect failed:", e);
                setDownloading(false);
              }
            }}
            disabled={downloading}
            style={{
              width: "100%", padding: "12px", border: "none", borderRadius: 8,
              background: downloading ? "#94a3b8" : "linear-gradient(135deg,#10b981,#059669)",
              color: "#fff", fontSize: 14, fontWeight: 600, cursor: downloading ? "wait" : "pointer",
            }}
          >
            {downloading ? t("modal.completionUploading") : t("modal.completionDownload")}
          </button>
        </Modal>
      )}
    </>
  );
}
