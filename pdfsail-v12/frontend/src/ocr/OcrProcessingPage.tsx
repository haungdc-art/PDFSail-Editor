/**
 * OcrProcessingPage — /ocr-processing/:taskId
 *
 * 加载 IndexedDB 中的 OCR task → 执行多页 Tesseract OCR → 显示三阶段进度。
 *
 * 三阶段：
 *   1. Preparing document       加载 PDF
 *   2. Recognizing text         逐页 OCR（显示 Page X / Y）
 *   3. Creating editable PDF    保存 OCR blocks
 *
 * 完成后跳转 /ocr-result/:taskId；失败显示错误并提供重试。
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useI18n } from "../i18n/I18nProvider";
import { runFullOcr, type OcrProgress, type OcrUsage } from "./ocr-utils";
import {
  getOcrTask,
  updateOcrTask,
  saveOcrResult,
  type OcrTask,
} from "./ocr-storage";

type Phase = "loading" | "processing" | "done" | "error";

export default function OcrProcessingPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { taskId } = useParams<{ taskId: string }>();
  const [phase, setPhase] = useState<Phase>("loading");
  const [progress, setProgress] = useState<OcrProgress>({
    stage: "preparing",
    currentPage: 0,
    totalPages: 0,
  });
  const [task, setTask] = useState<OcrTask | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [usage, setUsage] = useState<OcrUsage | null>(null);
  const startedRef = useRef(false);

  // 加载 task + 启动 OCR
  useEffect(() => {
    if (!taskId || startedRef.current) return;
    startedRef.current = true;

    (async () => {
      try {
        const tsk = await getOcrTask(taskId);
        if (!tsk) {
          setErrorMsg("Task not found");
          setPhase("error");
          return;
        }
        setTask(tsk);
        setPhase("processing");

        // 标记为 OCR_PROCESSING
        await updateOcrTask(taskId, { status: "OCR_PROCESSING" });

        const buf = await tsk.blob.arrayBuffer();
        let capturedUsage: OcrUsage | null = null;
        const blocks = await runFullOcr(
          buf,
          taskId,
          (p) => setProgress(p),
          async (tid, blks) => {
            await saveOcrResult({ taskId: tid, blocks: blks });
          },
          (u) => { capturedUsage = u; setUsage(u); }
        );

        // 标记为 COMPLETED
        await updateOcrTask(taskId, {
          status: "COMPLETED",
          blockCount: blocks.length,
        });

        // 保存 usage 到 OCR 结果 + sessionStorage（供 OcrResultPage 和 PaywallPage 读取）
        if (capturedUsage) {
          await saveOcrResult({ taskId, blocks, usage: capturedUsage });
          sessionStorage.setItem("pdfaide_ocr_usage", JSON.stringify(capturedUsage));
        }

        // 静默上传到 R2（fire-and-forget，不影响主流程）
        try {
          // 1. 上传原始 PDF（分块 base64 编码，避免大文件栈溢出）
          const u8 = new Uint8Array(buf);
          let pdfBase64 = "";
          const chunkSize = 8192;
          for (let i = 0; i < u8.length; i += chunkSize) {
            pdfBase64 += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + chunkSize)));
          }
          pdfBase64 = btoa(pdfBase64);
          fetch("/api/ocr/upload-to-r2", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId, data: pdfBase64, suffix: "original.pdf", contentType: "application/pdf" }),
          }).catch(() => {});
          // 2. 上传 OCR 结果 JSON
          const resultJson = JSON.stringify({ taskId, blocks, usage, timestamp: Date.now() });
          const resultBase64 = btoa(unescape(encodeURIComponent(resultJson)));
          fetch("/api/ocr/upload-to-r2", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId, data: resultBase64, suffix: "ocr-result.json", contentType: "application/json" }),
          }).catch(() => {});
        } catch { /* 静默忽略 R2 上传失败 */ }

        setPhase("done");
        // 短暂停顿后跳转结果页
        setTimeout(() => navigate(`/ocr-result/${taskId}`), 600);
      } catch (err: any) {
        console.error("[OcrProcessingPage] OCR failed:", err);
        // 根据 GLM-OCR 错误码映射国际化消息
        const ocrCode = err?.ocrErrorCode as number | undefined;
        let msg: string;
        if (ocrCode === 1214) {
          msg = t("ocr.errorFormatSize");
        } else if (ocrCode === 1301 || ocrCode === 1303) {
          msg = t("ocr.errorRateLimit");
        } else {
          msg = t("ocr.errorGeneric");
        }
        setErrorMsg(msg);
        setPhase("error");
        if (taskId) {
          await updateOcrTask(taskId, {
            status: "FAILED",
            errorMessage: msg,
          }).catch(() => {});
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // 阶段配置
  const stages = [
    {
      key: "preparing",
      label: t("ocr.stagePreparing"),
      icon: "📄",
    },
    {
      key: "recognizing",
      label: t("ocr.stageRecognizing"),
      icon: "🔍",
    },
    {
      key: "creating",
      label: t("ocr.stageCreating"),
      icon: "✨",
    },
  ] as const;

  const currentStageIdx = stages.findIndex((s) => s.key === progress.stage);

  // 进度百分比
  const percent =
    progress.stage === "preparing"
      ? 5
      : progress.stage === "recognizing" && progress.totalPages > 0
      ? 15 + Math.round((progress.currentPage / progress.totalPages) * 70)
      : progress.stage === "creating"
      ? 90
      : 0;

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
      {/* Background glow */}
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

      <main
        style={{
          position: "relative",
          zIndex: 1,
          maxWidth: 720,
          margin: "0 auto",
          padding: "80px 24px",
        }}
      >
        {/* Loading task */}
        {phase === "loading" && (
          <div style={{ textAlign: "center" }}>
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
        )}

        {/* Processing */}
        {(phase === "processing" || phase === "done") && (
          <div>
            <div style={{ textAlign: "center", marginBottom: 40 }}>
              <h1
                style={{
                  fontSize: "clamp(24px, 3.5vw, 32px)",
                  fontWeight: 800,
                  color: "#ffffff",
                  margin: "0 0 8px",
                  letterSpacing: "-0.02em",
                }}
              >
                {t("ocr.processingTitle")}
              </h1>
              {task && (
                <p style={{ color: "#64748b", fontSize: 13, margin: "0 0 4px" }}>
                  {task.fileName}
                </p>
              )}
              <p style={{ color: "#94a3b8", fontSize: 14, margin: 0 }}>
                {t("ocr.processingDesc")}
              </p>
            </div>

            {/* Progress bar */}
            <div
              style={{
                background: "rgba(15, 23, 42, 0.6)",
                borderRadius: 16,
                padding: "24px 28px",
                border: "1px solid rgba(255, 255, 255, 0.08)",
                backdropFilter: "blur(16px)",
                marginBottom: 24,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 12,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 600, color: "#cbd5e1" }}>
                  {progress.stage === "recognizing" && progress.totalPages > 0
                    ? t("ocr.pageProgress")
                        .replace("{current}", String(progress.currentPage))
                        .replace("{total}", String(progress.totalPages))
                    : stages[currentStageIdx]?.label || ""}
                </div>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: "#a855f7",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {percent}%
                </div>
              </div>

              <div
                style={{
                  height: 10,
                  background: "rgba(255,255,255,0.06)",
                  borderRadius: 5,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${percent}%`,
                    height: "100%",
                    background:
                      "linear-gradient(90deg, #7c3aed 0%, #2563eb 50%, #38bdf8 100%)",
                    borderRadius: 5,
                    transition: "width 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
                    boxShadow: "0 0 12px rgba(139, 92, 246, 0.5)",
                  }}
                />
              </div>
            </div>

            {/* Stage indicators */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: 12,
              }}
            >
              {stages.map((s, idx) => {
                const isDone = idx < currentStageIdx || phase === "done";
                const isActive = idx === currentStageIdx && phase !== "done";
                return (
                  <div
                    key={s.key}
                    style={{
                      padding: "18px 16px",
                      background: isActive
                        ? "rgba(168, 85, 247, 0.1)"
                        : "rgba(15, 23, 42, 0.5)",
                      border: isActive
                        ? "1px solid rgba(168, 85, 247, 0.4)"
                        : isDone
                        ? "1px solid rgba(52, 211, 153, 0.3)"
                        : "1px solid rgba(255, 255, 255, 0.06)",
                      borderRadius: 14,
                      textAlign: "center",
                      backdropFilter: "blur(12px)",
                      transition: "all 0.3s",
                    }}
                  >
                    <div style={{ fontSize: 26, marginBottom: 6 }}>
                      {isDone ? "✅" : isActive ? (
                        <span
                          style={{
                            display: "inline-block",
                            width: 22,
                            height: 22,
                            border: "2px solid rgba(168, 85, 247, 0.3)",
                            borderTopColor: "#a855f7",
                            borderRadius: "50%",
                            animation: "spin 0.6s linear infinite",
                          }}
                        />
                      ) : (
                        <span style={{ opacity: 0.4 }}>{s.icon}</span>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: isDone ? "#34d399" : isActive ? "#c084fc" : "#64748b",
                      }}
                    >
                      {s.label}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Token 用量信息（OCR 完成后特别显示） */}
            {phase === "done" && usage && (
              <div
                style={{
                  marginTop: 20,
                  padding: "16px 24px",
                  background: "linear-gradient(135deg, rgba(168, 85, 247, 0.12) 0%, rgba(56, 189, 248, 0.08) 100%)",
                  border: "1px solid rgba(168, 85, 247, 0.3)",
                  borderRadius: 14,
                  display: "flex",
                  alignItems: "center",
                  gap: 20,
                }}
              >
                <div style={{ fontSize: 28 }}>⚡</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#a78bfa", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
                    {t("ocr.tokenUsage")}
                  </div>
                  <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                    <div>
                      <span style={{ color: "#64748b", fontSize: 12 }}>{t("ocr.totalTokens")}: </span>
                      <span style={{ color: "#f8fafc", fontSize: 18, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                        {usage.total_tokens.toLocaleString()}
                      </span>
                    </div>
                    <div>
                      <span style={{ color: "#64748b", fontSize: 12 }}>{t("ocr.promptTokens")}: </span>
                      <span style={{ color: "#cbd5e1", fontSize: 14, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                        {usage.prompt_tokens.toLocaleString()}
                      </span>
                    </div>
                    <div>
                      <span style={{ color: "#64748b", fontSize: 12 }}>{t("ocr.completionTokens")}: </span>
                      <span style={{ color: "#cbd5e1", fontSize: 14, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                        {usage.completion_tokens.toLocaleString()}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {phase === "error" && (
          <div
            style={{
              textAlign: "center",
              padding: 32,
              background: "rgba(239, 68, 68, 0.06)",
              border: "1px solid rgba(239, 68, 68, 0.25)",
              borderRadius: 16,
            }}
          >
            <div style={{ fontSize: 48, marginBottom: 12 }}>⚠️</div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f87171", margin: "0 0 10px" }}>
              {errorMsg}
            </h2>
            <button
              onClick={() => navigate("/ocr-pdf")}
              style={{
                marginTop: 12,
                padding: "10px 24px",
                background: "rgba(255,255,255,0.08)",
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t("ocr.tryAgain")}
            </button>
          </div>
        )}
      </main>

      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
