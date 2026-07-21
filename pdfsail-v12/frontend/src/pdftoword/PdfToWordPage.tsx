import React, { useState, useRef } from "react";
import { convertPdfToDocx, DocDomain } from "./pdftoword-core";

export default function PdfToWordPage() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ quality: number; value: number; domain: DocDomain; fromOcr: boolean; paywall: string; price: number } | null>(null);
  const [paid, setPaid] = useState(false);
  const latestRef = useRef<Blob | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const domainLabel: Record<DocDomain, string> = { resume: "📄 Resume", invoice: "🧾 Invoice", report: "📊 Report", letter: "✉️ Letter", unknown: "📝 Document" };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) { setFile(f); setBlob(null); setResult(null); setError(""); setPaid(false); }
  };

  const handleConvert = async (skipPay?: boolean) => {
    if (!file) return;
    setBusy(true); setError(""); setBlob(null); setResult(null);
    try {
      const buf = await file.arrayBuffer();
      const res = await convertPdfToDocx(new Uint8Array(buf));
      latestRef.current = res.blob;
      setResult({ quality: res.quality, value: res.value, domain: res.domain, fromOcr: res.fromOcr, paywall: res.paywall, price: res.price });
      if (skipPay || res.paywall !== "premium") setBlob(res.blob);
    } catch (err: any) { setError(err.message || "Conversion failed"); }
    setBusy(false);
  };

  const handlePay = () => { setPaid(true); handleConvert(true); };
  const c = (s: number) => s > 0.7 ? "#059669" : s > 0.4 ? "#d97706" : "#dc2626";

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 36, fontWeight: 800, color: "#1a1a2e", marginBottom: 8 }}>PDF to Word</h1>
      <p style={{ color: "#64748b", marginBottom: 32, fontSize: 15, lineHeight: 1.6 }}>
        Convert PDF to Word with intelligent layout reconstruction. Supports multi-column, tables, lists, and scanned documents (OCR). Automatically detects document type for optimal conversion.
      </p>

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

      <button onClick={() => handleConvert()} disabled={!file || busy}
        style={{ width: "100%", padding: "14px 0", borderRadius: 8, border: "none", background: !file ? "#e2e8f0" : busy ? "#94a3b8" : "#3b82f6", color: "#fff", fontSize: 16, fontWeight: 600, cursor: !file ? "not-allowed" : "pointer", marginBottom: 24 }}>
        {busy ? "⏳ Converting..." : "📄 → 📝 Convert to Word"}
      </button>

      {error && <div style={{ padding: 12, background: "#fef2f2", borderRadius: 8, color: "#dc2626", fontSize: 13, marginBottom: 24 }}>{error}</div>}

      {result && !blob && (
        <div style={{ background: "#f0fdf4", borderRadius: 12, padding: 24, border: "1px solid #bbf7d0" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#166534", marginBottom: 4 }}>✅ Analysis complete</div>
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 12 }}>
            {domainLabel[result.domain]} {result.fromOcr ? "· 🔍 OCR applied" : ""} · v1+v2+v3+v4 pipeline
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
            <div style={{ textAlign: "center", padding: 10, background: "#fff", borderRadius: 6 }}>
              <div style={{ fontSize: 11, color: "#94a3b8" }}>Conversion Quality</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: c(result.quality) }}>{Math.round(result.quality * 100)}%</div>
            </div>
            <div style={{ textAlign: "center", padding: 10, background: "#fff", borderRadius: 6 }}>
              <div style={{ fontSize: 11, color: "#94a3b8" }}>Business Value</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: c(result.value) }}>{Math.round(result.value * 100)}%</div>
            </div>
          </div>
          {result.paywall === "watermark" && !paid && (
            <div>
              <div style={{ padding: "8px 12px", background: "#fef3c7", borderRadius: 6, fontSize: 12, color: "#92400e", marginBottom: 10 }}>⚠️ Free version adds a small preview mark.</div>
              <button onClick={handlePay} style={{ marginRight: 8, ...smBtn, background: "#059669", color: "#fff" }}>🎯 Remove Mark ($0.99)</button>
              <button onClick={() => latestRef.current && setBlob(latestRef.current)} style={{ ...smBtn, color: "#64748b" }}>Download with Mark</button>
            </div>
          )}
          {result.paywall === "premium" && !paid && (
            <div>
              <div style={{ padding: "8px 12px", background: "#fef2f2", borderRadius: 6, fontSize: 12, color: "#991b1b", marginBottom: 10 }}>🔒 {result.domain === "resume" ? "Resume" : "High-value document"} — premium conversion required.</div>
              <button onClick={handlePay} style={{ width: "100%", padding: "12px 0", borderRadius: 8, border: "none", background: "#059669", color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: 15 }}>💳 Unlock (${result.price.toFixed(2)})</button>
            </div>
          )}
          {result.paywall === "free" && <div style={{ textAlign: "center", color: "#059669", fontSize: 13, padding: 8, background: "#ecfdf5", borderRadius: 6 }}>✅ Free download ready</div>}
        </div>
      )}

      {blob && (
        <div style={{ background: "#f0fdf4", borderRadius: 12, padding: 24, border: "1px solid #bbf7d0", textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#166534", marginBottom: 16 }}>✅ Conversion ready!</div>
          <a href={URL.createObjectURL(blob)} download={file?.name.replace(/\.pdf$/i, ".docx") || "converted.docx"}
            style={{ display: "inline-block", padding: "12px 36px", borderRadius: 8, background: "#2563eb", color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 15 }}>
            📥 Download DOCX
          </a>
        </div>
      )}
    </div>
  );
}

const smBtn: React.CSSProperties = { padding: "8px 20px", borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 500 };
