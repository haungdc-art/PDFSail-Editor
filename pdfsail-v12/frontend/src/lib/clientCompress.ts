/**
 * 客户端 PDF 压缩引擎 — 基于 NewPDFSail clientCompress.js
 *
 * 两阶段压缩：
 *   Stage 1 (fast): pdf-lib 结构优化（清 metadata + useObjectStreams）
 *   Stage 2 (aggressive): Canvas 页渲染 → JPEG 嵌入
 *
 * 浏览器 Canvas 是 GPU 加速的，比服务器端 @napi-rs/canvas 快 5-10 倍
 */

import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument, degrees, rgb } from "pdf-lib";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

// ── Quality Presets ──
// scale 控制 pdfjs 渲染倍数（1.0 = 72 DPI 原始尺寸）
// jpeg 控制 JPEG 压缩质量（0-1）
const QUALITY = {
  screen:  { jpeg: 0.55, scale: 1.0,  label: "extreme" },   // 72 DPI，可读但较小
  ebook:   { jpeg: 0.75, scale: 1.5,  label: "balanced" },  // 108 DPI，平衡（medium 用这个）
  printer: { jpeg: 0.9,  scale: 2.0,  label: "high" },      // 144 DPI，高质量
};

export type CompressQuality = "screen" | "ebook" | "printer";

export interface CompressResult {
  compressed: Uint8Array;
  originalSize: number;
  compressedSize: number;
  savings: number; // percentage 0-100
  mode: string;
}

// ═══════════════════════════════════════════════════════════
//  Stage 1: pdf-lib 结构优化（快速）
// ═══════════════════════════════════════════════════════════

async function stage1Optimize(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  doc.setTitle("");
  doc.setSubject("");
  doc.setKeywords([]);
  doc.setProducer("");
  doc.setCreator("");
  return await doc.save({ useObjectStreams: true, addDefaultPage: false });
}

// ═══════════════════════════════════════════════════════════
//  Stage 2: Canvas 页渲染 → JPEG 嵌入（激进压缩）
// ═══════════════════════════════════════════════════════════

async function stage2Rasterize(
  bytes: Uint8Array,
  cfg: { jpeg: number; scale: number },
  onProgress?: (pct: number) => void
): Promise<Uint8Array> {
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const pageCount = doc.numPages;
  const outDoc = await PDFDocument.create();

  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: cfg.scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext("2d")!;

    // 白色背景
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, vp.width, vp.height);

    try {
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    } catch {
      // 渲染失败保持白页
    }

    const blob = await new Promise<Blob>((res) =>
      canvas.toBlob((b) => res(b!), "image/jpeg", cfg.jpeg)
    );
    const jpegBytes = new Uint8Array(await blob.arrayBuffer());

    const img = await outDoc.embedJpg(jpegBytes);
    // 使用原始 PDF 页面尺寸（points），不要再用 72/96 缩放 — 那是错的
    // pdfjs 默认以 72 DPI 为基准渲染，scale=1.0 时 vp 即为原始尺寸
    const origVp = page.getViewport({ scale: 1.0 });
    const pageW = origVp.width;
    const pageH = origVp.height;
    const p = outDoc.addPage([pageW, pageH]);
    p.drawImage(img, { x: 0, y: 0, width: pageW, height: pageH });

    if (onProgress) onProgress(15 + Math.round((i / pageCount) * 75));
  }

  outDoc.setTitle("");
  outDoc.setAuthor("");
  outDoc.setSubject("");
  outDoc.setKeywords([]);
  outDoc.setProducer("pdfsail");
  outDoc.setCreator("pdfsail");

  return await outDoc.save({ useObjectStreams: true, addDefaultPage: false });
}

// ═══════════════════════════════════════════════════════════
//  主入口
// ═══════════════════════════════════════════════════════════

export async function compressPdf(
  input: File | Uint8Array | ArrayBuffer,
  quality: CompressQuality = "ebook",
  onProgress?: (pct: number) => void
): Promise<CompressResult> {
  const arrayBuffer =
    input instanceof File ? await input.arrayBuffer() : input instanceof Uint8Array ? input.buffer : input;
  const pdfBytes = new Uint8Array(arrayBuffer);
  const originalSize = pdfBytes.length;
  const cfg = QUALITY[quality] || QUALITY.ebook;

  if (onProgress) onProgress(5);

  // ── Stage 1: pdf-lib 结构优化 ──
  try {
    if (onProgress) onProgress(10);
    const stage1Bytes = await stage1Optimize(pdfBytes);
    const savings = 1 - stage1Bytes.length / originalSize;

    // 缩了 2% 以上就直接返回
    if (savings > 0.02) {
      console.log(`[compress] Stage 1 sufficient: ${(savings * 100).toFixed(0)}% savings`);
      if (onProgress) onProgress(100);
      return {
        compressed: stage1Bytes,
        originalSize,
        compressedSize: stage1Bytes.length,
        savings: Math.round(savings * 100),
        mode: "stage1_lib",
      };
    }
    console.log(`[compress] Stage 1 savings too low (${(savings * 100).toFixed(1)}%), proceeding to Stage 2`);
  } catch (e: any) {
    console.warn("[compress] Stage 1 failed:", e.message);
  }

  // ── Stage 2: Canvas 光栅化 ──
  try {
    if (onProgress) onProgress(15);
    console.log(`[compress] Stage 2: scale=${cfg.scale}, jpeg=${cfg.jpeg}`);
    const stage2Bytes = await stage2Rasterize(pdfBytes, cfg, onProgress);

    // 如果压缩后反而更大，返回原始文件
    const ratio = stage2Bytes.length / originalSize;
    if (ratio > 1.1) {
      console.warn(`[compress] Stage 2 output larger (${(ratio * 100).toFixed(0)}%), returning original`);
      if (onProgress) onProgress(100);
      return {
        compressed: pdfBytes,
        originalSize,
        compressedSize: pdfBytes.length,
        savings: 0,
        mode: "fallback",
      };
    }

    if (onProgress) onProgress(100);
    return {
      compressed: stage2Bytes,
      originalSize,
      compressedSize: stage2Bytes.length,
      savings: Math.round((1 - ratio) * 100),
      mode: "stage2_raster",
    };
  } catch (e: any) {
    console.warn("[compress] Stage 2 failed:", e.message);
  }

  // ── Ultimate fallback: 返回原始文件 ──
  if (onProgress) onProgress(100);
  return {
    compressed: pdfBytes,
    originalSize,
    compressedSize: pdfBytes.length,
    savings: 0,
    mode: "fallback",
  };
}
