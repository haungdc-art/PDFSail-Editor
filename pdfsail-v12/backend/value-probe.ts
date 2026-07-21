// ──────────────────────────────────────────────
// PDF Value Probe v0 — Backend API
// 5 endpoints: upload → analyze → trigger → action → event
// ──────────────────────────────────────────────

import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { v4 as uuid } from "uuid";
import { analyze, recommendAction, type AnalyzeInput, type AnalyzeResult } from "./value-analyzer.js";
import { db } from "../growth/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── File storage ──

const upload = multer({
  dest: path.join(__dirname, "..", "uploads"),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files allowed"));
  },
});

// Map doc_id → physical file path
const fileStore = new Map<string, { filePath: string; fileName: string }>();

// Output directory for action results
const outputDir = path.join(__dirname, "..", "outputs");
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

// ── Router ──

export const valueProbeRouter = express.Router();

// ── ① Upload ──

valueProbeRouter.post("/value/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const docId = uuid();
    const fileName = path.parse(Buffer.from(file.originalname, "latin1").toString("utf8")).name;

    fileStore.set(docId, { filePath: file.path, fileName });

    // Get page count from pdf-lib
    let pageCount = 1;
    try {
      const { PDFDocument } = await import("pdf-lib");
      const data = fs.readFileSync(file.path);
      const pdfDoc = await PDFDocument.load(data, { ignoreEncryption: true });
      pageCount = pdfDoc.getPageCount();
    } catch {
      // fallback — single page
    }

    // Track upload event
    trackEvent(docId, "upload", { pageCount, size: file.size });

    res.json({ doc_id: docId, file_name: fileName, page_count: pageCount, size: file.size });
  } catch (err: any) {
    console.error("Value upload error:", err);
    res.status(500).json({ error: err.message || "Upload failed" });
  }
});

// ── ② Analyze ──

valueProbeRouter.post("/value/analyze", async (req, res) => {
  try {
    const { doc_id } = req.body;
    if (!doc_id) return res.status(400).json({ error: "doc_id required" });

    const store = fileStore.get(doc_id);
    if (!store) return res.status(404).json({ error: "Document not found" });

    // Extract text from PDF using pdfjs-dist (server-side)
    const { text, pageCount, hasImages } = await extractFromPDF(store.filePath);

    // Run the rule engine
    const input: AnalyzeInput = { text, pageCount, hasImages };
    const result: AnalyzeResult = analyze(input);

    // Track analyze event
    trackEvent(doc_id, "analyze", { valueFlag: result.valueFlag, score: result.score, signals: result.signals });

    res.json({
      doc_id,
      ...result,
      page_count: pageCount,
      text_length: text.length,
    });
  } catch (err: any) {
    console.error("Value analyze error:", err);
    res.status(500).json({ error: err.message || "Analysis failed" });
  }
});

// ── ③ Trigger (Open Loop) ──

valueProbeRouter.post("/value/trigger", async (req, res) => {
  try {
    const { doc_id } = req.body;
    if (!doc_id) return res.status(400).json({ error: "doc_id required" });

    const store = fileStore.get(doc_id);
    if (!store) return res.status(404).json({ error: "Document not found" });

    // Run analysis to get signals
    const { text, pageCount, hasImages } = await extractFromPDF(store.filePath);
    const result = analyze({ text, pageCount, hasImages });

    // If NO value, return empty trigger
    if (result.valueFlag === "NO") {
      return res.json({
        doc_id,
        actionable: false,
        title: null,
        action: null,
        reason: null,
      });
    }

    // Recommend single action
    const recommendation = recommendAction(result.signals);

    // Track open_loop_view
    trackEvent(doc_id, "open_loop_view", {
      recommendedAction: recommendation.action,
    });

    res.json({
      doc_id,
      actionable: true,
      title: "Unlock more value from this document",
      ...recommendation,
    });
  } catch (err: any) {
    console.error("Value trigger error:", err);
    res.status(500).json({ error: err.message || "Trigger failed" });
  }
});

// ── ④ Action Execute ──

