/**
 * OcrResultPage — /ocr-result/:taskId
 *
 * OCR 完成后的结果页：
 *   - 显示"Your scanned PDF is ready"
 *   - 列出三个完成项（Text recognized / Searchable PDF / Editable content）
 *   - 主按钮"Edit PDF" → 把 PDF blob + ocr_task_id 写入 sessionStorage/IndexedDB → 跳转 /editor
 *   - 次要链接"Upload another PDF" → 返回 /ocr-pdf
 */

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useI18n } from "../i18n/I18nProvider";
import { getOcrTask, getOcrResult, type OcrTask, type OcrResult } from "./ocr-storage";

type Phase = "loading" | "ready" | "error";

export default function OcrResultPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { taskId } = useParams<{ taskId: string }>();
  const [phase, setPhase] = useState<Phase>("loading");
  const [task, setTask] = useState<OcrTask | null>(null);
  const [result, setResult] = useState<OcrResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (!taskId) return;
    (async () => {
      try {
        const tsk = await getOcrTask(taskId);
        if (!tsk) {
          setErrorMsg("Task not found");
          setPhase("error");
          return;
        }
        const res = await getOcrResult(taskId);
        if (!res) {
          setErrorMsg("OCR result not found");
          setPhase("error");
          return;
        }
        setTask(tsk);
        setResult(res);
        setPhase("ready");
      } catch (err: any) {
        setErrorMsg(err?.message || "Unknown error");
        setPhase("error");
      }
    })();
  }, [taskId]);

  const openEditor = async () => {
    if (!task || !taskId || opening) return;
    setOpening(true);
    try {
      // 写入 IndexedDB（与 HomePage 逻辑一致，编辑器会自动读取）
      const { savePendingPdf } = await import("../lib/indexedDB");
      await savePendingPdf({
        blob: task.blob,
        fileName: task.fileName,
        blockCount: result?.blocks.length || 0,
      });
      // 标记来自 OCR 流程，编辑器据此自动注入 OCR blocks + 显示首次引导
      sessionStorage.setItem(
        "pdfaide_pending_pdf",
        JSON.stringify({ name: task.fileName, useIndexedDB: true })
      );
      sessionStorage.setItem("pdfaide_ocr_task_id", taskId);
      navigate("/editor");
    } catch (err: any) {
      console.error("[OcrResultPage] openEditor failed:", err);
      setErrorMsg(err?.message || "Failed to open editor");
      setPhase("error");
      setOpening(false);
    }
  };

  if (phase === "loading") {
    return (
      <Shell>
        <div style={{ textAlign: "center", padding: "100px 24px" }}>
          <div
            style={{
              width: 40,
              height: 40,
              margin: "0 auto 20px",
              border: "3px solid rgba(255,255,255,0.1)",
              borderTopColor: "#a855f7",
              borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
            }}
          />
          <div style={{ color: "#94a3b8", fontSize: 15 }}>Loading…</div>
        </div>
      </Shell>
    );
  }

  if (phase === "error") {
    return (
      <Shell>
        <div style={{ textAlign: "center", padding: "80px 24px" }}>
          <div style={{ fontSize: 56, marginBottom: 16 }}>⚠️</div>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: "#f87171", margin: "0 0 10px" }}>
            {errorMsg}
          </h2>
          <button
            onClick={() => navigate("/ocr-pdf")}
            style={{
              marginTop: 12,
              padding: "12px 28px",
              background: "linear-gradient(135deg, #7c3aed 0%, #2563eb 100%)",
              color: "#fff",
              border: "none",
              borderRadius: 12,
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t("ocr.backToUpload")}
          </button>
        </div>
      </Shell>
    );
  }

  const blockCount = result?.blocks.length || 0;
  const pages = task?.pages || 0;

  const completedItems = [
    { icon: "✓", text: t("ocr.resultTextRecognized"), color: "#34d399" },
    { icon: "✓", text: t("ocr.resultSearchable"), color: "#38bdf8" },
    { icon: "✓", text: t("ocr.resultEditable"), color: "#a855f7" },
  ];

  return (
    <Shell>
      <div style={{ padding: "60px 24px 80px", maxWidth: 720, margin: "0 auto" }}>
        {/* Success Header */}
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <div
            style={{
              width: 88,
              height: 88,
              margin: "0 auto 20px",
              borderRadius: 24,
              background:
                "linear-gradient(135deg, rgba(52, 211, 153, 0.15) 0%, rgba(139, 92, 246, 0.15) 100%)",
              border: "1px solid rgba(52, 211, 153, 0.3)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 0 30px rgba(52, 211, 153, 0.25)",
            }}
          >
            <span style={{ fontSize: 44 }}>✨</span>
          </div>
          <h1
            style={{
              fontSize: "clamp(28px, 4vw, 38px)",
              fontWeight: 800,
              color: "#ffffff",
              margin: "0 0 12px",
              letterSpacing: "-0.02em",
            }}
          >
            {t("ocr.resultTitle")}
          </h1>
          {task && (
            <p style={{ color: "#64748b", fontSize: 13, margin: "0 0 8px" }}>
              {task.fileName}
            </p>
          )}
          <p style={{ color: "#94a3b8", fontSize: 14, margin: 0 }}>
            {t("ocr.resultPages").replace("{n}", String(pages))} ·{" "}
            {t("ocr.resultBlocks").replace("{n}", String(blockCount))}
          </p>
        </div>

        {/* Completed Items */}
        <div
          style={{
            background: "rgba(15, 23, 42, 0.6)",
            borderRadius: 20,
            padding: 28,
            border: "1px solid rgba(255, 255, 255, 0.08)",
            backdropFilter: "blur(16px)",
            marginBottom: 32,
          }}
        >
          {completedItems.map((item, idx) => (
            <div
              key={idx}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "12px 0",
                borderBottom:
                  idx < completedItems.length - 1
                    ? "1px solid rgba(255,255,255,0.05)"
                    : "none",
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  background: `${item.color}20`,
                  border: `1px solid ${item.color}40`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: item.color,
                  fontWeight: 800,
                  fontSize: 14,
                  flexShrink: 0,
                }}
              >
                {item.icon}
              </div>
              <div style={{ fontSize: 15, fontWeight: 500, color: "#e2e8f0" }}>
                {item.text}
              </div>
            </div>
          ))}
        </div>

        {/* Token 算力消耗信息 */}
        {result?.usage && (
          <div
            style={{
              marginBottom: 32,
              padding: "20px 24px",
              background: "linear-gradient(135deg, rgba(168, 85, 247, 0.10) 0%, rgba(56, 189, 248, 0.06) 100%)",
              border: "1px solid rgba(168, 85, 247, 0.25)",
              borderRadius: 16,
              display: "flex",
              alignItems: "center",
              gap: 18,
            }}
          >
            <div style={{ fontSize: 32 }}>⚡</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#a78bfa", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
                {t("ocr.tokenUsage")}
              </div>
              <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "baseline" }}>
                <div>
                  <span style={{ color: "#f8fafc", fontSize: 24, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
                    {result.usage.total_tokens.toLocaleString()}
                  </span>
                  <span style={{ color: "#64748b", fontSize: 12, marginLeft: 4 }}>{t("ocr.totalTokens")}</span>
                </div>
                <div>
                  <span style={{ color: "#cbd5e1", fontSize: 15, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                    {result.usage.prompt_tokens.toLocaleString()}
                  </span>
                  <span style={{ color: "#64748b", fontSize: 12, marginLeft: 4 }}>{t("ocr.promptTokens")}</span>
                </div>
                <div>
                  <span style={{ color: "#cbd5e1", fontSize: 15, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                    {result.usage.completion_tokens.toLocaleString()}
                  </span>
                  <span style={{ color: "#64748b", fontSize: 12, marginLeft: 4 }}>{t("ocr.completionTokens")}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Primary CTA: Edit PDF */}
        <button
          onClick={openEditor}
          disabled={opening}
          style={{
            width: "100%",
            padding: "18px 0",
            background: opening
              ? "rgba(168, 85, 247, 0.4)"
              : "linear-gradient(135deg, #7c3aed 0%, #2563eb 100%)",
            color: "#fff",
            border: "none",
            borderRadius: 14,
            fontSize: 17,
            fontWeight: 700,
            cursor: opening ? "wait" : "pointer",
            boxShadow: opening
              ? "none"
              : "0 12px 30px rgba(124, 58, 237, 0.4)",
            transition: "all 0.25s",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            marginBottom: 16,
          }}
        >
          {opening ? (
            <>
              <span
                style={{
                  display: "inline-block",
                  width: 18,
                  height: 18,
                  border: "2px solid rgba(255,255,255,0.4)",
                  borderTopColor: "#fff",
                  borderRadius: "50%",
                  animation: "spin 0.6s linear infinite",
                }}
              />
              <span>Loading editor…</span>
            </>
          ) : (
            <>
              <span>👁️</span>
              <span>{t("ocr.viewPdf")}</span>
            </>
          )}
        </button>

        {/* Secondary action */}
        <button
          onClick={() => navigate("/ocr-pdf")}
          style={{
            width: "100%",
            padding: "12px 0",
            background: "transparent",
            color: "#94a3b8",
            border: "1px solid rgba(255, 255, 255, 0.1)",
            borderRadius: 12,
            fontSize: 14,
            fontWeight: 500,
            cursor: "pointer",
            transition: "all 0.2s",
          }}
        >
          {t("ocr.backToUpload")}
        </button>
      </div>

      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily:
          "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        backgroundColor: "#090d16",
        color: "#f8fafc",
        minHeight: "100vh",
        position: "relative",
        overflowX: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: "-150px",
          left: "50%",
          transform: "translateX(-50%)",
          width: "800px",
          height: "400px",
          background:
            "radial-gradient(ellipse at center, rgba(139, 92, 246, 0.18) 0%, rgba(56, 189, 248, 0.08) 50%, rgba(9, 13, 22, 0) 70%)",
          filter: "blur(80px)",
          pointerEvents: "none",
          zIndex: 0,
        }}
      />
      <main style={{ position: "relative", zIndex: 1 }}>{children}</main>
    </div>
  );
}
