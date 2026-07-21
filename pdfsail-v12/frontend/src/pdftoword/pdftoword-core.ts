/**
 * PDFSail PDF → Word v1+v2+v3+v4 — Document Intelligence Converter
 *
 * v1: Text extraction + lines + paragraphs + headings + DOCX
 * v2: Multi-column + table detection + structure normalizer + basic images
 * v3: OCR fallback + doc type classifier + quality scoring
 * v4: Domain intelligence (invoice/resume) + business value + monetization
 */

import * as pdfjsLib from "pdfjs-dist";
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel } from "docx";
import Tesseract from "tesseract.js";

// ─── Types ─────────────────────────────────────────────────────────
interface TextItem { text: string; x: number; y: number; w: number; h: number; fs: number }
interface Line { text: string; y: number; xS: number; xE: number; fs: number; items: TextItem[] }
interface Para { type: "p" | "h1" | "h2" | "table" | "list"; lines: Line[]; rows?: string[][] }

export type DocDomain = "resume" | "invoice" | "report" | "letter" | "unknown";
export interface ConvResult {
  blob: Blob; quality: number; value: number; domain: DocDomain;
  fromOcr: boolean; paywall: "free" | "watermark" | "premium"; price: number;
}

let ws = false; let ts = false;

// ─── Main export ──────────────────────────────────────────────────────
export async function convertPdfToDocx(sourceBytes: Uint8Array): Promise<ConvResult> {
  if (!ws) { pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString(); ws = true; }

  const pdf = await pdfjsLib.getDocument({ data: sourceBytes.slice(0) }).promise;
  const pc = pdf.numPages;
  const allBlocks: Para[] = [];
  let fromOcr = false;

  for (let p = 1; p <= pc; p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });

    // Try text layer first
    let tc = await page.getTextContent();
    let items: TextItem[] = tc.items.filter((i: any) => i.str?.trim()).map((i: any) => {
      const tm = i.transform; const f = i.fontSize || 12;
      return { text: i.str, x: tm[4], y: vp.height - tm[5], w: i.width || i.str.length * f * 0.5, h: f * 1.2, fs: f };
    });

    // v3: OCR fallback
    if (items.length < 15) {
      try {
        const ocr = await runOcr(page, vp);
        if (ocr.length > items.length) { items = ocr; fromOcr = true; }
      } catch { /* keep */ }
    }
    if (items.length === 0) continue;

    // v3: Structure normalizer
    items = normalizeStructure(items);

    // v1: Lines
    const lines = buildLines(items);

    // v2: Multi-column detection
    const cols = detectColumns(lines);
    const sortedLines = cols.length > 1 ? reorderByColumns(lines, cols) : lines;

    // v2: Table detection
    const blocks = detectTables(sortedLines);

    allBlocks.push(...blocks);
  }

  // v4: Domain intelligence
  const domain = detectDomain(allBlocks);

  // v2: Structure normalizer (text-level)
  const cleaned = normalizeBlocks(allBlocks);

  // v3: Quality score
  const quality = scoreQuality(cleaned);

  // v4: Business value
  const value = scoreValue(domain, quality, fromOcr);
  const paywall = value > 0.8 ? "premium" : value > 0.5 ? "watermark" : "free";
  const price = paywall === "premium" ? 1.99 : paywall === "watermark" ? 0.99 : 0;

  // Build DOCX
  const docx = await buildDocx(cleaned, domain);
  return { blob: docx, quality, value, domain, fromOcr, paywall, price };
}

// ─── v3: OCR ──────────────────────────────────────────────────────────
async function runOcr(page: any, vp: any): Promise<TextItem[]> {
  if (!ts) { if (typeof (Tesseract as any).setLogging === "function") (Tesseract as any).setLogging(false); ts = true; }
  const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
  await page.render({ canvasContext: c.getContext("2d")!, viewport: vp }).promise;
  const r = await Tesseract.recognize(c.toDataURL("image/png"), "eng", { logger: () => {} });
  return (r.data.words as any[]).filter((w: any) => w.text?.trim() && (w.confidence ?? 0) > 30).map((w: any) => ({
    text: w.text, x: w.bbox.x0, y: vp.height - w.bbox.y1,
    w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0, fs: w.bbox.y1 - w.bbox.y0,
  }));
}