valueProbeRouter.post("/value/action", async (req, res) => {
  try {
    const { doc_id, action } = req.body;
    if (!doc_id) return res.status(400).json({ error: "doc_id required" });
    if (!action) return res.status(400).json({ error: "action required" });

    const store = fileStore.get(doc_id);
    if (!store) return res.status(404).json({ error: "Document not found" });

    // Track click_action event
    trackEvent(doc_id, "click_action", { action });

    let resultUrl: string | null = null;
    let preview: string | null = null;
    let valueCreated = false;

    // Extract text for processing
    const { text } = await extractFromPDF(store.filePath);

    switch (action) {
      case "extract_tables": {
        // Simple table extraction: find lines with tabular data patterns
        const lines = text.split("\n").filter((l) => l.trim());
        const tableLines = lines.filter(
          (l) => (l.match(/\t| \s{2,}|\|/g) || []).length > 1 || (l.match(/[\d,.$%]+/g) || []).length > 2
        );
        const csvContent = tableLines
          .map((l) => l.split(/\t| \s{2,}|\|/).map((c) => `"${c.trim()}"`).join(","))
          .join("\n");
        const outFile = path.join(outputDir, `${doc_id}_tables.csv`);
        fs.writeFileSync(outFile, csvContent || "No structured tables detected", "utf-8");
        resultUrl = `/api/value/download/${doc_id}_tables.csv`;
        preview = csvContent ? csvContent.slice(0, 500) : "No structured tables found";
        valueCreated = tableLines.length > 0;
        break;
      }

      case "ocr_text": {
        // For v0: OCR is a placeholder — return extracted text
        const outFile = path.join(outputDir, `${doc_id}_ocr.txt`);
        const ocrContent = text || "OCR processing not yet available on server — use client-side OCR";
        fs.writeFileSync(outFile, ocrContent, "utf-8");
        resultUrl = `/api/value/download/${doc_id}_ocr.txt`;
        preview = text ? `Extracted ${text.length} characters of text` : "OCR available on client side";
        valueCreated = text.length > 0;
        break;
      }

      case "convert_word": {
        // For v0: simple text extraction as .txt (full Word conversion available in /pdf-to-word)
        const outFile = path.join(outputDir, `${doc_id}_text.txt`);
        const txtContent = text || "No text content found in this document";
        fs.writeFileSync(outFile, txtContent, "utf-8");
        resultUrl = `/api/value/download/${doc_id}_text.txt`;
        preview = text ? text.slice(0, 500) : "No text content found";
        valueCreated = text.length > 0;
        break;
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    res.json({
      doc_id,
      action,
      result_url: resultUrl,
      preview,
      value_created: valueCreated,
    });
  } catch (err: any) {
    console.error("Value action error:", err);
    res.status(500).json({ error: err.message || "Action failed" });
  }
});

// ── ⑤ Event Tracking ──

valueProbeRouter.post("/value/event", (req, res) => {
  try {
    const { doc_id, event, metadata } = req.body;
    if (!doc_id || !event) return res.status(400).json({ error: "doc_id and event required" });

    trackEvent(doc_id, event, metadata || {});
    res.json({ success: true });
  } catch (err: any) {
    console.error("Value event error:", err);
    res.status(500).json({ error: err.message || "Event tracking failed" });
  }
});

// ── File Download ──

valueProbeRouter.get("/value/download/:filename", (req, res) => {
  const filePath = path.join(outputDir, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });
  res.download(filePath);
});

// ── Metrics / Dashboard ──

valueProbeRouter.get("/value/metrics", (_req, res) => {
  const events = db.collection("value_events").find();
  const uploads = events.filter((e: any) => e.event === "upload").length;
  const yesCount = events.filter((e: any) => e.event === "analyze" && e.metadata?.valueFlag === "YES").length;
  const openLoopViews = events.filter((e: any) => e.event === "open_loop_view").length;
  const clicks = events.filter((e: any) => e.event === "click_action").length;
  const downloads = events.filter((e: any) => e.event === "download").length;

  res.json({
    upload_volume: uploads,
    yes_ratio: uploads > 0 ? ((yesCount / uploads) * 100).toFixed(1) + "%" : "0%",
    yes_count: yesCount,
    open_loop_clicks: clicks,
    click_rate: openLoopViews > 0 ? ((clicks / openLoopViews) * 100).toFixed(1) + "%" : "0%",
    open_loop_views: openLoopViews,
    downloads,
    events_total: events.length,
  });
});

// ── Helpers ──

function trackEvent(docId: string, event: string, metadata: Record<string, any> = {}) {
  try {
    db.collection("value_events").insert({
      id: `${docId}_${event}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      doc_id: docId,
      event,
      timestamp: Date.now(),
      metadata,
    });
  } catch (err) {
    console.error("Event tracking error:", err);
  }
}

/**
 * Extract text + metadata from a PDF file on the server.
 * Uses pdfjs-dist for text extraction.
 * Falls back gracefully if text extraction fails.
 */
async function extractFromPDF(filePath: string): Promise<{
  text: string;
  pageCount: number;
  hasImages: boolean;
}> {
  try {
    const fs = await import("fs");
    const data = new Uint8Array(fs.readFileSync(filePath));

    // pdfjs-dist server-side text extraction
    const pdfjsLib = await import("pdfjs-dist");

    const doc = await pdfjsLib.getDocument({ data, useSystemFonts: false }).promise;
    const pageCount = doc.numPages;
    const texts: string[] = [];

    for (let i = 1; i <= pageCount; i++) {
      try {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items
          .filter((item: any) => item.str)
          .map((item: any) => item.str)
          .join(" ");
        texts.push(pageText);
      } catch {
        // Skip pages that fail text extraction
      }
    }

    const text = texts.join("\n\n").trim();

    // Heuristic: if file is large but text is tiny, likely has images
    const stats = fs.statSync(filePath);
    const hasImages = text.length < 200 && stats.size > 100 * 1024;

    return { text, pageCount, hasImages };
  } catch {
    // Fallback: minimal info
    return { text: "", pageCount: 1, hasImages: false };
  }
}
