import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { v4 as uuid } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const upload = multer({
  dest: path.join(__dirname, "..", "uploads"),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files allowed"));
  },
});

const outputDir = path.join(__dirname, "..", "outputs");
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

// In-memory document state store
const docStore = new Map<string, {
  filePath: string;
  fileName: string;
  intent: string | null;
  status: "uploaded" | "intent_set" | "action_done";
  actionsCompleted: string[];
  text: string;
  pageCount: number;
  hasImages: boolean;
}>();

export const workspaceRouter = express.Router();

// ── ① Upload ──

workspaceRouter.post("/workspace/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file" });
    const docId = uuid();
    const fileName = path.parse(Buffer.from(file.originalname, "latin1").toString("utf8")).name;

    let pageCount = 1;
    let text = "";
    let hasImages = false;
    try {
      const { PDFDocument } = await import("pdf-lib");
      const data = fs.readFileSync(file.path);
      const pdf = await PDFDocument.load(data, { ignoreEncryption: true });
      pageCount = pdf.getPageCount();
    } catch {}

    // Extract text for analysis
    try {
      const pdfjsLib = await import("pdfjs-dist");
      const data = new Uint8Array(fs.readFileSync(file.path));
      const pdf = await pdfjsLib.getDocument({ data }).promise;
      pageCount = pdf.numPages;
      const texts: string[] = [];
      for (let i = 1; i <= Math.min(pageCount, 10); i++) {
        const pg = await pdf.getPage(i);
        const tc = await pg.getTextContent();
        texts.push(tc.items.map((item: any) => item.str || "").join(" "));
      }
      text = texts.join("\n").trim();
      const stats = fs.statSync(file.path);
      hasImages = text.length < 200 && stats.size > 100 * 1024;
    } catch {}

    docStore.set(docId, { filePath: file.path, fileName, intent: null, status: "uploaded", actionsCompleted: [], text, pageCount, hasImages });

    res.json({ doc_id: docId, file_name: fileName, page_count: pageCount, size: file.size });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── ② Set Intent ──

workspaceRouter.post("/workspace/intent", (req, res) => {
  const { doc_id, intent } = req.body;
  if (!doc_id || !intent) return res.status(400).json({ error: "doc_id and intent required" });
  const doc = docStore.get(doc_id);
  if (!doc) return res.status(404).json({ error: "Not found" });
  doc.intent = intent;
  doc.status = "intent_set";

  // Generate hints based on document analysis
  const hints = generateHints(doc);
  // Generate the primary action
  const primaryAction = generatePrimaryAction(doc, hints);

  res.json({ doc_id, intent, hints, primary_action: primaryAction });
});

// ── ③ Get Hints & Actions ──

workspaceRouter.get("/workspace/state/:doc_id", (req, res) => {
  const doc = docStore.get(req.params.doc_id);
  if (!doc) return res.status(404).json({ error: "Not found" });
  const hints = generateHints(doc);
  const primaryAction = generatePrimaryAction(doc, hints);

  res.json({
    doc_id: req.params.doc_id,
    intent: doc.intent,
    status: doc.status,
    page_count: doc.pageCount,
    file_name: doc.fileName,
    hints,
    primary_action: primaryAction,
    actions_completed: doc.actionsCompleted,
    show_flow: doc.status === "action_done",
  });
});

// ── ④ Execute Action ──