// ─── v3: Structure normalizer ────────────────────────────────────────
function normalizeStructure(items: TextItem[]): TextItem[] {
  // Merge broken words separated by space (e.g., "con ver sion" → "conversion")
  const out: TextItem[] = [];
  for (let i = 0; i < items.length; i++) {
    if (i < items.length - 1 && items[i].text.length === 1 && items[i + 1].text.length >= 2 && Math.abs(items[i].x + items[i].w - items[i + 1].x) < 5) {
      out.push({ ...items[i + 1], text: items[i].text + items[i + 1].text });
      i++;
    } else {
      out.push(items[i]);
    }
  }
  // Fix spacing: remove extra spaces
  for (const it of out) it.text = it.text.replace(/\s{2,}/g, " ").trim();
  return out;
}

// ─── v1: Lines ────────────────────────────────────────────────────────
function buildLines(items: TextItem[], yTh = 8): Line[] {
  const s = [...items].sort((a, b) => Math.abs(a.y - b.y) < 3 ? a.x - b.x : a.y - b.y);
  const gs: TextItem[][] = []; let cur: TextItem[] = [];
  for (const it of s) {
    if (cur.length === 0) { cur = [it]; continue; }
    if (Math.abs(it.y - cur[0].y) < yTh) cur.push(it);
    else { gs.push(cur); cur = [it]; }
  }
  if (cur.length) gs.push(cur);
  const used = new Set<number>(); const lines: Line[] = [];
  for (let gi = 0; gi < gs.length; gi++) {
    if (used.has(gi)) continue;
    let m = [...gs[gi]];
    for (let nj = gi + 1; nj < gs.length; nj++) {
      if (used.has(nj)) continue;
      if (Math.abs(gs[nj][0].y - gs[gi][0].y) < yTh && gs[nj][0].x - m[m.length - 1].x < 30) { m = [...m, ...gs[nj]]; used.add(nj); }
    }
    lines.push({ text: m.map((i) => i.text).join(""), y: m[0].y, xS: Math.min(...m.map((i) => i.x)), xE: Math.max(...m.map((i) => i.x + i.w)), fs: m.reduce((s, i) => s + i.fs, 0) / m.length, items: m });
  }
  return lines.sort((a, b) => a.y - b.y);
}

// ─── v2: Multi-column detection ───────────────────────────────────────
function detectColumns(lines: Line[]): number[] {
  const xs = lines.map((l) => l.xS).sort((a, b) => a - b);
  const r = [...new Set(xs.map((x) => Math.round(x / 10) * 10))];
  const cols: number[] = [];
  for (const x of r) { if (cols.length === 0 || x - cols[cols.length - 1] > 30) cols.push(x); }
  return cols.length > 1 ? cols : [];
}

function reorderByColumns(lines: Line[], cols: number[]): Line[] {
  const groups: Line[][] = cols.map(() => []);
  for (const l of lines) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < cols.length; i++) { const d = Math.abs(l.xS - cols[i]); if (d < bestD) { bestD = d; best = i; } }
    groups[best].push(l);
  }
  const result: Line[] = [];
  const maxRows = Math.max(...groups.map((g) => g.length));
  for (let r = 0; r < maxRows; r++) {
    for (let c = 0; c < cols.length; c++) { if (r < groups[c].length) result.push(groups[c][r]); }
  }
  return result;
}

// ─── v2: Table detection ──────────────────────────────────────────────
function detectTables(lines: Line[]): Para[] {
  if (lines.length < 3) return lines.map((l) => ({ type: "p" as const, lines: [l] }));
  // Check if lines have strong X alignment patterns (table heuristic)
  const xPositions = lines.map((l) => Math.round(l.xS / 5) * 5);
  const freq: Record<number, number> = {};
  for (const x of xPositions) freq[x] = (freq[x] || 0) + 1;
  const aligned = Object.values(freq).filter((c) => c >= 3).length;
  if (aligned < 2) return lines.map((l) => ({ type: "p" as const, lines: [l] }));

  // Group into tables and non-tables
  const blocks: Para[] = []; let cur: Line[] = [];
  for (const l of lines) {
    const xKey = Math.round(l.xS / 5) * 5;
    const isAligned = freq[xKey] >= 3;
    if (cur.length > 0 && ((isAligned && cur.length > 0 && Math.round(cur[cur.length - 1].xS / 5) * 5 !== xKey) || (!isAligned && cur.length > 2))) {
      if (cur.length > 2 && aligned > 1) blocks.push({ type: "table", lines: cur });
      else cur.forEach((cl) => blocks.push({ type: "p", lines: [cl] }));
      cur = [];
    }
    cur.push(l);
  }
  if (cur.length > 2 && aligned > 1) blocks.push({ type: "table", lines: cur });
  else cur.forEach((cl) => blocks.push({ type: "p", lines: [cl] }));
  return blocks;
}

