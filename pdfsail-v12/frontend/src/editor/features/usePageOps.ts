/**
 * usePageOps — Commit 3 / Feature 2
 *
 * 页面操作业务能力：增删空白页 + 上下移动页面 + 重新加载 pdf-lib 文档。
 * 从 PDFEditor.tsx L371-440 提取。
 *
 * Ref 由 PDFEditorInner 持有并注入：
 *   pdfLibDocRef / pdfBytesRef
 */

import { useEditor } from "../core/EditorProvider";
import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument } from "pdf-lib";

interface UsePageOpsParams {
  pdfLibDocRef: React.MutableRefObject<PDFDocument | null>;
  pdfBytesRef: React.MutableRefObject<ArrayBuffer | null>;
}

export function usePageOps({ pdfLibDocRef, pdfBytesRef }: UsePageOpsParams) {
  const {
    page, setPage,
    totalPages, setTotalPages,
    pdfDoc, setPdfDoc,
    setBlocks,
  } = useEditor();

  /** 把 pdfLibDocRef 当前状态序列化回 pdfBytes + pdfDoc（pdfjs） */
  const reloadFromPdfLib = async () => {
    if (!pdfLibDocRef.current) return;
    const bytes = await pdfLibDocRef.current.save();
    pdfBytesRef.current = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const pdf = await pdfjsLib.getDocument({ data: bytes, cMapUrl: "/cmaps/", cMapPacked: true, standardFontDataUrl: "/standard_fonts/" }).promise;
    setPdfDoc(pdf);
    setTotalPages(pdf.numPages);
    return pdf;
  };

  const handleAddBlankPage = async () => {
    if (!pdfLibDocRef.current) return;
    const current = page - 1;
    const size = pdfLibDocRef.current.getPage(current).getSize();
    pdfLibDocRef.current.insertPage(page, [size.width, size.height]);
    // BUG FIX (Commit 4 +): insertPage(page) 在当前页之后插入新页（新页 = page+1）
    // 仅 page > 当前页 的 blocks 需要后移；当前页 blocks 保持原页
    setBlocks((prev) => prev.map((b) => ({ ...b, page: b.page > page ? b.page + 1 : b.page })));
    await reloadFromPdfLib();
    setPage(page + 1);
  };

  const handleMovePageUp = async () => {
    if (!pdfLibDocRef.current || page <= 1) return;
    const newOrder: number[] = [];
    for (let i = 0; i < totalPages; i++) {
      if (i === page - 2) newOrder.push(page - 1); // current page moved to previous position
      else if (i === page - 1) newOrder.push(page - 2); // previous page moved to current position
      else newOrder.push(i);
    }
    const nextDoc = await PDFDocument.create();
    const pages = await nextDoc.copyPages(pdfLibDocRef.current, newOrder);
    pages.forEach((p) => nextDoc.addPage(p));
    pdfLibDocRef.current = nextDoc;
    setBlocks((prev) => prev.map((b) => {
      if (b.page === page) return { ...b, page: page - 1 };
      if (b.page === page - 1) return { ...b, page: page };
      return b;
    }));
    await reloadFromPdfLib();
    setPage(page - 1);
  };

  const handleMovePageDown = async () => {
    if (!pdfLibDocRef.current || page >= totalPages) return;
    const newOrder: number[] = [];
    for (let i = 0; i < totalPages; i++) {
      if (i === page - 1) newOrder.push(page); // current page moved to next position
      else if (i === page) newOrder.push(page - 1); // next page moved to current position
      else newOrder.push(i);
    }
    const nextDoc = await PDFDocument.create();
    const pages = await nextDoc.copyPages(pdfLibDocRef.current, newOrder);
    pages.forEach((p) => nextDoc.addPage(p));
    pdfLibDocRef.current = nextDoc;
    setBlocks((prev) => prev.map((b) => {
      if (b.page === page) return { ...b, page: page + 1 };
      if (b.page === page + 1) return { ...b, page: page };
      return b;
    }));
    await reloadFromPdfLib();
    setPage(page + 1);
  };

  const handleDeletePage = async () => {
    if (!pdfLibDocRef.current || totalPages <= 1) return;
    pdfLibDocRef.current.removePage(page - 1);
    setBlocks((prev) => prev.filter((b) => b.page !== page).map((b) => b.page > page ? { ...b, page: b.page - 1 } : b));
    await reloadFromPdfLib();
    setPage((p) => Math.min(p, totalPages - 1));
  };

  return {
    handleAddBlankPage,
    handleDeletePage,
    handleMovePageUp,
    handleMovePageDown,
    // 暴露 reloadFromPdfLib 以便其他 feature 复用（如未来 upload 后刷新）
    reloadFromPdfLib,
  };
}