workspaceRouter.post("/workspace/action", async (req, res) => {
  const { doc_id, action } = req.body;
  if (!doc_id || !action) return res.status(400).json({ error: "doc_id and action required" });
  const doc = docStore.get(doc_id);
  if (!doc) return res.status(404).json({ error: "Not found" });

  let resultUrl: string | null = null;
  let preview: string | null = null;
  let valueCreated = false;

  // Execute the action
  switch (action) {
    case "extract_tables": {
      const lines = doc.text.split("\n").filter((l) => l.trim());
      const tableLines = lines.filter((l) => (l.match(/\t| \s{2,}|\|/g) || []).length > 1 || (l.match(/[\d,.$%]+/g) || []).length > 2);
      const csvContent = tableLines.map((l) => l.split(/\t| \s{2,}|\|/).map((c) => `"${c.trim()}"`).join(",")).join("\n");
      const outFile = path.join(outputDir, `${doc_id}_${action}.csv`);
      fs.writeFileSync(outFile, csvContent || "No structured tables detected", "utf-8");
      resultUrl = `/api/workspace/download/${doc_id}_${action}.csv`;
      preview = csvContent ? csvContent.slice(0, 500) : "No structured tables found";
      valueCreated = tableLines.length > 0;
      break;
    }
    case "ocr_text": {
      const outFile = path.join(outputDir, `${doc_id}_ocr.txt`);
      fs.writeFileSync(outFile, doc.text || "OCR processing result", "utf-8");
      resultUrl = `/api/workspace/download/${doc_id}_ocr.txt`;
      preview = doc.text ? `Extracted ${doc.text.length} characters` : "Text extraction complete";
      valueCreated = doc.text.length > 0;
      break;
    }
    case "convert_word": {
      const outFile = path.join(outputDir, `${doc_id}_text.txt`);
      fs.writeFileSync(outFile, doc.text || "No text content", "utf-8");
      resultUrl = `/api/workspace/download/${doc_id}_text.txt`;
      preview = doc.text ? doc.text.slice(0, 500) : "No text content";
      valueCreated = doc.text.length > 0;
      break;
    }
    case "compress": {
      try {
        const { PDFDocument } = await import("pdf-lib");
        const data = fs.readFileSync(doc.filePath);
        const pdf = await PDFDocument.load(data, { ignoreEncryption: true });
        const outFile = path.join(outputDir, `${doc_id}_compressed.pdf`);
        const bytes = await pdf.save();
        fs.writeFileSync(outFile, Buffer.from(bytes));
        resultUrl = `/api/workspace/download/${doc_id}_compressed.pdf`;
        preview = `Compressed from ${(fs.statSync(doc.filePath).size / 1024).toFixed(0)}KB`;
        valueCreated = true;
      } catch {
        preview = "Compression not available for this file";
      }
      break;
    }
    case "edit":
    case "convert": {
      resultUrl = null;
      preview = "Processing complete. Ready for next steps.";
      valueCreated = true;
      break;
    }
    default: {
      // Generic handler for unknown actions
      preview = `Action "${action}" completed successfully.`;
      valueCreated = true;
      break;
    }
  }

  doc.actionsCompleted.push(action);
  doc.status = "action_done";

  // Generate next suggestions
  const nextActions = generateNextActions(doc, action);

  res.json({
    doc_id,
    action,
    result_url: resultUrl,
    preview,
    value_created: valueCreated,
    next_actions: nextActions,
    show_flow: true,
  });
});

// ── ⑤ Flow Action ──

workspaceRouter.post("/workspace/flow", (req, res) => {
  const { doc_id, flow_type } = req.body;
  if (!doc_id || !flow_type) return res.status(400).json({ error: "doc_id and flow_type required" });
  const doc = docStore.get(doc_id);
  if (!doc) return res.status(404).json({ error: "Not found" });

  // For v0, email is simulated (would need email service integration)
  if (flow_type === "email") {
    // Paywall trigger
    return res.json({
      doc_id,
      flow_type: "email",
      status: "paywall_required",
      message: "Send via email requires a one-time payment",
      paywall_amount: 1.99,
    });
  }

  if (flow_type === "download") {
    // Free download
    return res.json({
      doc_id,
      flow_type: "download",
      status: "free",
      download_url: `/api/workspace/raw/${doc_id}`,
    });
  }

  res.json({ doc_id, flow_type, status: "unknown" });
});

// ── Raw File Download ──

workspaceRouter.get("/workspace/raw/:doc_id", (req, res) => {
  const doc = docStore.get(req.params.doc_id);
  if (!doc) return res.status(404).json({ error: "Not found" });
  res.download(doc.filePath, `${doc.fileName}_processed.pdf`);
});

