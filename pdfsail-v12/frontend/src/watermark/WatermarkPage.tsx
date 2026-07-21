import React, { useState, useRef } from "react";
import { removeWatermark, WatermarkIntent } from "./watermark-core";

export default function WatermarkPage() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ removed: number; confidence: number; pages: number; intent: WatermarkIntent; risk: string; quality: number; paywall: string; price: number } | null>(null);
  const [paid, setPaid] = useState(false);
  const latestBlobRef = useRef<Blob | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const intentLabel: Record<WatermarkIntent, string> = { draft: "📄 Draft / Sample", branding: "🏷️ Branding", confidential: "🔒 Confidential", security: "🛡️ Security", unknown: "❓ Unknown" };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) { setFile(f); setBlob(null); setResult(null); setError(""); setPaid(false); }
  };

  const handleRemove = async (skipPay?: boolean) => {
    if (!file) return;
    setBusy(true); setError(""); setBlob(null); setResult(null);
    try {
      const buf = await file.arrayBuffer();
      const res = await removeWatermark(new Uint8Array(buf));
      latestBlobRef.current = res.blob;
      setResult({ removed: res.removed, confidence: res.confidence, pages: res.pagesAffected, intent: res.intent, risk: res.riskLevel, quality: res.qualityScore, paywall: res.paywall, price: res.price });
      if (skipPay || res.paywall !== "premium") setBlob(res.blob);
    } catch (err: any) { setError(err.message || "Removal failed"); }
    setBusy(false);
  };

  const handlePay = () => { setPaid(true); handleRemove(true); };
  const c = (s: number) => s > 0.7 ? "#059669" : s > 0.4 ? "#d97706" : "#dc2626";

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 36, fontWeight: 800, color: "#1a1a2e", marginBottom: 8 }}>Remove Watermark</h1>
      <p style={{ color: "#64748b", marginBottom: 32, fontSize: 15 }}>Detect and remove watermarks (Draft, Sample, Branding, Confidential). AI-powered intent classification.</p>

      <div style={{ border: "2px dashed #cbd5e1", borderRadius: 12, padding: 32, textAlign: "center", marginBottom: 24, background: file ? "#f0fdf4" : "#fafafa" }}>
        {file ? (
          <div>
            <div style={{ fontWeight: 600, color: "#1e293b" }}>{file.name}</div>
            <button onClick={() => { setFile(null); setBlob(null); setResult(null); }} style={{ marginTop: 6, ...smBtn, color: "#ef4444" }}>Remove</button>
          </div>
        ) : (
          <button onClick={() => inputRef.current?.click()} style={{ padding: "12px 32px", borderRadius: 6, border: "none", background: "#3b82f6", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Select PDF</button>
        )}
        <input ref={inputRef} type="file" accept=".pdf" onChange={handleFile} style={{ display: "none" }} />
      </div>

      <button onClick={() => handleRemove()} disabled={!file || busy}
        style={{ width: "100%", padding: "14px 0", borderRadius: 8, border: "none", background: !file ? "#e2e8f0" : busy ? "#94a3b8" : "#3b82f6", color: "#fff", fontSize: 16, fontWeight: 600, cursor: !file ? "not-allowed" : "pointer", marginBottom: 24 }}>
        {busy ? "⏳ Analyzing..." : "🧹 Remove Watermark"}
      </button>

      {error && <div style={{ padding: 12, background: "#fef2f2", borderRadius: 8, color: "#dc2626", fontSize: 13, marginBottom: 24 }}>{error}</div>}

      {result && !blob && (
        <div style={{ background: "#f0fdf4", borderRadius: 12, padding: 24, border: "1px solid #bbf7d0" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#166534", marginBottom: 8 }}>✅ Analysis complete</div>
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 12 }}>{intentLabel[result.intent]} · Risk: {result.risk}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
            <div style={{ textAlign: "center", padding: 10, background: "#fff", borderRadius: 6 }}><div style={{ fontSize: 11, color: "#94a3b8" }}>Removed</div><div style={{ fontSize: 16, fontWeight: 700, color: "#059669" }}>{result.removed}</div></div>
            <div style={{ textAlign: "center", padding: 10, background: "#fff", borderRadius: 6 }}><div style={{ fontSize: 11, color: "#94a3b8" }}>Quality</div><div style={{ fontSize: 16, fontWeight: 700, color: c(result.quality) }}>{Math.round(result.quality * 100)}%</div></div>
            <div style={{ textAlign: "center", padding: 10, background: "#fff", borderRadius: 6 }}><div style={{ fontSize: 11, color: "#94a3b8" }}>Pages</div><div style={{ fontSize: 16, fontWeight: 700, color: "#1e293b" }}>{result.pages}</div></div>
          </div>
          {result.paywall === "watermark" && !paid && (
            <div>
              <div style={{ padding: "8px 12px", background: "#fef3c7", borderRadius: 6, fontSize: 12, color: "#92400e", marginBottom: 10 }}>⚠️ Preview mark will be added. Pay $0.99 for clean output.</div>
              <button onClick={handlePay} style={{ marginRight: 8, ...smBtn, background: "#059669", color: "#fff" }}>🎯 Remove Preview Mark ($0.99)</button>
              <button onClick={() => latestBlobRef.current && setBlob(latestBlobRef.current)} style={{ ...smBtn, color: "#64748b" }}>Download with Mark</button>
            </div>
          )}
          {result.paywall === "premium" && !paid && (
            <div>
              <div style={{ padding: "8px 12px", background: "#fef2f2", borderRadius: 6, fontSize: 12, color: "#991b1b", marginBottom: 10 }}>🔒 Sensitive content ({result.intent}). Premium required.</div>
              <button onClick={handlePay} style={{ width: "100%", padding: "12px 0", borderRadius: 8, border: "none", background: "#059669", color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: 15 }}>💳 Unlock (${result.price.toFixed(2)})</button>
            </div>
          )}
          {result.paywall === "free" && <div style={{ textAlign: "center", color: "#059669", fontSize: 13 }}>✅ Free download ready</div>}
        </div>
      )}

      {blob && (
        <div style={{ background: "#f0fdf4", borderRadius: 12, padding: 24, border: "1px solid #bbf7d0", textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#166534", marginBottom: 16 }}>✅ Clean PDF ready!</div>
          <a href={URL.createObjectURL(blob)} download={file?.name.replace(/\.pdf$/i, "-clean.pdf") || "clean.pdf"}
            style={{ display: "inline-block", padding: "12px 36px", borderRadius: 8, background: "#059669", color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 15 }}>
            📥 Download Clean PDF
          </a>
        </div>
      )}
    </div>
  );
}

const smBtn: React.CSSProperties = { padding: "8px 20px", borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 500 };
