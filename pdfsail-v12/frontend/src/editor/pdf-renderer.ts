import * as pdfjs from "pdfjs-dist";
import { PDFJS_WORKER_SRC } from "../pdfjs-worker-src";

pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;

export async function renderPage(
  pdf: pdfjs.PDFDocumentProxy,
  pageNum: number,
  canvas: HTMLCanvasElement
) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1.5 });

  const ctx = canvas.getContext("2d")!;
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  await page.render({ canvasContext: ctx, viewport }).promise;

  return viewport;
}

export async function loadPDF(data: ArrayBuffer): Promise<pdfjs.PDFDocumentProxy> {
  return pdfjs.getDocument({ data, cMapUrl: "/cmaps/", cMapPacked: true, standardFontDataUrl: "/standard_fonts/" }).promise;
}
