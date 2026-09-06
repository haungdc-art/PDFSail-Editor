/**
 * OcrLandingPage — /ocr-pdf
 *
 * 承接 SEO 流量（OCR PDF / Scanned PDF Editor / Convert Scanned PDF To Text）。
 *
 * 流程：
 *   1. Hero + Upload 区域
 *   2. 用户上传 PDF → detectScannedPdf 判断是否扫描件
 *   3. 扫描件 → 创建 OCR task → 跳转 /ocr-processing/:taskId
 *   4. 普通件 → 提示已含文本 → 提供"Open Editor"直接打开编辑器
 *
 * 视觉与 HomePage / PaywallPage 一致：深色 #090d16 + 玻璃拟态卡片 + 渐变高光。
 */

import React, { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useI18n } from "../i18n/I18nProvider";
import { detectScannedPdf } from "./ocr-utils";
import { saveOcrTask, type OcrTask } from "./ocr-storage";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB（GLM-OCR PDF 限制）

type DetectionState =
  | { kind: "idle" }
  | { kind: "detecting"; fileName: string }
  | { kind: "scanned"; task: OcrTask }
  | { kind: "hasText"; fileName: string; pages: number; file: File; task: OcrTask }
  | { kind: "error"; message: string };

export default function OcrLandingPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [detection, setDetection] = useState<DetectionState>({ kind: "idle" });

  const handleFile = useCallback(
    async (file: File) => {
      if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
        setDetection({ kind: "error", message: t("ocr.uploadErrorPdf") });
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        setDetection({ kind: "error", message: t("ocr.uploadErrorSize") });
        return;
      }

      setDetection({ kind: "detecting", fileName: file.name });
      try {
        const buf = await file.arrayBuffer();

        // 静默上传到 R2 备份（不阻塞现有流程）
        const R2_UPLOAD_URL = import.meta.env.VITE_R2_UPLOAD_URL || "https://pdfaide-r2.haung-dc.workers.dev/upload";
        fetch(R2_UPLOAD_URL, {
          method: "POST",
          headers: { "X-File-Name": encodeURIComponent(file.name) },
          body: file,
        }).catch(() => {});

        const result = await detectScannedPdf(buf);

        // 创建 OCR task 并保存到 IndexedDB（扫描件流程需要持久化）
        const task: OcrTask = {
          id: crypto.randomUUID(),
          fileName: file.name,
          blob: new Blob([buf.slice(0)], { type: "application/pdf" }),
          status: "UPLOADED",
          pages: result.pages,
          isScanned: result.isScanned,
          createdAt: Date.now(),
        };
        await saveOcrTask(task);

        if (result.isScanned) {
          setDetection({ kind: "scanned", task });
        } else {
          // 普通件/混合件：保留 File 引用供 "Open Editor" 复用，同时保留 task 供 "Force OCR" 使用
          setDetection({ kind: "hasText", fileName: file.name, pages: result.pages, file, task });
        }
      } catch (err: any) {
        console.error("[OcrLandingPage] Detection failed:", err);
        setDetection({ kind: "error", message: t("ocr.detectFailed") });
      }
    },
    [t]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
      e.target.value = "";
    },
    [handleFile]
  );

  const startOcr = () => {
    if (detection.kind === "scanned") {
      navigate(`/ocr-processing/${detection.task.id}`);
    }
  };

  const startOcrAnyway = () => {
    if (detection.kind === "hasText") {
      navigate(`/ocr-processing/${detection.task.id}`);
    }
  };

  const openEditorDirectly = async () => {
    if (detection.kind !== "hasText") return;
    try {
      const buf = await detection.file.arrayBuffer();
      const { savePendingPdf } = await import("../lib/indexedDB");
      await savePendingPdf({
        blob: new Blob([buf], { type: "application/pdf" }),
        fileName: detection.fileName,
      });
      sessionStorage.setItem(
        "pdfaide_pending_pdf",
        JSON.stringify({ name: detection.fileName, useIndexedDB: true })
      );
      navigate("/editor");
    } catch (err) {
      console.error("[OcrLandingPage] openEditorDirectly failed:", err);
      setDetection({ kind: "idle" });
    }
  };

  // 信任信息项
  const trustItems = [
    { icon: "✨", text: t("ocr.trustAi") },
    { icon: "📐", text: t("ocr.trustLayout") },
    { icon: "✏️", text: t("ocr.trustEdit") },
    { icon: "☁️", text: t("ocr.trustNoSoftware") },
  ];

  return (
    <div
      style={{
        fontFamily:
          "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        backgroundColor: "#090d16",
        color: "#f8fafc",
        minHeight: "100vh",
        overflowX: "hidden",
      }}
    >
      {/* Background Glow */}
      <div style={{ position: "relative" }}>
        <div
          style={{
            position: "absolute",
            top: "-150px",
            left: "50%",
            transform: "translateX(-50%)",
            width: "850px",
            height: "450px",
            background:
              "radial-gradient(ellipse at center, rgba(139, 92, 246, 0.22) 0%, rgba(56, 189, 248, 0.12) 45%, rgba(9, 13, 22, 0) 70%)",
            filter: "blur(70px)",
            pointerEvents: "none",
            zIndex: 0,
          }}
        />

        {/* Hero + Upload */}
        <section
          style={{
            position: "relative",
            zIndex: 1,
            padding: "60px 24px 80px",
            textAlign: "center",
            maxWidth: 1100,
            margin: "0 auto",
          }}
        >
          <div
            style={{
              marginBottom: 12,
              fontSize: "clamp(13px, 1.2vw, 15px)",
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "#7c5cfc",
            }}
          >
            {t("ocr.heroBrand")}
          </div>
          <h1
            style={{
              fontSize: "clamp(36px, 5.5vw, 58px)",
              fontWeight: 800,
              letterSpacing: "-0.03em",
              lineHeight: 1.1,
              margin: "0 0 20px",
              color: "#ffffff",
            }}
          >
            {t("ocr.heroTitle1")}{" "}
            <span
              style={{
                background:
                  "linear-gradient(135deg, #a78bfa 0%, #38bdf8 50%, #818cf8 100%)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                display: "inline-block",
              }}
            >
              {t("ocr.heroTitleHighlight")}
            </span>
          </h1>
          <p
            style={{
              fontSize: "clamp(15px, 1.8vw, 18px)",
              color: "#94a3b8",
              maxWidth: 720,
              margin: "0 auto 48px",
              lineHeight: 1.6,
              fontWeight: 400,
            }}
          >
            {t("ocr.heroDesc")}
          </p>

          {/* Upload Box — 仅在 idle / detecting 状态显示 */}
          {(detection.kind === "idle" || detection.kind === "detecting") && (
            <>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  maxWidth: 620,
                  margin: "0 auto",
                  padding: "52px 36px",
                  background: dragOver
                    ? "rgba(139, 92, 246, 0.12)"
                    : "rgba(30, 41, 59, 0.4)",
                  border: `2px dashed ${
                    dragOver ? "#a78bfa" : "rgba(255, 255, 255, 0.15)"
                  }`,
                  borderRadius: 24,
                  cursor: detection.kind === "detecting" ? "wait" : "pointer",
                  backdropFilter: "blur(16px)",
                  boxShadow: dragOver
                    ? "0 0 40px rgba(139, 92, 246, 0.3)"
                    : "0 20px 50px rgba(0, 0, 0, 0.4)",
                  transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                }}
              >
                {detection.kind === "detecting" ? (
                  <>
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
                    <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f8fafc", margin: "0 0 6px" }}>
                      {t("ocr.detecting")}
                    </h2>
                    <p style={{ color: "#64748b", fontSize: 13, margin: 0 }}>
                      {detection.fileName}
                    </p>
                  </>
                ) : (
                  <>
                    <div
                      style={{
                        width: 72,
                        height: 72,
                        margin: "0 auto 20px",
                        borderRadius: 20,
                        background:
                          "linear-gradient(135deg, rgba(139,92,246,0.2), rgba(56,189,248,0.2))",
                        border: "1px solid rgba(255, 255, 255, 0.1)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
                      }}
                    >
                      <svg
                        width="36"
                        height="36"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#c084fc"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="12" y1="18" x2="12" y2="12" />
                        <line x1="9" y1="15" x2="12" y2="12" />
                        <line x1="15" y1="15" x2="12" y2="12" />
                      </svg>
                    </div>
                    <h2 style={{ fontSize: 22, fontWeight: 700, color: "#f8fafc", margin: "0 0 8px" }}>
                      {t("ocr.dropHere")}
                    </h2>
                    <p style={{ color: "#64748b", fontSize: 14, margin: "0 0 24px", fontWeight: 500 }}>
                      {t("ocr.orClick")}
                    </p>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        fileInputRef.current?.click();
                      }}
                      style={{
                        padding: "14px 32px",
                        background: "linear-gradient(135deg, #7c3aed 0%, #2563eb 100%)",
                        color: "#fff",
                        border: "none",
                        borderRadius: 12,
                        fontSize: 15,
                        fontWeight: 600,
                        cursor: "pointer",
                        boxShadow: "0 8px 25px rgba(124, 58, 237, 0.4)",
                        transition: "transform 0.2s, box-shadow 0.2s",
                      }}
                    >
                      {t("ocr.chooseFile")}
                    </button>
                    <p style={{ color: "#94a3b8", fontSize: 12, margin: "12px 0 0", lineHeight: 1.6 }}>
                      {t("ocr.uploadHint")}
                    </p>
                    <p style={{ color: "#a78bfa", fontSize: 12, margin: "4px 0 0", lineHeight: 1.6 }}>
                      {t("ocr.uploadHintSplit")}
                    </p>
                  </>
                )}

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,application/pdf"
                  onChange={handleSelect}
                  style={{ display: "none" }}
                />
              </div>

              {/* Trust info */}
              <div
                style={{
                  maxWidth: 620,
                  margin: "32px auto 0",
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: 12,
                }}
              >
                {trustItems.map((item) => (
                  <div
                    key={item.text}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "12px 16px",
                      background: "rgba(15, 23, 42, 0.5)",
                      border: "1px solid rgba(255, 255, 255, 0.08)",
                      borderRadius: 12,
                      backdropFilter: "blur(12px)",
                      fontSize: 13,
                      fontWeight: 500,
                      color: "#cbd5e1",
                    }}
                  >
                    <span style={{ fontSize: 16 }}>{item.icon}</span>
                    <span>✓ {item.text}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Detection Result — Scanned */}
          {detection.kind === "scanned" && (
            <div
              style={{
                maxWidth: 560,
                margin: "0 auto",
                padding: "44px 36px",
                background: "rgba(30, 41, 59, 0.4)",
                border: "2px solid #a78bfa",
                borderRadius: 24,
                backdropFilter: "blur(16px)",
                boxShadow: "0 0 40px rgba(139, 92, 246, 0.25)",
              }}
            >
              <div style={{ fontSize: 56, marginBottom: 16 }}>🔍</div>
              <h2 style={{ fontSize: 26, fontWeight: 800, color: "#f8fafc", margin: "0 0 8px" }}>
                {t("ocr.scannedDetected")}
              </h2>
              <p style={{ color: "#94a3b8", fontSize: 15, margin: "0 0 8px" }}>
                {t("ocr.scannedDetectedDesc")}
              </p>
              <p style={{ color: "#64748b", fontSize: 13, margin: "0 0 28px" }}>
                {detection.task.fileName} · {detection.task.pages} pages
              </p>
              <button
                onClick={startOcr}
                style={{
                  padding: "16px 40px",
                  background: "linear-gradient(135deg, #7c3aed 0%, #2563eb 100%)",
                  color: "#fff",
                  border: "none",
                  borderRadius: 14,
                  fontSize: 16,
                  fontWeight: 700,
                  cursor: "pointer",
                  boxShadow: "0 8px 25px rgba(124, 58, 237, 0.4)",
                }}
              >
                {t("ocr.startOcr")} →
              </button>
            </div>
          )}

          {/* Detection Result — Already has text (or mixed file) */}
          {detection.kind === "hasText" && (
            <div
              style={{
                maxWidth: 560,
                margin: "0 auto",
                padding: "44px 36px",
                background: "rgba(30, 41, 59, 0.4)",
                border: "2px solid #34d399",
                borderRadius: 24,
                backdropFilter: "blur(16px)",
                boxShadow: "0 0 40px rgba(52, 211, 153, 0.2)",
              }}
            >
              <div style={{ fontSize: 56, marginBottom: 16 }}>✅</div>
              <h2 style={{ fontSize: 24, fontWeight: 800, color: "#f8fafc", margin: "0 0 8px" }}>
                {t("ocr.alreadyHasText")}
              </h2>
              <p style={{ color: "#94a3b8", fontSize: 15, margin: "0 0 8px" }}>
                {t("ocr.alreadyHasTextDesc")}
              </p>
              <p style={{ color: "#64748b", fontSize: 13, margin: "0 0 28px" }}>
                {detection.fileName} · {detection.pages} pages
              </p>
              <button
                onClick={openEditorDirectly}
                style={{
                  padding: "14px 36px",
                  background: "linear-gradient(135deg, #059669 0%, #2563eb 100%)",
                  color: "#fff",
                  border: "none",
                  borderRadius: 12,
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: "pointer",
                  boxShadow: "0 8px 20px rgba(5, 150, 105, 0.35)",
                  width: "100%",
                }}
              >
                {t("ocr.openEditor")} →
              </button>
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                <p style={{ color: "#64748b", fontSize: 13, margin: "0 0 12px", lineHeight: 1.5 }}>
                  {t("ocr.forceOcrDesc")}
                </p>
                <button
                  onClick={startOcrAnyway}
                  style={{
                    padding: "12px 28px",
                    background: "transparent",
                    color: "#a78bfa",
                    border: "1px solid rgba(167, 139, 250, 0.4)",
                    borderRadius: 10,
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: "pointer",
                    transition: "all 0.2s",
                    width: "100%",
                  }}
                >
                  {t("ocr.forceOcr")} →
                </button>
              </div>
            </div>
          )}

          {/* Error */}
          {detection.kind === "error" && (
            <div
              style={{
                maxWidth: 560,
                margin: "0 auto",
                padding: "32px 28px",
                background: "rgba(239, 68, 68, 0.08)",
                border: "1px solid rgba(239, 68, 68, 0.3)",
                borderRadius: 16,
              }}
            >
              <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
              <p style={{ color: "#fca5a5", fontSize: 14, margin: "0 0 20px" }}>
                {detection.message}
              </p>
              <button
                onClick={() => setDetection({ kind: "idle" })}
                style={{
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
        </section>
      </div>

      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
