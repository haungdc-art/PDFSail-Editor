import React, { useState, useRef } from "react";
import { rotatePDF } from "./rotate-core";

export default function RotatePage() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState("");
  const [degrees, setDegrees] = useState<90 | 180 | 270>(90);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) { setFile(f); setBlob(null); setError(""); }
  };

  const handleRotate = async () => {
    if (!file) return;
    setBusy(true); setError(""); setBlob(null);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const out = await rotatePDF(buf, degrees);
      setBlob(new Blob([out as BlobPart], { type: "application/pdf" }));
    } catch (err: any) { setError(err.message || "Rotate failed"); }
    setBusy(false);
  };

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 36, fontWeight: 800, color: "#1a1a2e", marginBottom: 8 }}>Rotate PDF</h1>
      <p style={{ color: "#64748b", marginBottom: 32, fontSize: 15 }}>Rotate all pages in your PDF by 90°, 180°, or 270°.</p>

      <div style={{ border: "2px dashed #cbd5e1", borderRadius: 12, padding: 32, textAlign: "center", marginBottom: 24, background: file ? "#f0fdf4" : "#fafafa" }}>
        {file ? (
          <div>
            <div style={{ fontWeight: 600, color: "#1e293b" }}>{file.name}</div>
            <button onClick={() => { setFile(null); setBlob(null); }} style={{ marginTop: 8, ...smBtn, color: "#ef4444" }}>Remove</button>
          </div>
        ) : (
          <button onClick={() => inputRef.current?.click()} style={{ padding: "12px 32px", borderRadius: 6, border: "none", background: "#3b82f6", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Select PDF</button>
        )}
        <input ref={inputRef} type="file" accept=".pdf" onChange={handleFile} style={{ display: "none" }} />
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        {[90, 180, 270].map((d) => (
          <button key={d} onClick={() => setDegrees(d as 90 | 180 | 270)}
            style={{ flex: 1, padding: "14px 0", borderRadius: 8, border: degrees === d ? "2px solid #3b82f6" : "1px solid #e2e8f0", background: degrees === d ? "#eff6ff" : "#fff", cursor: "pointer", fontWeight: 600, fontSize: 16 }}>
            {d}° {d === 90 ? "↩" : d === 180 ? "↩↪" : "↪"}
          </button>
        ))}
      </div>

      <button onClick={handleRotate} disabled={!file || busy}
        style={{ width: "100%", padding: "14px 0", borderRadius: 8, border: "none", background: !file ? "#e2e8f0" : busy ? "#94a3b8" : "#3b82f6", color: "#fff", fontSize: 16, fontWeight: 600, cursor: !file ? "not-allowed" : "pointer", marginBottom: 24 }}>
        {busy ? "⏳ Rotating..." : "🔄 Rotate PDF"}
      </button>

      {error && <div style={{ padding: 12, background: "#fef2f2", borderRadius: 8, color: "#dc2626", fontSize: 13, marginBottom: 24 }}>{error}</div>}

      {blob && (
        <div style={{ background: "#f0fdf4", borderRadius: 12, padding: 24, border: "1px solid #bbf7d0", textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#166534", marginBottom: 16 }}>✅ Rotation complete!</div>
          <a href={URL.createObjectURL(blob)} download={file?.name.replace(".pdf", "-rotated.pdf") || "rotated.pdf"}
            style={{ display: "inline-block", padding: "12px 36px", borderRadius: 8, background: "#059669", color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 15 }}>
            📥 Download Rotated PDF
          </a>
        </div>
      )}
    </div>
  );
}

const smBtn: React.CSSProperties = { padding: "6px 16px", borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 500 };
