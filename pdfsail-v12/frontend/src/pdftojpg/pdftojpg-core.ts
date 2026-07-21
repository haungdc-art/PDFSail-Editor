/**
 * PDFSail PDF → JPG Converter
 *
 * 用 pdf.js 渲染每页到 canvas，转 JPEG blob。
 * 多页时打包成 zip-like 逐个下载（与 split 一致）。
 *
 * 返回结构对齐其他 converter：{ blobs, count }
 */

import * as pdfjsLib from "pdfjs-dist";

let ws = false;

export interface JpgResult {
  blobs: { index: number; blob: Blob }[];
  count: number;
}

export async function convertPdfToJpg(
  sourceBytes: Uint8Array,
  opts: { scale?: number; quality?: number } = {}
): Promise<JpgResult> {
  if (!ws) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url
    ).toString();
    ws = true;
  }

  const scale = opts.scale ?? 2; // 2x for decent quality
  const quality = opts.quality ?? 0.92;

  const pdf = await pdfjsLib.getDocument({ data: sourceBytes.slice(0) }).promise;
  const pc = pdf.numPages;
  const blobs: { index: number; blob: Blob }[] = [];

  for (let p = 1; p <= pc; p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    const ctx = canvas.getContext("2d")!;
    // 白底（避免透明背景在 JPG 里变黑）
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const blob: Blob = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b!), "image/jpeg", quality)
    );
    blobs.push({ index: p - 1, blob });
  }

  return { blobs, count: blobs.length };
}
