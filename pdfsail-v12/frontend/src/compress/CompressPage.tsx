import React, { useState, useRef } from "react";
import { compressPDF } from "./compress-core";

export default function CompressPage() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ original: number; compressed: number; ratio: number; blob: Blob; name: string } | null>(null);
  const [error, setError] = useState("");
  const [quality, setQuality] = useState(60);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) { setFile(f); setResult(null); setError(""); }
  };

  const handleCompress = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const buf = await file.arrayBuffer();
      const res = await compressPDF(new Uint8Array(buf), quality);
      if (res.rejected) {
        setError(`Compression rejected: ${res.reason}`);
        return;
      }
      const blob = new Blob([res.bytes as BlobPart], { type: "application/pdf" });
      setResult({ original: res.originalSize, compressed: res.compressedSize, ratio: res.ratio, blob, name: file.name.replace(".pdf", "-compressed.pdf") });
    } catch (err: any) {
      setError(err.message || "Compression failed");
    }
    setBusy(false);
  };

  const fmt = (b: number) => b < 1024 ? `${b}B` : b < 1048576 ? `${(b / 1024).toFixed(1)}KB` : `${(b / 1048576).toFixed(2)}MB`;

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 36, fontWeight: 800, color: "#1a1a2e", marginBottom: 8 }}>Compress PDF</h1>
      <p style={{ color: "#64748b", marginBottom: 32, fontSize: 15, lineHeight: 1.6 }}>
        Reduce PDF file size while keeping quality. Your files are processed entirely in the browser — nothing is uploaded.
      </p>

      <div style={{ border: "2px dashed #cbd5e1", borderRadius: 12, padding: 40, textAlign: "center", marginBottom: 24, background: file ? "#f0fdf4" : "#fafafa" }}>
        {file ? (
          <div>
            <div style={{ fontSize: 40, marginBottom: 8 }}>📄</div>
            <div style={{ fontWeight: 600, color: "#1e293b" }}>{file.name}</div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>{fmt(file.size)}</div>
            <button onClick={() => { setFile(null); setResult(null); setError(""); }} style={{ marginTop: 10, ...smBtn, color: "#ef4444" }}>Remove</button>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 48, marginBottom: 12 }}>📁</div>
            <button onClick={() => inputRef.current?.click()} style={{ ...smBtn, background: "#3b82f6", color: "#fff", padding: "12px 32px" }}>Select PDF</button>
            <input ref={inputRef} type="file" accept=".pdf" onChange={handleFile} style={{ display: "none" }} />
          </div>
        )}
      </div>

      <div style={{ marginBottom: 24, display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 13, color: "#475569", whiteSpace: "nowrap" }}>Quality:</span>
        <input type="range" min={20} max={95} value={quality} onChange={(e) => setQuality(Number(e.target.value))} style={{ flex: 1 }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: "#1e293b", minWidth: 36 }}>{quality}%</span>
      </div>

      <button onClick={handleCompress} disabled={!file || busy}
        style={{ width: "100%", padding: "14px 0", borderRadius: 8, border: "none", background: !file ? "#e2e8f0" : busy ? "#94a3b8" : "#10b981", color: "#fff", fontSize: 16, fontWeight: 600, cursor: !file ? "not-allowed" : "pointer", marginBottom: 24 }}>
        {busy ? "⏳ Compressing..." : "⚡ Compress PDF"}
      </button>

      {error && <div style={{ padding: 12, background: "#fef2f2", borderRadius: 8, color: "#dc2626", fontSize: 13, marginBottom: 24 }}>{error}</div>}

      {result && (
        <div style={{ background: "#f0fdf4", borderRadius: 12, padding: 24, border: "1px solid #bbf7d0" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#166534", marginBottom: 16 }}>✅ Compression complete!</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 20 }}>
            <div style={{ textAlign: "center", padding: 12, background: "#fff", borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: "#94a3b8" }}>Original</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#1e293b" }}>{fmt(result.original)}</div>
            </div>
            <div style={{ textAlign: "center", padding: 12, background: "#fff", borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: "#94a3b8" }}>Compressed</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#059669" }}>{fmt(result.compressed)}</div>
            </div>
            <div style={{ textAlign: "center", padding: 12, background: "#fff", borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: "#94a3b8" }}>Reduction</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: result.ratio < 1 ? "#059669" : "#dc2626" }}>
                {result.ratio < 1 ? `-${Math.round((1 - result.ratio) * 100)}%` : `+${Math.round((result.ratio - 1) * 100)}%`}
              </div>
            </div>
          </div>
          <a href={URL.createObjectURL(result.blob)} download={result.name}
            style={{ display: "block", textAlign: "center", padding: "12px 0", borderRadius: 8, background: "#059669", color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 15 }}>
            📥 Download Compressed PDF
          </a>
        </div>
      )}
    </div>
  );
}

const smBtn: React.CSSProperties = { padding: "8px 20px", borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 500, display: "inline-block", textDecoration: "none" };
