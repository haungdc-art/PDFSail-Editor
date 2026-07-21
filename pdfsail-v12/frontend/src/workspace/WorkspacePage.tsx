import React, { useState, useRef, useCallback, useEffect } from "react";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

const API = import.meta.env.VITE_API_BASE || "";

type PageState = "upload" | "intent" | "workspace" | "flow" | "paywall" | "done" | "error";

interface Hint {
  type: string;
  text: string;
  action: string;
}
interface Action {
  action: string;
  label: string;
  reason: string;
}

export default function WorkspacePage() {
  const [state, setState] = useState<PageState>("upload");
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const [docId, setDocId] = useState("");
  const [fileName, setFileName] = useState("");
  const [pageCount, setPageCount] = useState(0);
  const [intent, setIntent] = useState<string | null>(null);
  const [hints, setHints] = useState<Hint[]>([]);
  const [primaryAction, setPrimaryAction] = useState<Action | null>(null);
  const [nextActions, setNextActions] = useState<Action[]>([]);
  const [actionsDone, setActionsDone] = useState<string[]>([]);
  const [showFlow, setShowFlow] = useState(false);
  const [resultPreview, setResultPreview] = useState("");
  const [resultUrl, setResultUrl] = useState("");

  // PDF rendering
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [textItems, setTextItems] = useState<any[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hintVisible, setHintVisible] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Render PDF page
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    let done = false;
    (async () => {
      const pg = await pdfDoc.getPage(page);
      const vp = pg.getViewport({ scale: 1.5 });
      const canvas = canvasRef.current!;
      canvas.width = vp.width;
      canvas.height = vp.height;
      await pg.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
      if (done) return;

      // Extract text items for overlay
      const tc = await pg.getTextContent();
      const cssScale = canvas.clientWidth / canvas.width;
      setTextItems(
        tc.items.filter((i: any) => i.str?.trim()).map((i: any) => {
          const transform = i.transform;
          const tx = transform[4];
          const ty = transform[5];
          const fontSize = Math.sqrt(transform[0] ** 2 + transform[1] ** 2) || 12;
          const charW = fontSize * 0.5;
          const w = (i.str?.length || 1) * charW;
          return {
            id: crypto.randomUUID(),
            text: i.str,
            x: tx * cssScale,
            y: (vp.height - ty - fontSize) * cssScale,
            w: w * cssScale,
            h: fontSize * cssScale * 1.3,
            fontSize: fontSize * cssScale,
          };
        })
      );
    })();
    return () => { done = true; };
  }, [pdfDoc, page]);

  // ── Upload ──

  const uploadFile = useCallback(async (file: File) => {
    setState("upload");
    setError("");
    const formData = new FormData();
    formData.append("file", file);
    try {
      const r = await fetch(`${API}/api/workspace/upload`, { method: "POST", body: formData });
      if (!r.ok) throw new Error("Upload failed");
      const d = await r.json();
      setDocId(d.doc_id);
      setFileName(d.file_name);
      setPageCount(d.page_count);

      // Load PDF for viewer
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf, cMapUrl: "/cmaps/", cMapPacked: true, standardFontDataUrl: "/standard_fonts/" }).promise;
      setPdfDoc(pdf);
      setTotalPages(pdf.numPages);

      setState("intent");
    } catch (err: any) { setError(err.message); setState("error"); }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file?.type === "application/pdf") uploadFile(file);
    else { setError("Please upload a PDF"); setState("error"); }
  }, [uploadFile]);
  const handleSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) uploadFile(e.target.files[0]);
  }, [uploadFile]);

  // ── Set Intent ──

  const setIntentAction = useCallback(async (int: string) => {
    setIntent(int);
    setState("workspace");
    try {
      const r = await fetch(`${API}/api/workspace/intent`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_id: docId, intent: int }),
      });
      const d = await r.json();
      setHints(d.hints || []);
      setPrimaryAction(d.primary_action);
    } catch {}
  }, [docId]);

  // ── Execute Action ──

  const executeAction = useCallback(async (action: string) => {
    try {
      const r = await fetch(`${API}/api/workspace/action`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_id: docId, action }),
      });
      const d = await r.json();
      setResultPreview(d.preview || "");
      setResultUrl(d.result_url || "");
      setActionsDone((prev) => [...prev, action]);
      setShowFlow(d.show_flow || false);
      setNextActions(d.next_actions || []);
      setPrimaryAction(d.next_actions?.[0] || null);

      // Refresh state after action
      const s = await fetch(`${API}/api/workspace/state/${docId}`);
      const sd = await s.json();
      setHints(sd.hints || []);
    } catch {}
  }, [docId]);

  // ── Flow Action (triggered from flow bar) ──

  const handleFlow = useCallback(async (flowType: string) => {
    if (flowType === "email") {
      setState("paywall");
      return;
    }
    if (flowType === "download") {
      try {
        const r = await fetch(`${API}/api/workspace/flow`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ doc_id: docId, flow_type: "download" }),
        });
        const d = await r.json();
        if (d.download_url) window.open(`${API}${d.download_url}`, "_blank");
        setState("done");
      } catch {}
    }
  }, [docId]);

  const handlePay = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/workspace/pay`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_id: docId, flow_type: "email" }),
      });
      const d = await r.json();
      if (d.download_url) window.open(`${API}${d.download_url}`, "_blank");
      setState("done");
    } catch {}
  }, [docId]);

  const reset = () => {
    setState("upload"); setDocId(""); setFileName(""); setPdfDoc(null); setPage(1);
    setHints([]); setPrimaryAction(null); setActionsDone([]); setShowFlow(false);
    setNextActions([]); setResultPreview(""); setResultUrl(""); setIntent(null);
    setError("");
  };

  // ── Render ──

  const navBtn: React.CSSProperties = { padding: "4px 10px", background: "rgba(0,0,0,0.55)", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 12 };

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 24px 40px", fontFamily: "system-ui,sans-serif" }}>

      {/* ═══════ STAGE 1: Upload ═══════ */}
      {state === "upload" && (
        <div style={{ textAlign: "center", padding: "60px 0" }}>
          <h1 style={{ color: "#e0e0e0", fontSize: 22, margin: "0 0 8px" }}>Upload your PDF</h1>
          <p style={{ color: "#888", fontSize: 13, margin: "0 0 24px" }}>We'll analyze it and help you complete your document tasks</p>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            style={{ border: `2px dashed ${dragOver ? "#7c5cfc" : "#444"}`, borderRadius: 16, padding: "60px 40px", cursor: "pointer", background: dragOver ? "#2a2050" : "#1a1a2e", transition: "all 0.2s" }}
          >
            <div style={{ fontSize: 48, marginBottom: 16 }}>📄</div>
            <h2 style={{ color: "#e0e0e0", fontSize: 18, margin: "0 0 6px" }}>Drop your PDF here</h2>
            <p style={{ color: "#888", fontSize: 13, margin: 0 }}>or click to browse files</p>
          </div>
          <input ref={fileInputRef} type="file" accept=".pdf" onChange={handleSelect} style={{ display: "none" }} />
        </div>
      )}

      {/* ═══════ STAGE 2: Intent Select ═══════ */}
      {state === "intent" && (
        <div style={{ textAlign: "center", padding: "40px 0" }}>
          <h2 style={{ color: "#e0e0e0", fontSize: 18, margin: "0 0 6px" }}>What are you trying to do?</h2>
          <p style={{ color: "#888", fontSize: 13, margin: "0 0 24px" }}>{fileName} · {pageCount} pages</p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            {["compress", "edit", "convert"].map((int) => (
              <button key={int} onClick={() => setIntentAction(int)}
                style={{ padding: "14px 28px", borderRadius: 10, border: "1px solid #444", background: "#1a1a2e", color: "#e0e0e0", cursor: "pointer", fontSize: 14, fontWeight: 600, transition: "all 0.15s" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "#2a2050"; e.currentTarget.style.borderColor = "#7c5cfc"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "#1a1a2e"; e.currentTarget.style.borderColor = "#444"; }}
              >
                {int === "compress" ? "📦 Compress" : int === "edit" ? "✏️ Edit" : "🔄 Convert"}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ═══════ STAGE 3: Workspace ═══════ */}
      {state === "workspace" && (
        <div>
          {/* Top bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, fontSize: 13, color: "#94a3b8" }}>
            <span style={{ fontWeight: 600, color: "#e0e0e0" }}>{fileName}</span>
            <span>· p.{page}/{totalPages}</span>
            <span>· Intent: {intent}</span>
            <div style={{ flex: 1 }} />
            {actionsDone.length > 0 && <span style={{ color: "#4ade80" }}>✔ {actionsDone.length} task done</span>}
          </div>

          <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
            {/* Left: PDF Viewer */}
            <div style={{ flex: 1 }}>
              <div ref={wrapperRef} style={{ position: "relative", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden", maxWidth: 700 }}>
                <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "auto" }} />

                {/* Inline Action Hints — hover to show */}
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, pointerEvents: "none" }}>
                  {/* Show hint at first text area */}
                  {hints.length > 0 && textItems.length > 0 && (
                    <div
                      onMouseEnter={() => setHintVisible(0)}
                      onMouseLeave={() => setHintVisible(null)}
                      style={{
                        position: "absolute",
                        left: textItems[0]?.x || 20,
                        top: textItems[0]?.y || 20,
                        padding: "3px 8px", borderRadius: 4, fontSize: 10,
                        background: hintVisible === 0 ? "rgba(124,92,252,0.15)" : "transparent",
                        border: hintVisible === 0 ? "1px solid #7c5cfc" : "1px solid transparent",
                        cursor: "pointer", pointerEvents: "auto", zIndex: 10,
                        transition: "all 0.2s",
                        whiteSpace: "nowrap",
                      }}
                      onClick={() => { if (primaryAction) executeAction(primaryAction.action); }}
                    >
                      {hintVisible === 0 ? (
                        <span style={{ color: "#7c5cfc", fontSize: 11, fontWeight: 600 }}>{hints[0].text} → {primaryAction?.label}</span>
                      ) : (
                        <span style={{ color: "#7c5cfc", opacity: 0.4 }}>●</span>
                      )}
                    </div>
                  )}
                  {hints.length > 1 && textItems.length > 3 && (
                    <div
                      onMouseEnter={() => setHintVisible(1)}
                      onMouseLeave={() => setHintVisible(null)}
                      style={{
                        position: "absolute",
                        left: textItems[Math.min(3, textItems.length - 1)]?.x || 40,
                        top: (textItems[Math.min(3, textItems.length - 1)]?.y || 50) + 20,
                        padding: "3px 8px", borderRadius: 4, fontSize: 10,
                        background: hintVisible === 1 ? "rgba(250,204,21,0.12)" : "transparent",
                        border: hintVisible === 1 ? "1px solid rgba(250,204,21,0.4)" : "1px solid transparent",
                        cursor: "pointer", pointerEvents: "auto", zIndex: 10,
                        transition: "all 0.2s",
                        whiteSpace: "nowrap",
                      }}
                      onClick={() => { if (primaryAction) executeAction(primaryAction.action); }}
                    >
                      {hintVisible === 1 ? (
                        <span style={{ color: "#d4c080", fontSize: 11, fontWeight: 600 }}>{hints[1].text} → {primaryAction?.label}</span>
                      ) : (
                        <span style={{ color: "#d4c080", opacity: 0.35 }}>●</span>
                      )}
                    </div>
                  )}
                </div>

                {/* Page nav overlay */}
                {totalPages > 1 && (
                  <div style={{ position: "absolute", bottom: 8, left: 8, display: "flex", gap: 4, pointerEvents: "auto" }}>
                    <button onClick={() => setPage((p) => Math.max(1, p - 1))} style={{ ...navBtn, opacity: page === 1 ? 0.4 : 1 }}>◀</button>
                    <span style={{ padding: "3px 8px", background: "rgba(0,0,0,0.55)", color: "#fff", borderRadius: 4, fontSize: 11 }}>{page}/{totalPages}</span>
                    <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} style={{ ...navBtn, opacity: page === totalPages ? 0.4 : 1 }}>▶</button>
                  </div>
                )}
              </div>
            </div>

            {/* Right: Action Card */}
            <div style={{ width: 280, flexShrink: 0 }}>
              {/* Action Card */}
              {primaryAction && (
                <div style={{ background: "#1a1a2e", borderRadius: 10, padding: 16, marginBottom: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#7c5cfc", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
                    {actionsDone.length === 0 ? "Recommended Action" : "Next Action"}
                  </div>
                  <div style={{ color: "#e0e0e0", fontSize: 18, fontWeight: 600, marginBottom: 4 }}>{primaryAction.label}</div>
                  <div style={{ color: "#888", fontSize: 12, lineHeight: 1.5, marginBottom: 16 }}>{primaryAction.reason}</div>
                  <button onClick={() => executeAction(primaryAction.action)}
                    style={{ width: "100%", padding: "12px", border: "none", borderRadius: 8, background: "linear-gradient(135deg,#7c5cfc,#9f7aea)", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                    Execute
                  </button>
                </div>
              )}

              {/* Done actions */}
              {actionsDone.length > 0 && (
                <div style={{ background: "#0d0d1a", borderRadius: 10, padding: 12, marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: "#4ade80", fontWeight: 600, marginBottom: 6 }}>✓ Completed</div>
                  {actionsDone.map((a, i) => (
                    <div key={i} style={{ fontSize: 12, color: "#b0b0b0", padding: "2px 0" }}>✔ {a}</div>
                  ))}
                  {resultPreview && <div style={{ fontSize: 11, color: "#666", marginTop: 6, maxHeight: 80, overflow: "hidden" }}>{resultPreview}</div>}
                  {resultUrl && (
                    <a href={`${API}${resultUrl}`} download style={{ display: "block", marginTop: 8, padding: "6px 12px", background: "#10b981", color: "#fff", borderRadius: 6, textDecoration: "none", fontSize: 12, fontWeight: 600, textAlign: "center" }}>
                      📥 Download Result
                    </a>
                  )}
                </div>
              )}

              {/* Hints summary */}
              {hints.length > 0 && actionsDone.length === 0 && (
                <div style={{ background: "#0d0d1a", borderRadius: 10, padding: 12 }}>
                  <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, marginBottom: 6 }}>Document Signals</div>
                  {hints.map((h, i) => (
                    <div key={i} style={{ fontSize: 11, color: "#666", padding: "2px 0" }}>• {h.text}</div>
                  ))}
                </div>
              )}

              {/* Flow Bar — appears after action */}
              {showFlow && (
                <div style={{ background: "rgba(124,92,252,0.08)", border: "1px solid rgba(124,92,252,0.2)", borderRadius: 10, padding: 16, marginTop: 12 }}>
                  <div style={{ fontSize: 12, color: "#c0b0e0", fontWeight: 600, marginBottom: 8 }}>✔ Your document is ready</div>
                  <div style={{ fontSize: 12, color: "#888", marginBottom: 12, lineHeight: 1.5 }}>Want a faster way to send it?</div>
                  <button onClick={() => handleFlow("email")}
                    style={{ width: "100%", padding: "10px", border: "none", borderRadius: 6, background: "#7c5cfc", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 6 }}>
                    📧 Send via Email
                  </button>
                  <button onClick={() => handleFlow("download")}
                    style={{ width: "100%", padding: "10px", border: "1px solid #444", borderRadius: 6, background: "transparent", color: "#ccc", fontSize: 13, cursor: "pointer" }}>
                    ⬇️ Download
                  </button>
                </div>
              )}

              {/* Next action prompt */}
              {nextActions.length > 0 && !showFlow && (
                <div style={{ marginTop: 12, padding: "10px 12px", background: "rgba(250,204,21,0.06)", borderRadius: 8, border: "1px solid rgba(250,204,21,0.15)", fontSize: 12, color: "#d4c080", lineHeight: 1.5 }}>
                  This document has further improvement opportunities.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══════ STAGE 4: Paywall ═══════ */}
      {state === "paywall" && (
        <div style={{ maxWidth: 400, margin: "60px auto", textAlign: "center" }}>
          <h2 style={{ color: "#e0e0e0", fontSize: 20, margin: "0 0 8px" }}>Send via Email</h2>
          <p style={{ color: "#888", fontSize: 13, margin: "0 0 20px", lineHeight: 1.5 }}>
            Email delivery requires a one-time payment to process and send your document securely.
          </p>
          <div style={{ background: "#1a1a2e", borderRadius: 12, padding: 24, marginBottom: 16 }}>
            <div style={{ fontSize: 32, fontWeight: 700, color: "#e0e0e0", marginBottom: 4 }}>$1.99</div>
            <div style={{ fontSize: 12, color: "#888" }}>One-time payment</div>
          </div>
          <button onClick={handlePay}
            style={{ width: "100%", padding: "14px", border: "none", borderRadius: 8, background: "linear-gradient(135deg,#7c5cfc,#9f7aea)", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer", marginBottom: 8 }}>
            💳 Pay & Send
          </button>
          <button onClick={() => handleFlow("download")}
            style={{ width: "100%", padding: "12px", border: "1px solid #444", borderRadius: 8, background: "transparent", color: "#ccc", fontSize: 13, cursor: "pointer" }}>
            Download for Free instead
          </button>
          <div style={{ marginTop: 12 }}>
            <button onClick={reset} style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 12 }}>Start over</button>
          </div>
        </div>
      )}

      {/* ═══════ STAGE 5: Done ═══════ */}
      {state === "done" && (
        <div style={{ maxWidth: 400, margin: "60px auto", textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
          <h2 style={{ color: "#e0e0e0", fontSize: 20, margin: "0 0 6px" }}>All done</h2>
          <p style={{ color: "#888", fontSize: 13, margin: "0 0 24px", lineHeight: 1.5 }}>
            Your document has been processed and is ready to use.
          </p>
          <button onClick={reset}
            style={{ width: "100%", padding: "14px", border: "none", borderRadius: 8, background: "#7c5cfc", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
            Upload another document
          </button>
        </div>
      )}

      {/* ═══════ Error ═══════ */}
      {state === "error" && (
        <div style={{ textAlign: "center", padding: "60px 0" }}>
          <h2 style={{ color: "#f87171", fontSize: 18, margin: "0 0 6px" }}>Something went wrong</h2>
          <p style={{ color: "#888", fontSize: 13, margin: "0 0 20px" }}>{error}</p>
          <button onClick={reset} style={{ padding: "12px 24px", border: "none", borderRadius: 8, background: "#7c5cfc", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Try again</button>
        </div>
      )}
    </div>
  );
}
