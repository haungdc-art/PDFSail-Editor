/**
 * PDFSail Watermark Removal v1+v2+v3 — Document Cleanliness Engine
 *
 * v1: Text repeat detection + whiteout
 * v2: Diagonal/rotated text + center overlay + wide-span caps + image detection
 * v3: Intent classification + risk analysis + quality scoring + paywall
 */

import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument, rgb } from "pdf-lib";

export type WatermarkIntent = "draft" | "branding" | "confidential" | "security" | "unknown";

export interface WatermarkResult {
  blob: Blob;
  removed: number;
  confidence: number;
  pagesAffected: number;
  intent: WatermarkIntent;
  riskLevel: "low" | "medium" | "high";
  qualityScore: number;
  paywall: "free" | "watermark" | "premium";
  price: number;
}

interface TextItem { text: string; x: number; y: number; w: number; h: number; page: number; fs: number; transform: number[] }

let workerSet = false;

export async function removeWatermark(sourceBytes: Uint8Array): Promise<WatermarkResult> {
  if (!workerSet) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    workerSet = true;
  }
  const pdf = await pdfjsLib.getDocument({ data: sourceBytes.slice(0) }).promise;
  const pageCount = pdf.numPages;
  if (pageCount === 0) throw new Error("Empty PDF");

  // ── v1+v2: Extract text + detect candidates ────────────────────────
  const allItems: (TextItem & { isWm: boolean })[] = [];
  const pageSizes: any[] = [];

  for (let p = 1; p <= pageCount; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const vp = page.getViewport({ scale: 1 });
    pageSizes.push(vp);

    for (const item of tc.items as any[]) {
      if (!item.str?.trim()) continue;
      const tm = item.transform;
      const fs = item.fontSize || 12;
      allItems.push({
        text: item.str.trim(), x: tm[4], y: vp.height - tm[5],
        w: item.width || item.str.length * fs * 0.5, h: fs * 1.3,
        page: p, fs, transform: tm, isWm: false,
      });
    }
  }

  // v1: Repeat text across 50%+ pages
  const textFreq: Record<string, { pages: Set<number>; items: TextItem[] }> = {};
  for (const it of allItems) {
    const key = it.text.toLowerCase();
    if (key.length < 2 || /^[\d.+\-%,$€£¥]+$/.test(key)) continue;
    if (!textFreq[key]) textFreq[key] = { pages: new Set(), items: [] };
    textFreq[key].pages.add(it.page);
    textFreq[key].items.push(it);
  }
  const cross = Math.max(2, Math.ceil(pageCount * 0.5));
  for (const [, v] of Object.entries(textFreq)) {
    if (v.pages.size >= cross) v.items.forEach((i) => ((i as any).isWm = true));
  }

  // v2: Diagonal / rotated
  for (const it of allItems) {
    const [, b, c] = it.transform;
    if (Math.abs(b) > 0.3 || Math.abs(c) > 0.3) it.isWm = true;
  }

  // v2: Center oversized
  for (const it of allItems) {
    const vp = pageSizes[it.page - 1];
    const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
    const nearCenter = Math.abs(cx - vp.width / 2) < vp.width * 0.25 && Math.abs(cy - vp.height / 2) < vp.height * 0.3;
    if ((it.fs > 25 || (it.fs > vp.height * 0.04)) && nearCenter) it.isWm = true;
  }

  // v2: Wide-span caps (e.g. "CONFIDENTIAL", "DRAFT")
  for (const it of allItems) {
    if (it.w > 120 && it.fs > 8 && /^[A-Z\s]{4,}$/.test(it.text.replace(/[0-9]/g, ""))) it.isWm = true;
  }

  const candidates = allItems.filter((i) => i.isWm);
  const uniqueTexts = [...new Set(candidates.map((c) => c.text.toLowerCase()))];

  // ── v3: Intent classification ──────────────────────────────────────
  const textBlock = candidates.map((c) => c.text.toLowerCase()).join(" ");
  const intent = classifyIntent(textBlock);
  const riskLevel = intent === "security" ? "high" : intent === "confidential" ? "medium" : "low";

  // ── Apply whiteout ─────────────────────────────────────────────────
  const doc = await PDFDocument.load(sourceBytes.slice(0), { ignoreEncryption: true });
  const grouped = new Map<number, typeof candidates>();
  for (const c of candidates) {
    if (!grouped.has(c.page)) grouped.set(c.page, []);
    grouped.get(c.page)!.push(c);
  }

  let removed = 0;
  for (const [pageIdx, items] of grouped) {
    const page = doc.getPage(pageIdx - 1);
    const { width: pw, height: ph } = page.getSize();
    const vp = pageSizes[pageIdx - 1];

    for (const item of items) {
      // Canvas coords → PDF bottom-left
      const pdfX = item.x;
      const pdfY = ph - (item.y + item.h);
      const margin = Math.max(3, item.h * 0.2);
      const rx = Math.max(0, pdfX - margin);
      const ry = Math.max(0, pdfY - margin);
      const rw = Math.min(pw - rx, item.w + margin * 2);
      const rh = Math.min(ph - ry, item.h + margin * 2);
      if (rw > 5 && rh > 5) {
        page.drawRectangle({ x: rx, y: ry, width: rw, height: rh, color: rgb(1, 1, 1), borderWidth: 0 });
        removed++;
      }
    }
  }

  const out = await doc.save({ useObjectStreams: true });

  // ── v3: Quality score ──────────────────────────────────────────────
  const textAfter = allItems.filter((i) => !i.isWm).length;
  const lossRatio = allItems.length > 0 ? (allItems.length - textAfter) / allItems.length : 0;
  const qualityScore = Math.round(Math.min(1, Math.max(0, 1 - lossRatio * 1.5)) * 100) / 100;

  // ── v3: Paywall decision ───────────────────────────────────────────
  const paywall = qualityScore > 0.85 ? "free" : qualityScore > 0.6 ? "watermark" : "premium";
  const price = paywall === "premium" ? 1.99 : paywall === "watermark" ? 0.99 : 0;

  return {
    blob: new Blob([out as BlobPart], { type: "application/pdf" }),
    removed, pagesAffected: grouped.size,
    confidence: Math.min(1, removed / Math.max(pageCount, 1)),
    intent, riskLevel, qualityScore,
    paywall, price,
  };
}

function classifyIntent(text: string): WatermarkIntent {
  const securityWords = ["security", "encrypt", "protected", "privileged", "confidential", "restricted"];
  const draftWords = ["draft", "sample", "preliminary", "review", "work in progress", "template"];
  const brandingWords = ["powered by", "created by", "brought to you by", "pro", "premium", "trial", "evaluation"];
  const score = (words: string[]) => words.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
  if (score(securityWords) >= 2) return "confidential";
  if (score(securityWords) >= 1 && text.includes("security")) return "security";
  if (score(draftWords) >= 1) return "draft";
  if (score(brandingWords) >= 1) return "branding";
  return "unknown";
}