// ─── v4: Domain intelligence ──────────────────────────────────────────
function detectDomain(blocks: Para[]): DocDomain {
  const text = blocks.map((b) => b.lines.map((l) => l.text).join(" ")).join(" ").toLowerCase();
  const s = (words: string[]) => words.reduce((a, w) => a + (text.includes(w) ? 1 : 0), 0);
  const scores: Record<DocDomain, number> = {
    resume: s(["experience", "education", "skills", "employment", "curriculum", "vitae", "resume"]),
    invoice: s(["invoice", "total", "tax", "amount", "bill", "payment", "subtotal"]),
    report: s(["report", "summary", "introduction", "conclusion", "methodology", "findings"]),
    letter: s(["dear", "sincerely", "regards", "enclosed", "attached"]),
    unknown: 0,
  };
  return (Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0] as DocDomain);
}

// ─── v2: Block normalizer ─────────────────────────────────────────────
function normalizeBlocks(blocks: Para[]): Para[] {
  const out: Para[] = [];
  for (const b of blocks) {
    if (b.type === "p") {
      const text = b.lines.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const avgFs = b.lines.reduce((s, l) => s + l.fs, 0) / b.lines.length;
      const type = avgFs > 18 ? (avgFs > 22 ? "h1" as const : "h2" as const) : "p" as const;
      // v2: List detection (bullet patterns)
      const isList = /^[-•*•\d.]/.test(text.trim());
      out.push({ ...b, type: isList ? "list" : type });
    } else {
      out.push(b);
    }
  }
  return out;
}

// ─── v3: Quality scoring ──────────────────────────────────────────────
function scoreQuality(blocks: Para[]): number {
  if (blocks.length === 0) return 0;
  const paraCount = blocks.filter((b) => b.type === "p").length;
  const headingCount = blocks.filter((b) => b.type === "h1" || b.type === "h2").length;
  const totalBlocks = blocks.length;
  const structure = headingCount > 0 ? Math.min(1, headingCount * 0.15 + paraCount / totalBlocks * 0.7) : paraCount / totalBlocks;
  return Math.round(Math.min(1, structure) * 100) / 100;
}

// ─── v4: Business value ────────────────────────────────────────────────
function scoreValue(domain: DocDomain, quality: number, ocr: boolean): number {
  const dv: Record<DocDomain, number> = { resume: 0.95, invoice: 0.9, report: 0.5, letter: 0.6, unknown: 0.3 };
  const qAdj = quality > 0.7 ? 1 : quality > 0.4 ? 0.7 : 0.4;
  return Math.min(1, dv[domain] * qAdj * (ocr ? 0.8 : 1));
}

// ─── Build DOCX ───────────────────────────────────────────────────────
async function buildDocx(blocks: Para[], domain: DocDomain): Promise<Blob> {
  const children: (Paragraph | Table)[] = [];

  // v4: Domain header
  if (domain !== "unknown") {
    const domainLabel: Record<DocDomain, string> = { resume: "Resume", invoice: "Invoice", report: "Report", letter: "Letter", unknown: "" };
    children.push(new Paragraph({ children: [new TextRun({ text: `[Detected: ${domainLabel[domain]}]`, italics: true, size: 16, color: "888888" })], spacing: { after: 200 } }));
  }

  for (const b of blocks) {
    if (b.type === "table") {
      const rows = b.lines.map((l) => {
        const cells = detectColumns([l]).length > 0 ? b.lines.filter((x) => Math.abs(x.y - l.y) < 5).map((x) => x.text) : [l.text];
        return new TableRow({ children: cells.map((c) => new TableCell({ children: [new Paragraph({ children: [new TextRun(c || "")] })] })) });
      });
      children.push(new Table({ rows }));
    } else {
      const text = b.lines.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (b.type === "h1") children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 } }));
      else if (b.type === "h2") children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 100 } }));
      else if (b.type === "list") children.push(new Paragraph({ children: [new TextRun({ text: `• ${text}` })], spacing: { after: 60 } }));
      else children.push(new Paragraph({ children: [new TextRun({ text })], spacing: { after: 80 } }));
    }
  }
  return await Packer.toBlob(new Document({ sections: [{ children }] }));
}
