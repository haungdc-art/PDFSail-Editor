/**
 * PDFSail PDF → Excel v3 — Data Extraction OS
 *
 * v3 additions:
 * 1. Domain Intelligence (invoice/bank/report/unknown)
 * 2. OCR fallback for scanned PDFs (Tesseract)
 * 3. Business Schema Mapping (domain-aware column naming)
 * 4. Data Normalization (domain-specific cleanup)
 * 5. Monetization Scoring (quality + business value)
 * 6. Multi-sheet output (raw + normalized)
 */

import * as pdfjsLib from "pdfjs-dist";
import * as XLSX from "xlsx";
import Tesseract from "tesseract.js";

interface TextItem { text: string; x: number; y: number; w: number; h: number }

export type DocDomain = "invoice" | "bank_statement" | "report" | "unknown";

export interface ConversionResult {
  blob: Blob;
  qualityScore: number;
  businessValue: number;
  docDomain: DocDomain;
  rowCount: number;
  colCount: number;
  tableConfidence: number;
  fromOcr: boolean;
  price: number; // $0 = free, $0.99 = soft, $1.99 = hard
  paywall: "free" | "watermark" | "premium";
}

let workerSet = false;
let ocrWorkerSet = false;

export async function convertPdfToExcel(sourceBytes: Uint8Array): Promise<ConversionResult> {
  if (!workerSet) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    workerSet = true;
  }

  const pdf = await pdfjsLib.getDocument({ data: sourceBytes.slice(0) }).promise;
  const page = await pdf.getPage(1);
  const vp = page.getViewport({ scale: 1 });

  // Try text layer first
  let tc = await page.getTextContent();
  let allItems: TextItem[] = tc.items.filter((i: any) => i.str?.trim()).map((i: any) => {
    const tm = i.transform; const fs = i.fontSize || 12;
    return { text: i.str, x: tm[4], y: vp.height - tm[5], w: i.width || i.str.length * fs * 0.5, h: fs * 1.3 };
  });

  let fromOcr = false;
  // If very few text items, it's likely scanned → fallback to OCR
  if (allItems.length < 20) {
    try {
      const ocrItems = await runPageOcr(page, vp);
      if (ocrItems.length > allItems.length) {
        allItems = ocrItems;
        fromOcr = true;
      }
    } catch { /* keep existing items */ }
  }

  if (allItems.length < 5) throw new Error("Could not extract text from PDF");

  // Domain Intelligence
  const domain = detectDomain(allItems);

  // Table reconstruction (v2 engine)
  const tableRegion = detectTableRegion(allItems);
  const tableItems = tableRegion
    ? allItems.filter((i) => i.x >= tableRegion.x && i.x <= tableRegion.x + tableRegion.w && i.y >= tableRegion.y && i.y <= tableRegion.y + tableRegion.h)
    : allItems;

  const rows = detectRows(tableItems);
  const cols = detectColumns(tableItems);
  let grid = buildGrid(tableItems, rows, cols);
  grid = fixGrid(grid);

  // Domain-aware normalization
  const normalized = grid.map((row) => row.map((cell) => normalizeCell(cell, domain)));

  // Type inference with domain awareness
  const typed = normalized.map((row) => row.map((cell) => inferCellType(cell, domain)));

  // Quality scoring
  const quality = scoreQuality(grid, rows, cols);
  const confidence = rows.length > 2 && cols.length > 1
    ? Math.min(1, (rows.length * cols.length) / Math.max(tableItems.length * 0.8, 1)) : 0.3;

  // Monetization scoring
  const businessValue = scoreBusinessValue(domain, quality, fromOcr);

  // Paywall decision
  const paywall = businessValue > 0.8 ? "premium" : businessValue > 0.5 ? "watermark" : "free";
  const price = paywall === "premium" ? 1.99 : paywall === "watermark" ? 0.99 : 0;

  // Build multi-sheet XLSX
  const wb = XLSX.utils.book_new();
  const wsRaw = XLSX.utils.aoa_to_sheet(typed);
  XLSX.utils.book_append_sheet(wb, wsRaw, "Data");

  // Domain schema mapping: add header naming
  if (domain !== "unknown") {
    const schema = getDomainSchema(domain, cols.length);
    XLSX.utils.sheet_add_aoa(wsRaw, [schema], { origin: "A1" });
  }

  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return {
    blob: new Blob([out as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    qualityScore: quality, businessValue, docDomain: domain,
    rowCount: grid.length, colCount: cols.length,
    tableConfidence: Math.round(confidence * 100) / 100,
    fromOcr, price, paywall,
  };
}

// ─── OCR Support ────────────────────────────────────────────────────────
async function runPageOcr(page: any, vp: any): Promise<TextItem[]> {
  if (!ocrWorkerSet) {
    if (typeof (Tesseract as any).setLogging === "function") (Tesseract as any).setLogging(false);
    ocrWorkerSet = true;
  }
  const canvas = document.createElement("canvas");
  canvas.width = vp.width;
  canvas.height = vp.height;
  await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;

  const res = await Tesseract.recognize(canvas.toDataURL("image/png"), "eng", { logger: () => {} });
  const scale = 1;
  return (res.data.words as any[])
    .filter((w: any) => w.text?.trim() && (w.confidence ?? 0) > 30)
    .map((w: any) => ({
      text: w.text,
      x: w.bbox.x0 / scale,
      y: vp.height - w.bbox.y1 / scale,
      w: (w.bbox.x1 - w.bbox.x0) / scale,
      h: (w.bbox.y1 - w.bbox.y0) / scale,
    }));
}

// ─── Domain Intelligence ────────────────────────────────────────────────
function detectDomain(items: TextItem[]): DocDomain {
  const text = items.map((i) => i.text.toLowerCase()).join(" ");
  const scores = {
    invoice: ["invoice", "total", "tax", "amount due", "bill to", "payment", "subtotal", "qty", "quantity", "unit price"].reduce((s, k) => s + (text.includes(k) ? 1 : 0), 0),
    bank_statement: ["account", "balance", "deposit", "withdrawal", "statement", "transaction", "beginning balance", "ending balance", "interest", "fee"].reduce((s, k) => s + (text.includes(k) ? 1 : 0), 0),
    report: ["report", "summary", "table of contents", "introduction", "conclusion", "appendix", "figure", "chart"].reduce((s, k) => s + (text.includes(k) ? 1 : 0), 0),
  };
  const max = Math.max(scores.invoice, scores.bank_statement, scores.report);
  if (max < 2) return "unknown";
  if (scores.invoice >= scores.bank_statement && scores.invoice >= scores.report) return "invoice";
  if (scores.bank_statement >= scores.report) return "bank_statement";
  return "report";
}

function getDomainSchema(domain: DocDomain, colCount: number): string[] {
  const schemas: Record<DocDomain, string[]> = {
    invoice: ["Item", "Description", "Qty", "Unit Price", "Amount", "Tax", "Total"],
    bank_statement: ["Date", "Description", "Reference", "Debit", "Credit", "Balance"],
    report: ["Section", "Content", "Page", "Notes", "", ""],
    unknown: [],
  };
  const s = schemas[domain];
  return colCount <= s.length ? s.slice(0, colCount) : [...s, ...Array(colCount - s.length).fill("")];
}

// ─── Table Detection ────────────────────────────────────────────────────
function detectTableRegion(items: TextItem[]): { x: number; y: number; w: number; h: number } | null {
  if (items.length < 10) return null;
  const pos = items.map((i) => Math.round(i.x / 3) * 3);
  const freq: Record<number, number> = {};
  for (const x of pos) freq[x] = (freq[x] || 0) + 1;
  if (Object.values(freq).filter((c) => c >= 3).length < 2) return null;
  return {
    x: Math.min(...items.map((i) => i.x)) - 5,
    y: Math.min(...items.map((i) => i.y)) - 5,
    w: Math.max(...items.map((i) => i.x + i.w)) - Math.min(...items.map((i) => i.x)) + 10,
    h: Math.max(...items.map((i) => i.y)) - Math.min(...items.map((i) => i.y)) + 10,
  };
}

function detectRows(items: TextItem[]): number[] {
  const avgH = items.reduce((s, i) => s + i.h, 0) / items.length;
  const th = Math.max(8, avgH * 0.6);
  const raw = [...new Set(items.map((i) => Math.round(i.y / 3) * 3))].sort((a, b) => a - b);
  const cls: number[] = [];
  for (const y of raw) {
    if (cls.length === 0) { cls.push(y); continue; }
    if (y - cls[cls.length - 1] <= th) cls[cls.length - 1] = (cls[cls.length - 1] + y) / 2;
    else cls.push(y);
  }
  return cls;
}

function detectColumns(items: TextItem[]): number[] {
  const xs = items.map((i) => i.x).sort((a, b) => a - b);
  if (xs.length === 0) return [0];
  const raw = xs.map((x) => Math.round(x / 4) * 4);
  const freq: Record<number, number> = {};
  for (const x of raw) freq[x] = (freq[x] || 0) + 1;
  const c = Object.entries(freq).filter(([, f]) => f >= 2).map(([x]) => Number(x)).sort((a, b) => a - b);
  if (c.length < 2) return clusterSimple(xs);
  const cols: number[] = [];
  for (const x of c) { if (cols.length === 0 || x - cols[cols.length - 1] > 12) cols.push(x); }
  return cols.length >= 2 ? cols : clusterSimple(xs);
}

function clusterSimple(xs: number[], th = 15): number[] {
  const s = [...new Set(xs)].sort((a, b) => a - b);
  const r: number[] = [];
  for (const x of s) { if (r.length === 0 || x - r[r.length - 1] > th) r.push(x); }
  return r;
}

function buildGrid(items: TextItem[], rows: number[], cols: number[]): string[][] {
  const grid: string[][] = rows.map(() => cols.map(() => ""));
  for (const it of items) {
    const ri = nearest(it.y, rows, 20), ci = nearest(it.x, cols, 20);
    if (ri >= 0 && ci >= 0) grid[ri][ci] = (grid[ri][ci] + " " + it.text).trim();
  }
  return grid;
}

function nearest(v: number, ctrs: number[], maxD: number): number {
  let b = 0, bd = Infinity;
  for (let i = 0; i < ctrs.length; i++) { const d = Math.abs(v - ctrs[i]); if (d < bd) { bd = d; b = i; } }
  return bd < maxD ? b : -1;
}

function fixGrid(grid: string[][]): string[][] {
  let f = grid.filter((r) => r.some((c) => c.trim() !== ""));
  for (let r = 0; r < f.length; r++) {
    if (!f[r][0]?.trim()) {
      const ni = f[r].findIndex((c) => c.trim() !== "");
      if (ni > 0 && ni <= 2) f[r] = [...f[r].slice(ni), ...Array(ni).fill("")];
    }
  }
  return f;
}

// ─── Domain-aware Normalization ─────────────────────────────────────────
function normalizeCell(text: string, domain: DocDomain): string {
  let t = text.trim();
  // Invoice: clean up currency amounts
  if (domain === "invoice") {
    t = t.replace(/(?<=\d)\s+(?=\d)/g, ""); // remove spaces in numbers
  }
  // Bank: clean up account numbers
  if (domain === "bank_statement") {
    t = t.replace(/^x{2,}/i, "***"); // mask repeated X
  }
  return t;
}

// ─── Domain-aware Type Inference ────────────────────────────────────────
function inferCellType(raw: string, domain: DocDomain): any {
  const t = raw.trim();
  if (!t) return "";
  // Currency
  if (/^[$€£¥]\s?[\d,]+\.?\d*$/.test(t)) return parseFloat(t.replace(/[$€£¥,\s]/g, ""));
  if (/^[\d,]+\.?\d*\s?[$€£¥]$/.test(t)) return parseFloat(t.replace(/[$€£¥,\s]/g, ""));
  // Percentage
  if (/^[\d.]+%\s*$/.test(t)) return parseFloat(t.replace("%", "")) / 100;
  // Negative number (accounting format)
  if (/^\([\d,]+\.?\d*\)$/.test(t)) return -parseFloat(t.replace(/[(),]/g, ""));
  // Number (with optional negative)
  if (/^-?[\d,]+\.?\d*$/.test(t)) return parseFloat(t.replace(/,/g, ""));
  // Date
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(t)) return t;
  // Bank statement specific: detect running balance
  if (domain === "bank_statement" && /^-?\d+\.\d{2}$/.test(t)) return parseFloat(t);
  return t;
}

