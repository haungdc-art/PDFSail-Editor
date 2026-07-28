/**
 * PDFSail Compress PDF — Two-stage engine
 *
 * 参考 D:\TRAE\pdfsail-v12\frontend\src\lib\clientCompress.ts 实现逻辑：
 *   Stage 1 (fast): pdf-lib 结构优化（清 metadata + useObjectStreams）
 *   Stage 2 (aggressive): Canvas 页渲染 → JPEG 嵌入
 *
 * 改进点（vs 旧版）：
 *   - 质量预设（screen/ebook/printer）替代数字滑块
 *   - canvas.toBlob() 替代 toDataURL（无 base64 开销）
 *   - 使用原始 viewport（scale:1.0）计算页面尺寸，修正旧版 72/96 bug
 *   - 白色背景填充，避免透明背景渲染异常
 *   - 进度回调 onProgress
 *   - Stage 2 输出 > 110% 原始时拒绝，返回原始文件
 */

import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";

// ── Quality Presets ──
// scale 控制 pdfjs 渲染倍数（1.0 = 72 DPI 原始尺寸）
// jpeg 控制 JPEG 压缩质量（0-1）
const QUALITY = {
  screen:  { jpeg: 0.55, scale: 1.0,  label: "extreme" },   // 72 DPI，可读但较小
  ebook:   { jpeg: 0.75, scale: 1.5,  label: "balanced" },  // 108 DPI，平衡
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

let workerSrcSet = false;

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
  if (!workerSrcSet) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url
    ).toString();
    workerSrcSet = true;
  }

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

    // 白色背景，避免透明背景渲染异常
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, vp.width, vp.height);

    try {
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    } catch {
      // 渲染失败保持白页
    }

    // toBlob 比 toDataURL 更高效（无 base64 编解码开销）
    const blob = await new Promise<Blob>((res) =>
      canvas.toBlob((b) => res(b!), "image/jpeg", cfg.jpeg)
    );
    const jpegBytes = new Uint8Array(await blob.arrayBuffer());

    const img = await outDoc.embedJpg(jpegBytes);
    // 使用原始 PDF 页面尺寸（scale:1.0 的 viewport），修正旧版 72/96 转换 bug
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

export async function compressPDF(
  sourceBytes: Uint8Array,
  quality: CompressQuality = "ebook",
  onProgress?: (pct: number) => void
): Promise<CompressResult> {
  const originalSize = sourceBytes.length;
  const cfg = QUALITY[quality] || QUALITY.ebook;

  if (onProgress) onProgress(5);

  // ── Stage 1: pdf-lib 结构优化 ──
  try {
    if (onProgress) onProgress(10);
    const stage1Bytes = await stage1Optimize(sourceBytes);
    const savings = 1 - stage1Bytes.length / originalSize;

    // 缩了 2% 以上就直接返回
    if (savings > 0.02) {
      if (onProgress) onProgress(100);
      return {
        compressed: stage1Bytes,
        originalSize,
        compressedSize: stage1Bytes.length,
        savings: Math.round(savings * 100),
        mode: "stage1_lib",
      };
    }
  } catch { /* fall through to Stage 2 */ }

  // ── Stage 2: Canvas 光栅化 ──
  try {
    if (onProgress) onProgress(15);
    const stage2Bytes = await stage2Rasterize(sourceBytes, cfg, onProgress);

    // 压缩后反而更大（>110%），返回原始文件
    const ratio = stage2Bytes.length / originalSize;
    if (ratio > 1.1) {
      if (onProgress) onProgress(100);
      return {
        compressed: sourceBytes,
        originalSize,
        compressedSize: sourceBytes.length,
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
  } catch { /* fall through to ultimate fallback */ }

  // ── Ultimate fallback: 返回原始文件 ──
  if (onProgress) onProgress(100);
  return {
    compressed: sourceBytes,
    originalSize,
    compressedSize: sourceBytes.length,
    savings: 0,
    mode: "fallback",
  };
}
