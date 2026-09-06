import React, { type ReactNode } from "react";

/**
 * ToolShell — 工具页面共享外壳
 *
 * 复用 CompressPdfPage 的深色玻璃拟态视觉风格：
 *   - #090d16 深色背景 + 顶部微光高光
 *   - 居中 720px 内容容器
 *   - 渐变标题（带 highlight 部分）
 *   - 全局 spin 动画
 */
export default function ToolShell({
  title,
  titleHighlight,
  subtitle,
  children,
}: {
  title: string;
  titleHighlight?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "#090d16",
        color: "#f8fafc",
        fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
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

      <main style={{ position: "relative", zIndex: 1 }}>
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "40px 24px 80px" }}>
          {/* Title Block */}
          <div style={{ textAlign: "center", marginBottom: 36 }}>
            <h1
              style={{
                fontSize: "clamp(28px, 4vw, 40px)",
                fontWeight: 800,
                color: "#ffffff",
                margin: "0 0 12px",
                letterSpacing: "-0.02em",
              }}
            >
              {title}{" "}
              {titleHighlight && (
                <span
                  style={{
                    background: "linear-gradient(135deg, #a78bfa 0%, #38bdf8 100%)",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                  }}
                >
                  {titleHighlight}
                </span>
              )}
            </h1>
            {subtitle && (
              <p
                style={{
                  color: "#94a3b8",
                  fontSize: 15,
                  lineHeight: 1.6,
                  margin: 0,
                  maxWidth: 600,
                  marginLeft: "auto",
                  marginRight: "auto",
                }}
              >
                {subtitle}
              </p>
            )}
          </div>
          {children}
        </div>
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

/** 格式化文件大小 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 通用错误提示框 */
export function ErrorAlert({ error }: { error: string }) {
  if (!error) return null;
  return (
    <div
      style={{
        padding: "14px 18px",
        background: "rgba(239, 68, 68, 0.1)",
        border: "1px solid rgba(239, 68, 68, 0.25)",
        borderRadius: 12,
        color: "#f87171",
        fontSize: 14,
        marginBottom: 24,
      }}
    >
      ⚠️ {error}
    </div>
  );
}

/** 通用完成结果面板 */
export function SuccessPanel({
  emoji = "🎉",
  title,
  desc,
  downloadLabel,
  downloadHref,
  downloadName,
}: {
  emoji?: string;
  title: string;
  desc?: string;
  downloadLabel: string;
  downloadHref: string;
  downloadName: string;
}) {
  return (
    <div
      style={{
        background: "rgba(15, 23, 42, 0.6)",
        borderRadius: 20,
        padding: 32,
        border: "1px solid rgba(52, 211, 153, 0.3)",
        backdropFilter: "blur(16px)",
        textAlign: "center",
        boxShadow: "0 20px 40px rgba(0, 0, 0, 0.4)",
      }}
    >
      <div style={{ fontSize: 44, marginBottom: 12 }}>{emoji}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: "#34d399", marginBottom: 8 }}>
        {title}
      </div>
      {desc && (
        <div style={{ fontSize: 14, color: "#94a3b8", marginBottom: 20 }}>{desc}</div>
      )}
      <a
        href={downloadHref}
        download={downloadName}
        style={{
          display: "inline-block",
          padding: "14px 40px",
          borderRadius: 12,
          background: "linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)",
          color: "#fff",
          fontWeight: 700,
          textDecoration: "none",
          fontSize: 15,
          boxShadow: "0 8px 25px rgba(37, 99, 235, 0.4)",
          transition: "all 0.2s",
        }}
      >
        {downloadLabel}
      </a>
    </div>
  );
}

/** 通用主操作按钮 */
export function ActionButton({
  children,
  onClick,
  disabled,
  busy,
  marginBottom = 24,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  marginBottom?: number;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: "100%",
        padding: "16px 0",
        borderRadius: 14,
        border: "none",
        background: disabled
          ? "rgba(255, 255, 255, 0.05)"
          : busy
          ? "rgba(168, 85, 247, 0.4)"
          : "linear-gradient(135deg, #a855f7 0%, #2563eb 100%)",
        color: disabled ? "#64748b" : "#ffffff",
        fontSize: 16,
        fontWeight: 700,
        cursor: disabled ? "not-allowed" : busy ? "wait" : "pointer",
        marginBottom,
        boxShadow: !disabled && !busy ? "0 8px 25px rgba(168, 85, 247, 0.35)" : "none",
        transition: "all 0.25s",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
      }}
    >
      {busy ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          {/* FIX: button 内不能嵌套 div，改为 span 避免浏览器自动修正 DOM 触发 React removeChild 错误 */}
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
          <span>{children}</span>
        </span>
      ) : (
        <span>{children}</span>
      )}
    </button>
  );
}
