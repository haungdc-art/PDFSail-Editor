/**
 * useDocument — Commit 1 / Step 6
 *
 * PDF 文档加载相关 state + 缩略图渲染。
 * PDF 加载/render 是核心，最后迁移。
 *
 * 包含：
 *   - page / totalPages / pdfDoc / fileName / thumbnails / thumbnailCol
 *   - renderThumbnails (只依赖 setThumbnails，自包含)
 *
 * 不包含：
 *   - handleUpload (跨 selection/workspace/ref 多 domain，留在 PDFEditor.tsx)
 *   - PDF render useEffect (Canvas 冻结区，Commit 2 才动)
 */

import { useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

export function useDocument() {
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [fileName, setFileName] = useState("");
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [thumbnailCol, setThumbnailCol] = useState(true);

  /**
   * 渲染所有页的缩略图（用于左侧缩略图栏）。
   * 只依赖 setThumbnails，无外部副作用。
   */
  async function renderThumbnails(pdf: PDFDocumentProxy) {
    const n = pdf.numPages;
    const urls: string[] = new Array(n).fill("");
    setThumbnails([...urls]);
    for (let i = 1; i <= n; i++) {
      try {
        const pg = await pdf.getPage(i);
        const vp = pg.getViewport({ scale: 0.4 });
        const c = document.createElement("canvas");
        c.width = Math.round(vp.width);
        c.height = Math.round(vp.height);
        const ctx = c.getContext("2d");
        if (!ctx) {
          continue;
        }
        // 白色背景
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        await pg.render({ canvasContext: ctx, viewport: vp }).promise;
        urls[i - 1] = c.toDataURL();
        setThumbnails([...urls]);
      } catch (e) {
        console.error("Thumbnail error p", i, e);
      }
    }
  }

  return {
    // state
    page,
    totalPages,
    pdfDoc,
    fileName,
    thumbnails,
    thumbnailCol,
    // setters
    setPage,
    setTotalPages,
    setPdfDoc,
    setFileName,
    setThumbnails,
    setThumbnailCol,
    // helpers
    renderThumbnails,
  };
}

export type UseDocument = ReturnType<typeof useDocument>;
