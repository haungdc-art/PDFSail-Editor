import React, { useState, useRef } from "react";
import { mergePDFs } from "./merge-core";

export default function MergePage() {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fs = e.target.files;
    if (fs) setFiles((prev) => [...prev, ...Array.from(fs)]);
  };

  const removeFile = (i: number) => setFiles((prev) => prev.filter((_, idx) => idx !== i));

  const handleMerge = async () => {
    if (files.length < 2) return;
    setBusy(true); setError(""); setBlob(null);
    try {
      const bufs = await Promise.all(files.map((f) => f.arrayBuffer().then((b) => new Uint8Array(b))));
      const out = await mergePDFs(bufs);
      setBlob(new Blob([out as BlobPart], { type: "application/pdf" }));
    } catch (err: any) { setError(err.message || "Merge failed"); }
    setBusy(false);
  };

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 36, fontWeight: 800, color: "#1a1a2e", marginBottom: 8 }}>Merge PDF</h1>
      <p style={{ color: "#64748b", marginBottom: 32, fontSize: 15 }}>Combine multiple PDF files into one document. Select 2 or more files.</p>

      <div style={{ border: "2px dashed #cbd5e1", borderRadius: 12, padding: 32, textAlign: "center", marginBottom: 24, background: "#fafafa" }}>
        <button onClick={() => inputRef.current?.click()} style={{ padding: "12px 32px", borderRadius: 6, border: "none", background: "#3b82f6", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>+ Add PDF</button>
        <input ref={inputRef} type="file" accept=".pdf" multiple onChange={addFiles} style={{ display: "none" }} />
      </div>

      {files.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          {files.map((f, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#f8fafc", borderRadius: 6, marginBottom: 4 }}>
              <span style={{ flex: 1, fontSize: 13, color: "#1e293b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i + 1}. {f.name}</span>
              <button onClick={() => removeFile(i)} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 14 }}>×</button>
            </div>
          ))}
        </div>
      )}

      <button onClick={handleMerge} disabled={files.length < 2 || busy}
        style={{ width: "100%", padding: "14px 0", borderRadius: 8, border: "none", background: files.length < 2 ? "#e2e8f0" : busy ? "#94a3b8" : "#8b5cf6", color: "#fff", fontSize: 16, fontWeight: 600, cursor: files.length < 2 ? "not-allowed" : "pointer", marginBottom: 24 }}>
        {busy ? "⏳ Merging..." : files.length < 2 ? `Add ${2 - files.length} more file(s)` : "🔗 Merge PDFs"}
      </button>

      {error && <div style={{ padding: 12, background: "#fef2f2", borderRadius: 8, color: "#dc2626", fontSize: 13, marginBottom: 24 }}>{error}</div>}

      {blob && (
        <div style={{ background: "#f0fdf4", borderRadius: 12, padding: 24, border: "1px solid #bbf7d0", textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#166534", marginBottom: 16 }}>✅ Merge complete! ({files.length} files → 1 PDF)</div>
          <a href={URL.createObjectURL(blob)} download="merged.pdf"
            style={{ display: "inline-block", padding: "12px 36px", borderRadius: 8, background: "#059669", color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 15 }}>
            📥 Download Merged PDF
          </a>
        </div>
      )}
    </div>
  );
}