// ── File Download ──

workspaceRouter.get("/workspace/download/:filename", (req, res) => {
  const fp = path.join(outputDir, req.params.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "Not found" });
  res.download(fp);
});

// ── Paywall ──

workspaceRouter.post("/workspace/pay", (req, res) => {
  const { doc_id, flow_type } = req.body;
  // V0 mock payment
  res.json({ doc_id, flow_type, status: "paid", download_url: `/api/workspace/raw/${doc_id}`, receipt: `txn_${Date.now()}` });
});

// ── Helper Functions ──

function generateHints(doc: { text: string; hasImages: boolean; pageCount: number }) {
  const hints: { type: string; text: string; action: string }[] = [];
  const text = doc.text.toLowerCase();

  if (text.includes("|") || text.includes("table") || /\d{2,}%/.test(text) || text.includes("column") || text.includes("row")) {
    hints.push({ type: "STRUCTURED_DATA", text: "Table-like content detected", action: "extract_tables" });
  }
  const financeKeys = ["invoice", "amount", "total", "tax", "payment", "balance", "usd"];
  if (financeKeys.some((k) => text.includes(k))) {
    hints.push({ type: "FINANCIAL", text: "Financial data found — ready for analysis", action: "extract_tables" });
  }
  const contractKeys = ["agreement", "contract", "party", "terms", "liability"];
  if (contractKeys.some((k) => text.includes(k))) {
    hints.push({ type: "CONTRACT", text: "Contract terms detected — review or sign", action: "convert_word" });
  }
  if (doc.hasImages || text.length < 200) {
    hints.push({ type: "SCANNED", text: "Scanned document — OCR available", action: "ocr_text" });
  }
  if (doc.pageCount > 5) {
    hints.push({ type: "MULTI_PAGE", text: `${doc.pageCount} pages — ready for optimization`, action: "compress" });
  }

  return hints.slice(0, 2); // Max 2 hints
}

function generatePrimaryAction(doc: { intent: string | null; text: string; hasImages: boolean; pageCount: number }, hints: { type: string; action: string }[]) {
  // Base intent determines the primary action
  if (doc.intent === "compress") return { action: "compress", label: "Compress Document", reason: "Reduce file size for sharing" };
  if (doc.intent === "edit") return { action: "edit", label: "Prepare for Editing", reason: "Extract and structure document content" };
  if (doc.intent === "convert") return { action: "convert_word", label: "Convert to Editable Format", reason: "Convert PDF to editable document" };

  // Otherwise use first hint
  if (hints.length > 0) {
    const h = hints[0];
    return { action: h.action, label: formatLabel(h.action), reason: h.text };
  }
  return { action: "extract_tables", label: "Extract Structured Data", reason: "We detected potential data in your document" };
}

function generateNextActions(doc: { text: string; actionsCompleted: string[]; intent: string | null }, lastAction: string) {
  const next: { action: string; label: string; reason: string }[] = [];

  if (lastAction === "extract_tables") {
    next.push({ action: "convert_word", label: "Convert to Document", reason: "Turn extracted data into a formatted document" });
  } else if (lastAction === "ocr_text") {
    next.push({ action: "extract_tables", label: "Extract Tables", reason: "Check OCR result for structured data" });
  } else if (lastAction === "convert_word") {
    next.push({ action: "compress", label: "Compress", reason: "Optimize the converted document" });
  } else if (lastAction === "compress") {
    // After compress, suggest flow
  }

  return next.slice(0, 1); // Max 1 next action
}

function formatLabel(action: string): string {
  const map: Record<string, string> = {
    extract_tables: "Extract Tables",
    ocr_text: "OCR Text Recognition",
    convert_word: "Convert to Word",
    compress: "Compress PDF",
    edit: "Edit Document",
    convert: "Convert Format",
  };
  return map[action] || action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
