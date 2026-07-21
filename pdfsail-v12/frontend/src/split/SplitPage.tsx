import React, { useState, useRef } from "react";
import { splitPDF } from "./split-core";

export default function SplitPage() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [blobs, setBlobs] = useState<{ name: string; blob: Blob }[]>([]);
  const [totalPages, setTotalPages] = useState(0);
  const [range, setRange] = useState({ from: 1, to: 1 });
  const [mode, setMode] = useState<"all" | "range">("all");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) { setFile(f); setBlobs([]); setError(""); }
  };

  const handleSplit = async () => {
    if (!file) return;
    setBusy(true); setError(""); setBlobs([]);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const rangeArg = mode === "range" ? [range.from - 1, range.to - 1] as [number, number] : undefined;
      const res = await splitPDF(buf, mode, rangeArg);
      setTotalPages(res.totalPages);
      setBlobs(res.pages.map((p) => ({
        name: `${file.name.replace(".pdf", "")}-page-${p.index + 1}.pdf`,
        blob: new Blob([p.bytes as BlobPart], { type: "application/pdf" }),
      })));
    } catch (err: any) { setError(err.message || "Split failed"); }
    setBusy(false);
  };

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 36, fontWeight: 800, color: "#1a1a2e", marginBottom: 8 }}>Split PDF</h1>
      <p style={{ color: "#64748b", marginBottom: 32, fontSize: 15 }}>Split a PDF into separate pages or extract a page range.</p>

      <div style={{ border: "2px dashed #cbd5e1", borderRadius: 12, padding: 32, textAlign: "center", marginBottom: 24, background: file ? "#f0fdf4" : "#fafafa" }}>
        {file ? (
          <div>
            <div style={{ fontWeight: 600, color: "#1e293b" }}>{file.name}</div>
            <button onClick={() => { setFile(null); setBlobs([]); }} style={{ marginTop: 8, ...smBtn, color: "#ef4444" }}>Remove</button>
          </div>
        ) : (
          <button onClick={() => inputRef.current?.click()} style={{ padding: "12px 32px", borderRadius: 6, border: "none", background: "#3b82f6", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Select PDF</button>
        )}
        <input ref={inputRef} type="file" accept=".pdf" onChange={handleFile} style={{ display: "none" }} />
      </div>

      <div style={{ display: "flex", gap: 16, marginBottom: 24 }}>
        <button onClick={() => setMode("all")} style={{ flex: 1, padding: "10px", borderRadius: 6, border: mode === "all" ? "2px solid #8b5cf6" : "1px solid #e2e8f0", background: mode === "all" ? "#f5f3ff" : "#fff", cursor: "pointer", fontWeight: 500, fontSize: 13 }}>📄 Split All Pages</button>
        <button onClick={() => setMode("range")} style={{ flex: 1, padding: "10px", borderRadius: 6, border: mode === "range" ? "2px solid #8b5cf6" : "1px solid #e2e8f0", background: mode === "range" ? "#f5f3ff" : "#fff", cursor: "pointer", fontWeight: 500, fontSize: 13 }}>🔢 Page Range</button>
      </div>

      {mode === "range" && (
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 24, fontSize: 13 }}>
          <span style={{ color: "#475569" }}>From:</span>
          <input type="number" min={1} value={range.from} onChange={(e) => setRange((p) => ({ ...p, from: Math.max(1, Number(e.target.value)) }))} style={{ width: 60, padding: "6px 8px", borderRadius: 4, border: "1px solid #e2e8f0", fontSize: 13 }} />
          <span style={{ color: "#475569" }}>To:</span>
          <input type="number" min={range.from} value={range.to} onChange={(e) => setRange((p) => ({ ...p, to: Math.max(p.from, Number(e.target.value)) }))} style={{ width: 60, padding: "6px 8px", borderRadius: 4, border: "1px solid #e2e8f0", fontSize: 13 }} />
        </div>
      )}

      <button onClick={handleSplit} disabled={!file || busy}
        style={{ width: "100%", padding: "14px 0", borderRadius: 8, border: "none", background: !file ? "#e2e8f0" : busy ? "#94a3b8" : "#8b5cf6", color: "#fff", fontSize: 16, fontWeight: 600, cursor: !file ? "not-allowed" : "pointer", marginBottom: 24 }}>
        {busy ? "⏳ Splitting..." : "✂️ Split PDF"}
      </button>

      {error && <div style={{ padding: 12, background: "#fef2f2", borderRadius: 8, color: "#dc2626", fontSize: 13, marginBottom: 24 }}>{error}</div>}

      {blobs.length > 0 && (
        <div style={{ background: "#f0fdf4", borderRadius: 12, padding: 24, border: "1px solid #bbf7d0" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#166534", marginBottom: 16 }}>✅ Split complete! ({blobs.length}/{totalPages} pages)</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {blobs.map((b, i) => (
              <a key={i} href={URL.createObjectURL(b.blob)} download={b.name}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "#fff", borderRadius: 6, textDecoration: "none", color: "#1e293b", fontSize: 13, border: "1px solid #e2e8f0" }}>
                <span style={{ background: "#8b5cf6", color: "#fff", borderRadius: 4, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>P.{i + 1}</span>
                <span style={{ flex: 1 }}>{b.name}</span>
                <span style={{ color: "#8b5cf6", fontWeight: 600 }}>Download</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const smBtn: React.CSSProperties = { padding: "6px 16px", borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 500 };
