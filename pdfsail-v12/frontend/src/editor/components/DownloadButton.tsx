/**
 * DownloadButton — Commit 4 +
 *
 * 页面顶部右上角的 Download 入口：
 *   1. 点击后显示全屏进度条 overlay
 *   2. 调用 handleExport 生成 PDF（不本地下载，拿 blob）
 *   3. 生成 fileKey，上传到 www.pdfsail.com/api/r2-store（Cloudflare R2）
 *   4. 跳转到 https://www.pdfsail.com/[locale]/ready?key=...&tool=editor&...（/ready 页写入 IndexedDB 后跳转 /paywall）
 *   5. 上传失败时 fallback 本地下载
 *
 * 跨域说明：
 *   - www.pdfsail.com/api/r2-store 已配置 CORS: Access-Control-Allow-Origin: *
 *   - body 是 raw stream（不是 FormData），URL 参数带 token/tool/ext
 *   - R2 key 格式：editor/results/${token}.pdf
 *   - worker.js 参考：D:\TRAE\NewPDFSail\worker.js L2194-2214
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n/I18nProvider";
import { useEditor } from "../core/EditorProvider";
import type { ExportResult } from "../features/useExport";

interface DownloadButtonProps {
  handleExport: (skipPay?: boolean, download?: boolean) => Promise<ExportResult | null>;
  disabled?: boolean;
}

type Phase = "idle" | "preparing" | "uploading" | "redirecting" | "done" | "error";

const R2_STORE_URL = "https://www.pdfsail.com/api/r2-store";
const R2_FILE_HOST = "https://www.pdfsail.com/api/r2-file";
const READY_BASE = "https://www.pdfsail.com";

export function DownloadButton({ handleExport, disabled }: DownloadButtonProps) {
  const { lang } = useI18n();
  const { setCompletionResult } = useEditor();
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);

  const phaseLabel = (p: Phase): string => {
    const labels: Record<Phase, string> = {
      idle: "",
      preparing: lang === "pt" ? "Preparando seu documento…" : "Preparing your document…",
      uploading: lang === "pt" ? "Enviando para PDFSail…" : "Uploading to PDFSail…",
      redirecting: lang === "pt" ? "Redirecionando…" : "Redirecting to checkout…",
      done: lang === "pt" ? "Concluído!" : "Complete!",
      error: lang === "pt" ? "Falha no envio, baixando localmente…" : "Upload failed, downloading locally…",
    };
    return labels[p];
  };

  const generateFileKey = (): string => {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 10);
    return `editor_${ts}_${rand}`;
  };

  // 从当前页面 URL 读取原始 fileKey（如果是从 pdfsail.com 跳转来的），用于回传时复用
  const getOriginalFileKey = (): string | null => {
    const params = new URLSearchParams(window.location.search);
    return params.get("fileKey");
  };

  const start = async () => {
    if (disabled || phase !== "idle") return;
    if (typeof window !== "undefined" && (window as any).gtag_report_conversion) {
      (window as any).gtag_report_conversion();
    }
    setPhase("preparing");
    setProgress(5);

    let result: ExportResult | null;
    try {
      result = await handleExport(true, false);
      if (!result) {
        setPhase("idle");
        setProgress(0);
        return;
      }
    } catch (e) {
      console.error("Export failed:", e);
      setPhase("idle");
      setProgress(0);
      return;
    }

    setProgress(100);
    setPhase("done");
    await sleep(400);

    // 弹完成弹框：用户点 Download 才上传 R2 + 跳转 /ready
    setCompletionResult({
      tool: "edit",
      fileName: result.fileName,
      originalSize: result.blob.size,
      resultSize: result.blob.size,
      blob: result.blob,
    });
    setPhase("idle");
    setProgress(0);
  };

  if (phase === "idle") {
    return (
      <button
        onClick={start}
        disabled={disabled}
        style={{
          padding: "8px 18px",
          background: disabled ? "#94a3b8" : "linear-gradient(135deg,#10b981,#059669)",
          color: "#fff",
          border: "none",
          borderRadius: 8,
          fontSize: 14,
          fontWeight: 600,
          cursor: disabled ? "not-allowed" : "pointer",
          boxShadow: "0 2px 8px rgba(16,185,129,0.3)",
        }}
      >
        ⬇ Download
      </button>
    );
  }

  // 进度条 overlay
  return (
    <>
      <button
        disabled
        style={{
          padding: "8px 18px",
          background: "#94a3b8",
          color: "#fff",
          border: "none",
          borderRadius: 8,
          fontSize: 14,
          fontWeight: 600,
          cursor: "wait",
        }}
      >
        ⏳ {Math.round(progress)}%
      </button>
      {createPortal(
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.85)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 99999,
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 16,
              padding: "40px 48px",
              width: 440,
              textAlign: "center",
              boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
            }}
          >
            <div style={{ fontSize: 48, marginBottom: 16 }}>
              {phase === "preparing" ? "📄" : phase === "uploading" ? "☁️" : phase === "redirecting" ? "🚀" : phase === "error" ? "⚠️" : "✅"}
            </div>
            <div style={{ fontSize: 18, fontWeight: 600, color: "#1e293b", marginBottom: 20 }}>
              {phaseLabel(phase)}
            </div>
            <div
              style={{
                width: "100%",
                height: 8,
                background: "#e2e8f0",
                borderRadius: 4,
                overflow: "hidden",
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  width: `${progress}%`,
                  height: "100%",
                  background: phase === "error" ? "#f59e0b" : "linear-gradient(90deg,#10b981,#059669)",
                  borderRadius: 4,
                  transition: "width 0.2s ease",
                }}
              />
            </div>
            <div style={{ fontSize: 12, color: "#64748b" }}>{progress}%</div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 对 Blob 前 headLen 字节做 XOR 编码（匹配 worker.js paywall 端的 XOR 解码）
 * worker.js L6297: for (let i = 0; i < Math.min(bytes.length, 256); i++) bytes[i] ^= 0x5A;
 */
async function xorEncodeHead(blob: Blob, headLen: number, xorKey: number): Promise<Blob> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const len = Math.min(buf.length, headLen);
  for (let i = 0; i < len; i++) buf[i] ^= xorKey;
  return new Blob([buf], { type: blob.type });
}
