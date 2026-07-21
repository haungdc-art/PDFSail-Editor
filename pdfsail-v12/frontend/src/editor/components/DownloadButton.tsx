/**
 * DownloadButton — Commit 4 +
 *
 * 页面顶部右上角的 Download 入口：
 *   1. 点击后显示全屏进度条 overlay
 *   2. 调用 handleExport 生成 PDF（不本地下载，拿 blob）
 *   3. 生成 fileKey，上传到 www.pdfsail.com/api/r2-store（Cloudflare R2）
 *   4. 跳转到 https://www.pdfsail.com/[locale]/ready?key=editor/results/xxx.pdf&...
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
    setPhase("preparing");
    setProgress(5);

    // 阶段 1：生成 PDF blob（不本地下载）
    let result: ExportResult | null;
    try {
      result = await handleExport(true, false);
      if (!result) {
        // 支付弹窗打开或导出失败
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

    setProgress(25);

    // 阶段 2：上传到 R2（www.pdfsail.com/api/r2-store，raw body + URL 参数）
    setPhase("uploading");
    const token = generateFileKey();
    let uploaded = false;
    try {
      // worker.js L2194-2214：URL 参数带 token/tool/ext，body 是 raw stream
      const upResp = await fetch(
        `${R2_STORE_URL}?token=${encodeURIComponent(token)}&tool=editor&ext=pdf`,
        {
          method: "POST",
          headers: { "Content-Type": "application/pdf" },
          body: result.blob,
        }
      );
      if (upResp.ok) {
        uploaded = true;
      } else {
        console.warn("R2 upload failed:", upResp.status, await upResp.text().catch(() => ""));
      }
    } catch (e) {
      console.warn("R2 upload error (likely CORS or network):", e);
    }

    // 模拟上传进度动画
    for (let p = 35; p <= 80; p += 5) {
      setProgress(p);
      await sleep(80);
    }

    if (!uploaded) {
      // fallback：本地下载
      setPhase("error");
      setProgress(90);
      try {
        const url = URL.createObjectURL(result.blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = result.fileName;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        console.error("Local download fallback failed:", e);
      }
      await sleep(1500);
      setPhase("idle");
      setProgress(0);
      return;
    }

    // 阶段 3：跳转到 ready 页面（带 locale + fileKey + r2host）
    setPhase("redirecting");
    for (let p = 85; p <= 95; p += 5) {
      setProgress(p);
      await sleep(100);
    }

    const locale = lang === "pt" ? "pt" : "en";
    // Ready 页面会把 key/r2 当作纯 token 重新拼接成 `editor/results/${key}.pdf`
    // 所以这里必须传纯 token（不含 editor/results/ 前缀和 .pdf 后缀），避免双重拼接
    // 同理 name 也不能带 .pdf 后缀（Ready 页面会拼接 .pdf）
    const stripPdfExt = (s: string) => s.toLowerCase().endsWith(".pdf") ? s.slice(0, -4) : s;
    const params = new URLSearchParams({
      key: token,
      r2: token,
      tool: "editor",
      task: "edit",
      name: stripPdfExt(result.fileName),
      size: String(result.blob.size),
      r2host: R2_FILE_HOST,
    });
    const readyUrl = `${READY_BASE}/${locale}/ready?${params.toString()}`;

    setPhase("done");
    setProgress(100);
    await sleep(400);
    window.location.href = readyUrl;
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
