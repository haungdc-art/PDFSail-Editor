import React, { useState, useRef } from "react";
import { convertPdfToExcel, DocDomain } from "./pdftoexcel-core";

export default function PdfToExcelPage() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<{ quality: number; value: number; domain: DocDomain; rows: number; cols: number; conf: number; fromOcr: boolean; price: number; paywall: string } | null>(null);
  const [paid, setPaid] = useState(false);
  const latestBlobRef = useRef<Blob | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const domainLabel: Record<DocDomain, string> = { invoice: "📄 Invoice", bank_statement: "🏦 Bank Statement", report: "📊 Report", unknown: "📋 Table" };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) { setFile(f); setBlob(null); setResult(null); setError(""); setPaid(false); }
  };

  const handleConvert = async (skipPay?: boolean) => {
    if (!file) return;
    setBusy(true); setError(""); setBlob(null); setResult(null); setPaid(false);
    setProgress("📖 Analyzing PDF...");
    try {
      const buf = await file.arrayBuffer();
      setProgress(result?.fromOcr ? "🔍 Running OCR on scanned PDF..." : "🔍 Detecting tables and rebuilding structure...");
      const conv = await convertPdfToExcel(new Uint8Array(buf));
      setResult({
        quality: conv.qualityScore, value: conv.businessValue, domain: conv.docDomain,
        rows: conv.rowCount, cols: conv.colCount, conf: conv.tableConfidence,
        fromOcr: conv.fromOcr, price: conv.price, paywall: conv.paywall,
      });
      latestBlobRef.current = conv.blob;
      if (skipPay || conv.paywall !== "premium") {
        setBlob(conv.blob);
      }
    } catch (err: any) { setError(err.message || "Conversion failed"); }
    setBusy(false);
    setProgress("");
  };

  const handlePay = () => {
    setPaid(true);
    handleConvert(true);
  };

  const scoreColor = (s: number) => s > 0.7 ? "#059669" : s > 0.4 ? "#d97706" : "#dc2626";

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 36, fontWeight: 800, color: "#1a1a2e", marginBottom: 8 }}>PDF to Excel</h1>
      <p style={{ color: "#64748b", marginBottom: 32, fontSize: 15, lineHeight: 1.6 }}>
        Extract tables from PDF into Excel. Supports text PDFs and scanned documents (OCR). Domain-aware normalization for invoices, bank statements, and reports.
      </p>

      <div style={{ border: "2px dashed #cbd5e1", borderRadius: 12, padding: 32, textAlign: "center", marginBottom: 24, background: file ? "#f0fdf4" : "#fafafa" }}>
        {file ? (
          <div>
            <div style={{ fontSize: 40, marginBottom: 8 }}>📄</div>
            <div style={{ fontWeight: 600, color: "#1e293b" }}>{file.name}</div>
            <button onClick={() => { setFile(null); setBlob(null); setResult(null); }} style={{ marginTop: 6, ...smBtn, color: "#ef4444" }}>Remove</button>
          </div>
        ) : (
          <button onClick={() => inputRef.current?.click()} style={{ padding: "12px 32px", borderRadius: 6, border: "none", background: "#059669", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Select PDF</button>
        )}
        <input ref={inputRef} type="file" accept=".pdf" onChange={handleFile} style={{ display: "none" }} />
      </div>

      <button onClick={() => handleConvert()} disabled={!file || busy}
        style={{ width: "100%", padding: "14px 0", borderRadius: 8, border: "none", background: !file ? "#e2e8f0" : busy ? "#94a3b8" : "#059669", color: "#fff", fontSize: 16, fontWeight: 600, cursor: !file ? "not-allowed" : "pointer", marginBottom: 24 }}>
        {busy ? "⏳ Processing..." : "📄 → 📊 Convert to Excel"}
      </button>

      {progress && <div style={{ padding: 12, background: "#ecfdf5", borderRadius: 8, color: "#059669", fontSize: 13, marginBottom: 24 }}>{progress}</div>}
      {error && <div style={{ padding: 12, background: "#fef2f2", borderRadius: 8, color: "#dc2626", fontSize: 13, marginBottom: 24 }}>{error}</div>}

      {result && (
        <div style={{ background: "#f0fdf4", borderRadius: 12, padding: 24, border: "1px solid #bbf7d0" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#166534", marginBottom: 8 }}>✅ Analysis complete!</div>
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 16 }}>
            {result.fromOcr ? "🔍 OCR applied (scanned PDF)" : "📖 Native text extraction"} · {domainLabel[result.domain]}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
            <div style={{ textAlign: "center", padding: 10, background: "#fff", borderRadius: 6 }}>
              <div style={{ fontSize: 11, color: "#94a3b8" }}>Quality</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: scoreColor(result.quality) }}>{Math.round(result.quality * 100)}%</div>
            </div>
            <div style={{ textAlign: "center", padding: 10, background: "#fff", borderRadius: 6 }}>
              <div style={{ fontSize: 11, color: "#94a3b8" }}>Business Value</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: scoreColor(result.value) }}>{Math.round(result.value * 100)}%</div>
            </div>
            <div style={{ textAlign: "center", padding: 10, background: "#fff", borderRadius: 6 }}>
              <div style={{ fontSize: 11, color: "#94a3b8" }}>Table Confidence</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#1e293b" }}>{Math.round(result.conf * 100)}%</div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
            <div style={{ textAlign: "center", padding: 10, background: "#fff", borderRadius: 6 }}>
              <div style={{ fontSize: 11, color: "#94a3b8" }}>Rows</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#1e293b" }}>{result.rows}</div>
            </div>
            <div style={{ textAlign: "center", padding: 10, background: "#fff", borderRadius: 6 }}>
              <div style={{ fontSize: 11, color: "#94a3b8" }}>Columns</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#1e293b" }}>{result.cols}</div>
            </div>
          </div>

          {!blob && result.paywall === "free" && (
            <div style={{ padding: "8px 12px", background: "#ecfdf5", borderRadius: 6, fontSize: 13, color: "#065f46", textAlign: "center" }}>
              ✅ Free conversion — click "Convert" to download again
            </div>
          )}

          {!blob && result.paywall === "watermark" && !paid && (
            <div>
              <div style={{ padding: "8px 12px", background: "#fef3c7", borderRadius: 6, fontSize: 12, color: "#92400e", marginBottom: 10 }}>
                ⚠️ This conversion has a watermark in the free version. Pay $0.99 to remove.
              </div>
              <button onClick={handlePay} style={{ marginRight: 8, padding: "10px 20px", borderRadius: 6, border: "none", background: "#059669", color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: 14 }}>
                🎯 Remove Watermark ($0.99)
              </button>
              <button onClick={() => latestBlobRef.current && setBlob(latestBlobRef.current)} style={{ padding: "10px 20px", borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff", color: "#64748b", cursor: "pointer", fontSize: 14 }}>
                Download with Watermark
              </button>
            </div>
          )}

          {!blob && result.paywall === "premium" && !paid && (
            <div>
              <div style={{ padding: "8px 12px", background: "#fef2f2", borderRadius: 6, fontSize: 12, color: "#991b1b", marginBottom: 10 }}>
                🔒 This document contains high-value data (invoice/bank statement). Premium conversion required.
              </div>
              <button onClick={handlePay} style={{ width: "100%", padding: "12px 0", borderRadius: 8, border: "none", background: "#059669", color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: 15 }}>
                💳 Unlock & Download (${result.price.toFixed(2)})
              </button>
            </div>
          )}

          {blob && (
            <a href={URL.createObjectURL(blob)} download={file?.name.replace(/\.pdf$/i, ".xlsx") || "converted.xlsx"}
              style={{ display: "block", textAlign: "center", padding: "12px 0", borderRadius: 8, background: "#059669", color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 15 }}>
              📥 Download XLSX
            </a>
          )}
        </div>
      )}
    </div>
  );
}

const smBtn: React.CSSProperties = { padding: "6px 16px", borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 500 };
