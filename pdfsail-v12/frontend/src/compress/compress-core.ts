/**
 * PDFSail Compress PDF — Two-stage engine
 *
 * Stage 1: pdf-lib structural optimization (metadata strip, FlateEncode)
 * Stage 2: Canvas rasterization at reduced quality (aggressive compression)
 */

import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";

export interface CompressResult {
  bytes: Uint8Array;
  originalSize: number;
  compressedSize: number;
  ratio: number;
  rejected: boolean;
  reason?: string;
}

let workerSrcSet = false;

export async function compressPDF(
  sourceBytes: Uint8Array,
  quality = 60
): Promise<CompressResult> {
  const originalSize = sourceBytes.length;

  // Stage 1: pdf-lib structural optimization
  try {
    const result = await tryPdfLib(sourceBytes);
    if (result && result.length < originalSize * 0.98) {
      return checkSize(sourceBytes, result);
    }
  } catch { /* fall through */ }

  // Stage 2: Canvas rasterization (aggressive)
  try {
    const result = await tryCanvas(sourceBytes, quality);
    if (result) {
      return checkSize(sourceBytes, result);
    }
  } catch { /* fall through */ }

  // Ultimate fallback
  return {
    bytes: sourceBytes, originalSize, compressedSize: originalSize,
    ratio: 1, rejected: false,
  };
}

/** Stage 1: pdf-lib structural optimization */
async function tryPdfLib(bytes: Uint8Array): Promise<Uint8Array | null> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  doc.setTitle(""); doc.setSubject(""); doc.setKeywords([]);
  doc.setProducer(""); doc.setCreator("");
  return await doc.save({ useObjectStreams: true });
}

/** Stage 2: Canvas page render → JPEG */
async function tryCanvas(bytes: Uint8Array, quality: number): Promise<Uint8Array | null> {
  if (!workerSrcSet) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url
    ).toString();
    workerSrcSet = true;
  }

  const pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
  const pageCount = pdf.numPages;

  const dstPdf = await PDFDocument.create();
  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: quality <= 30 ? 0.5 : quality <= 60 ? 0.75 : 1 });

    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    const ctx = canvas.getContext("2d")!;
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    const jpegData = canvas.toDataURL("image/jpeg", Math.min(quality / 100, 0.85));
    const jpegBytes = dataUrlToBytes(jpegData);

    const img = await dstPdf.embedJpg(jpegBytes);
    const pageSize = [vp.width * (72 / 96), vp.height * (72 / 96)] as [number, number];
    const p = dstPdf.addPage(pageSize);
    p.drawImage(img, { x: 0, y: 0, width: pageSize[0], height: pageSize[1] });
  }

  return await dstPdf.save();
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function checkSize(original: Uint8Array, compressed: Uint8Array): CompressResult {
  const oS = original.length, cS = compressed.length;
  const ratio = oS > 0 ? cS / oS : 1;
  const rejected = ratio > 1.1;
  return {
    bytes: compressed, originalSize: oS, compressedSize: cS,
    ratio: Math.round(ratio * 100) / 100, rejected,
    reason: rejected ? `Output larger (${(ratio * 100).toFixed(0)}%).` : undefined,
  };
}