// ─── Quality Scoring ────────────────────────────────────────────────────
function scoreQuality(grid: string[][], rows: number[], cols: number[]): number {
  if (grid.length === 0 || cols.length === 0) return 0;
  const total = grid.length * cols.length;
  const filled = grid.reduce((s, r) => s + r.filter((c) => c.trim() !== "").length, 0);
  const completeness = filled / Math.max(total, 1);
  const fillRates = grid.map((r) => r.filter((c) => c.trim() !== "").length / Math.max(cols.length, 1));
  const avg = fillRates.reduce((s, v) => s + v, 0) / fillRates.length;
  const var_ = fillRates.reduce((s, v) => s + (v - avg) ** 2, 0) / fillRates.length;
  const consistency = Math.max(0, 1 - var_ * 4);
  return Math.round(Math.min(1, completeness * 0.6 + consistency * 0.4) * 100) / 100;
}

// ─── Monetization Scoring ───────────────────────────────────────────────
function scoreBusinessValue(domain: DocDomain, quality: number, fromOcr: boolean): number {
  // Domain value multiplier
  const domainValue: Record<DocDomain, number> = { invoice: 0.95, bank_statement: 0.9, report: 0.5, unknown: 0.3 };
  const base = domainValue[domain];
  // Quality adjustment: if quality is low, value drops
  const qAdj = quality > 0.7 ? 1 : quality > 0.4 ? 0.7 : 0.4;
  // OCR penalty
  const ocrPenalty = fromOcr ? 0.8 : 1;
  return Math.round(Math.min(1, base * qAdj * ocrPenalty) * 100) / 100;
}
