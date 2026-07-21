import React, { useState, useRef, useCallback, useMemo } from "react";
import type {
  AnalyzeResult,
  TriggerResult,
  ActionResult,
  UploadResult,
  PageState,
} from "./types";
import "./value-probe.css";

const API_BASE = import.meta.env.VITE_API_BASE || "";

// ── A/B Test Copy Variants ──

type CopyVariant = "A" | "B" | "C";

interface CopySet {
  badge: string;
  detection: string;
  implication: string;
  incompletion: string;
  cta: string;
  actionTitle: string;
  actionReason: string;
  confirmationTitle: string;
  checkmarks: string[];
  continuation: string;
}

const COPY_A: CopySet = {
  badge: "Structured Content Found",
  detection: "We detected structured data in your document.",
  implication: "This data is currently not accessible in its raw form inside the PDF.",
  incompletion: "You are currently seeing a static version of your document. Important data may still be locked inside this PDF.",
  cta: "Unlock More Value",
  actionTitle: "Extract Structured Data",
  actionReason: "Your document contains structured data patterns that can be extracted into a usable format.",
  confirmationTitle: "Your document has been enhanced",
  checkmarks: ["Extracted structured data", "Converted to usable format", "Ready for download"],
  continuation: "This document may have further improvement opportunities. Upload another to continue.",
};

const COPY_B: CopySet = {
  badge: "Value Detected",
  detection: "We found high-value structured content in this document.",
  implication: "This file may contain extractable data that is currently locked inside PDF format.",
  incompletion: "You are currently seeing a static version of your document. Important data may still be locked and unavailable for editing, analysis, or export.",
  cta: "🔥 Unlock Full Value",
  actionTitle: "Transform to Usable Format",
  actionReason: "This document contains structured data that can be transformed into editable tables. You may be missing actionable data extraction that could significantly increase usability.",
  confirmationTitle: "Your document has been enhanced",
  checkmarks: ["Extracted structured data", "Converted to fully usable format", "Ready for download and analysis"],
  continuation: "This document may have further improvement opportunities. Upload another document to extract more value.",
};

const COPY_C: CopySet = {
  badge: "Incomplete Document",
  detection: "This document contains valuable data that is currently locked inside PDF format.",
  implication: "Key information is still not usable in its current form. You are likely missing structured content that could be extracted.",
  incompletion: "This document is not fully processed. You are currently seeing a static version only — important data remains locked and unavailable for editing, searching, or analysis.",
  cta: "🔥 Complete Processing",
  actionTitle: "Unlock Document Usability",
  actionReason: "This file is not fully processed. Key information is still locked inside the PDF format. Complete processing to unlock full usability — including editable tables, structured text, and reusable content formats.",
  confirmationTitle: "Your document has been enhanced",
  checkmarks: ["Unlocked structured data from PDF", "Converted to fully usable format", "Ready for editing and analysis"],
  continuation: "This document may have further improvement opportunities. Continue processing to unlock more value.",
};

const COPY_BY_SIGNAL: Record<string, { detection: string; implication: string }> = {
  financial_document: {
    detection: "We detected structured financial data in your document.",
    implication: "This means this file can be transformed into editable tables for analysis.",
  },
  contract_document: {
    detection: "We identified contract or legal document characteristics.",
    implication: "Files like this are typically processed further for review or analysis workflows.",
  },
  table_like_structure: {
    detection: "We detected structured data patterns in your document.",
    implication: "This information is currently not usable in its current form.",
  },
  likely_scanned: {
    detection: "This document appears to be scanned — text is not directly accessible.",
    implication: "OCR processing can unlock the text content for searching and editing.",
  },
  multi_page: {
    detection: "This is a multi-page document with significant content.",
    implication: "Long documents often contain hidden value across multiple sections that remain unprocessed.",
  },
  rich_text: {
    detection: "We detected rich text content suitable for further processing.",
    implication: "This content can be converted to a fully editable format beyond the PDF.",
  },
};

function getCopy(variant: CopyVariant, signals: string[]): CopySet {
  let base: CopySet;
  if (variant === "A") base = { ...COPY_A };
  else if (variant === "C") base = { ...COPY_C };
  else base = { ...COPY_B };

  for (const s of signals) {
    const sigCopy = COPY_BY_SIGNAL[s];
    if (sigCopy) {
      base.detection = sigCopy.detection;
      base.implication = sigCopy.implication;
      break;
    }
  }
  return base;
}

// ── Component ──

