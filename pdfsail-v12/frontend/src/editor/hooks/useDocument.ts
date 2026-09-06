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
 *
 * M7.7-007B: beforePageChangeRef — 翻页前回调（commit active edit session）。
 * 所有通过 useEditor().setPage 的翻页操作（缩略图点击、prev/next 按钮、usePageOps）
 * 都会先执行此回调，确保编辑内容不丢失。
 */

import { useState, useCallback, type MutableRefObject } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

type ThumbBlock = {
  page: number;
  x: number; y: number; w: number; h: number;
  text: string;
  fontSize: number;
  color?: string;
  fontFamily?: string;
};

export function useDocument(beforePageChangeRef?: MutableRefObject<(() => void) | null>) {
  const [page, _setPage] = useState(1);
  // M7.7-007B: 翻页前先 commit 当前编辑会话（如有），再执行实际翻页。
  // 所有通过 useEditor().setPage 的调用（缩略图、prev/next 按钮、usePageOps）都经过此守卫。
  const setPage = useCallback((p: number | ((prev: number) => number)) => {
    beforePageChangeRef?.current?.();
    _setPage(p);
  }, [beforePageChangeRef]);
  const [totalPages, setTotalPages] = useState(1);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [fileName, setFileName] = useState("");
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [thumbnailCol, setThumbnailCol] = useState(true);

  /**
   * 渲染所有页的缩略图（用于左侧缩略图栏）。
   * 可选 blocks 参数：渲染 OCR/编辑文本块到缩略图上。
   */
  async function renderThumbnails(pdf: PDFDocumentProxy, blocks?: ThumbBlock[]) {
    const n = pdf.numPages;
    const urls: string[] = new Array(n).fill("");
    setThumbnails([...urls]);
    const thumbScale = 1.0; // 较高分辨率确保缩略图文字清晰可读
    const editorScale = 1.5; // PDFEditor 内部坐标 scale
    const ratio = thumbScale / editorScale; // block 坐标 → 缩略图坐标

    for (let i = 1; i <= n; i++) {
      try {
        const pg = await pdf.getPage(i);
        const vp = pg.getViewport({ scale: thumbScale });
        const c = document.createElement("canvas");
        c.width = Math.round(vp.width);
        c.height = Math.round(vp.height);
        const ctx = c.getContext("2d");
        if (!ctx) continue;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        await pg.render({ canvasContext: ctx, viewport: vp }).promise;

        // 渲染 OCR/编辑文本块
        if (blocks && blocks.length > 0) {
          const pageBlocks = blocks.filter(b => b.page === i);
          for (const b of pageBlocks) {
            const bx = b.x * ratio;
            const by = b.y * ratio;
            const bw = b.w * ratio;
            const bh = b.h * ratio;
            // 白色遮盖（覆盖原始 PDF 内容，至少覆盖一行高度）
            const fs = Math.max(b.fontSize * ratio, 10);
            const lineHeight = fs * 1.3;
            const coverH = Math.max(bh, lineHeight);
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(bx, by, bw, coverH);
            // 文字
            ctx.fillStyle = b.color || "#000000";
            ctx.font = `${fs}px ${b.fontFamily || "Arial, sans-serif"}`;
            ctx.textBaseline = "top";
            // 换行：按 block 宽度截断，裁剪到 block 区域防止溢出
            const text = b.text || "";
            if (!text) continue;
            ctx.save();
            ctx.beginPath();
            ctx.rect(bx, by, bw, coverH);
            ctx.clip();
            const words = text.split(/\s+/);
            let line = "";
            let lineY = by;
            for (const word of words) {
              const testLine = line ? line + " " + word : word;
              const metrics = ctx.measureText(testLine);
              if (metrics.width > bw && line) {
                ctx.fillText(line, bx, lineY);
                line = word;
                lineY += lineHeight;
              } else {
                line = testLine;
              }
            }
            if (line) {
              ctx.fillText(line, bx, lineY);
            }
            ctx.restore();
          }
        }

        urls[i - 1] = c.toDataURL();
        setThumbnails([...urls]);
      } catch (e) {
        // 缩略图渲染失败，静默跳过
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