export default function ValueProbePage() {
  const [pageState, setPageState] = useState<PageState>("upload");
  const [errorMsg, setErrorMsg] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const [variant] = useState<CopyVariant>(() => {
    const r = Math.random();
    return r < 0.33 ? "A" : r < 0.66 ? "B" : "C";
  });

  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [analyzeResult, setAnalyzeResult] = useState<AnalyzeResult | null>(null);
  const [triggerResult, setTriggerResult] = useState<TriggerResult | null>(null);
  const [actionResult, setActionResult] = useState<ActionResult | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const copySet = useMemo(() => {
    if (!analyzeResult) return null;
    return getCopy(variant, analyzeResult.signals);
  }, [variant, analyzeResult]);

  const trackEvent = useCallback(async (docId: string, event: string) => {
    try {
      await fetch(`${API_BASE}/api/value/event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_id: docId, event, metadata: { variant } }),
      });
    } catch {}
  }, [variant]);

  // ── Upload ──

  const uploadFile = useCallback(async (file: File) => {
    setPageState("analyzing");
    setErrorMsg("");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const uploadRes = await fetch(`${API_BASE}/api/value/upload`, {
        method: "POST",
        body: formData,
      });
      if (!uploadRes.ok) throw new Error("Upload failed");
      const uploadData: UploadResult = await uploadRes.json();
      setUploadResult(uploadData);
      trackEvent(uploadData.doc_id, "upload");

      const analyzeRes = await fetch(`${API_BASE}/api/value/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_id: uploadData.doc_id }),
      });
      if (!analyzeRes.ok) throw new Error("Analysis failed");
      const analyzeData: AnalyzeResult = await analyzeRes.json();
      setAnalyzeResult(analyzeData);
      trackEvent(uploadData.doc_id, "analyze");

      setPageState("result");
    } catch (err: any) {
      setErrorMsg(err.message || "Something went wrong");
      setPageState("error");
    }
  }, [trackEvent]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type === "application/pdf") {
      uploadFile(file);
    } else {
      setErrorMsg("Please upload a PDF file");
      setPageState("error");
    }
  }, [uploadFile]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
  }, [uploadFile]);

  // ── Open Loop Click ──

  const handleUnlockValue = useCallback(async () => {
    if (!uploadResult) return;
    setPageState("action");
    trackEvent(uploadResult.doc_id, "open_loop_view");

    try {
      const triggerRes = await fetch(`${API_BASE}/api/value/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_id: uploadResult.doc_id }),
      });
      if (!triggerRes.ok) throw new Error("Trigger failed");
      const triggerData: TriggerResult = await triggerRes.json();
      setTriggerResult(triggerData);
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to load recommendation");
      setPageState("error");
    }
  }, [uploadResult, trackEvent]);

  // ── Execute Action ──

  const handleExecute = useCallback(async () => {
    if (!uploadResult || !triggerResult?.action) return;
    setPageState("executing");
    trackEvent(uploadResult.doc_id, "click_action");

    try {
      const actionRes = await fetch(`${API_BASE}/api/value/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doc_id: uploadResult.doc_id,
          action: triggerResult.action,
        }),
      });
      if (!actionRes.ok) throw new Error("Action failed");
      const actionData: ActionResult = await actionRes.json();
      setActionResult(actionData);
      setPageState("done");
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to execute action");
      setPageState("error");
    }
  }, [uploadResult, triggerResult, trackEvent]);

  // ── Reset ──

  const handleReset = () => {
    setPageState("upload");
    setErrorMsg("");
    setUploadResult(null);
    setAnalyzeResult(null);
    setTriggerResult(null);
    setActionResult(null);
  };

  const scorePercent = analyzeResult ? Math.min((analyzeResult.score / 10) * 100, 100) : 0;

  // ── Render ──

  return (
    <div className="value-probe-container">

      {/* ═══════ Stage 1: Upload ═══════ */}
      {pageState === "upload" && (
        <div className="upload-form">
          <h1>Upload your PDF</h1>
          <p>We'll analyze your document and find hidden opportunities you might have missed.</p>
          <div
            className={`upload-zone ${dragOver ? "dragging" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <span className="upload-icon">📄</span>
            <h2>Drop your PDF here</h2>
            <p>or click to browse files</p>
          </div>
          <input ref={fileInputRef} type="file" accept=".pdf,application/pdf" style={{ display: "none" }} onChange={handleFileSelect} />
        </div>
      )}

      {/* ═══════ Stage 2: Passive Processing ═══════ */}
      {pageState === "analyzing" && (
        <div className="analyzing-state">
          <div className="analyzing-spinner" />
          <h2>Analyzing your document...</h2>
          <p>This will take just a moment</p>
        </div>
      )}

      {/* ═══════ Stage 3-5: Value Suggestion → Incompletion → CTA ═══════ */}
      {pageState === "result" && analyzeResult && copySet && (
        <div className="result-card">
          {/* Step 1: Value Suggestion */}
          <div className={`badge badge-yes`}>
            {copySet.badge}
          </div>
          <div style={{ color: "#e0e0e0", fontSize: 20, fontWeight: 600, marginBottom: 16, lineHeight: 1.4 }}>
            {copySet.detection}
          </div>
          <div style={{
            background: "rgba(124,92,252,0.08)", borderLeft: "3px solid #7c5cfc",
            padding: "14px 16px", borderRadius: "0 8px 8px 0", marginBottom: 20,
            fontSize: 13, color: "#c0b0e0", lineHeight: 1.6,
          }}>
            {copySet.implication}
          </div>

          {/* Step 2: Perceived Incompletion (Open Loop closes here) */}
          <div style={{
            background: "rgba(250,204,21,0.06)", border: "1px solid rgba(250,204,21,0.2)",
            borderRadius: 10, padding: "14px 16px", marginBottom: 20,
            fontSize: 13, color: "#d4c080", lineHeight: 1.6,
          }}>
            {copySet.incompletion}
          </div>

          {/* Subtle metadata (not technical details) */}
          {analyzeResult.valueFlag === "YES" && (
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              color: "#666", fontSize: 12, marginBottom: 20,
            }}>
              <span>{analyzeResult.page_count} pages</span>
              <span style={{ opacity: 0.3 }}>·</span>
              <span>Score {analyzeResult.score}/10</span>
              {analyzeResult.signals.length > 0 && (
                <>
                  <span style={{ opacity: 0.3 }}>·</span>
                  <span>{analyzeResult.signals.length} signals detected</span>
                </>
              )}
            </div>
          )}

          {/* Step 3: Single CTA */}
          {analyzeResult.valueFlag === "YES" && (
            <button className="cta-button" onClick={handleUnlockValue}>
              {copySet.cta}
            </button>
          )}

          {analyzeResult.valueFlag !== "YES" && (
            <div style={{ textAlign: "center", marginTop: 24 }}>
              <div style={{ color: "#888", fontSize: 13, marginBottom: 16 }}>
                This document appears to be straightforward with limited further processing value.
              </div>
              <button className="secondary-button" onClick={handleReset}>Try another document</button>
            </div>
          )}

          <div style={{ textAlign: "center", marginTop: 14, fontSize: 10, color: "#444" }}>
            variant {variant}
          </div>
        </div>
      )}

      {/* ═══════ Stage 6: Single Action ═══════ */}
      {pageState === "action" && triggerResult && copySet && (
        <div className="action-card">
          <div className="action-title">Recommended Action</div>
          <h2>{copySet.actionTitle}</h2>
          <div className="action-reason" style={{ lineHeight: 1.6 }}>{copySet.actionReason}</div>
          <button className="cta-button" onClick={handleExecute}>
            Execute
          </button>
        </div>
      )}

      {/* ═══════ Stage 6b: Executing ═══════ */}
      {pageState === "executing" && (
        <div className="analyzing-state">
          <div className="analyzing-spinner" />
          <h2>Processing your document...</h2>
          <p>Extracting and preparing the result</p>
        </div>
      )}

      {/* ═══════ Stage 7-8: Value Confirmation + Continuation ═══════ */}
      {pageState === "done" && actionResult && copySet && (
        <div className="action-card">
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            padding: "8px 16px", borderRadius: 20,
            background: "#1a3a2e", color: "#4ade80",
            fontSize: 14, fontWeight: 600, marginBottom: 20,
          }}>
            ✓ {copySet.confirmationTitle}
          </div>

          <div style={{ color: "#b0b0b0", fontSize: 14, lineHeight: 1.6, marginBottom: 16 }}>
            {copySet.checkmarks.map((m, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                <span style={{ color: "#4ade80", fontSize: 14 }}>✔</span>
                <span>{m}</span>
              </div>
            ))}
          </div>

          {actionResult.preview && (
            <div className="preview-box">{actionResult.preview}</div>
          )}

          {actionResult.result_url && (
            <a href={`${API_BASE}/api${actionResult.result_url}`} download
              className="cta-button" style={{ textAlign: "center", textDecoration: "none" }}>
              📥 Download Result
            </a>
          )}

          {/* Stage 8: Natural Extension */}
          <div style={{
            marginTop: 24, padding: "14px 16px",
            background: "rgba(124,92,252,0.06)", borderRadius: 10,
            border: "1px solid rgba(124,92,252,0.15)",
            fontSize: 13, color: "#a090c0", lineHeight: 1.5,
          }}>
            {copySet.continuation}
          </div>

          <button className="secondary-button" onClick={handleReset}>
            Upload another document
          </button>
        </div>
      )}

      {/* Error */}
      {pageState === "error" && (
        <div className="error-state">
          <h2>Something went wrong</h2>
          <p>{errorMsg}</p>
          <button className="cta-button" onClick={handleReset}>Try again</button>
        </div>
      )}
    </div>
  );
}
