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
import { captureDocBlocksWriteGuard, guardedDocBlocksUpdate } from "../binding/docBlocksWriteGuard";

interface UsePageOpsParams {
  pdfLibDocRef: React.MutableRefObject<PDFDocument | null>;
  pdfBytesRef: React.MutableRefObject<ArrayBuffer | null>;
  /** M7.7-007: 翻页前回调（commit active edit session） */
  onBeforePageChange?: () => void;
  /**
   * B3-C-5：页结构（增 / 删 / 移动页）已改变 ⇒ **Core generation 失效**回调。
   *
   * 语义（C-5 Audit 裁定 = SPLIT_OWNERSHIP）：
   *   Page Ops 属 **PDF / Binding fidelity domain**，**不进入 Core**：
   *     · 不创建 Page Command
   *     · 不改 EditorDocument.pages（不 add/delete/reorder EditorPage、不改 EditorPage.index）
   *     · 不 reparent Core objects
   *     · **不**记 Core mutation ownership（绝不 markMutationOwner("core") ——
   *       否则 Ctrl+Z 会让 Core 去恢复一个它并不拥有的 PDF 页容器）
   *   它的唯一 Core 侧职责 = **让旧 Core/Sidecar 世代失效**，
   *   下一次需要 Core 时从新的 PDF / Legacy 状态重新派生
   *  （禁止「旧 Core document + 新 pdfBytes + 新页序」混合态）。
   *
   * 生产实现 = PDFEditor 的 `resetCoreDocumentGeneration()`（generation 边界唯一实现）。
   * 必须在**新的 pdfDoc 发布之前**调用，使重建发生在已失效的干净状态上。
   */
  onPageStructureChanged?: () => void;
  /**
   * C-6-B：Core dirty 判定（由 PDFEditor 注入，读取 coreInputSessionRef）。
   * 返回 true 时硬阻断 Page Op —— 因为 Page Op 会触发 resetCoreDocumentGeneration()，
   * 从而丢弃任何尚未持久化到 pdfBytesRef 的 Core 语义编辑（数据丢失型状态转换）。
   */
  isCoreDocumentDirty?: () => boolean;
  /** C-6-B：dirty 阻断回调（Toast 表现）。dirty 时不执行任何 Page Mutation / reset / reload。 */
  onCoreDirtyBlocked?: () => void;
}

export function usePageOps({ pdfLibDocRef, pdfBytesRef, onBeforePageChange, onPageStructureChanged, isCoreDocumentDirty, onCoreDirtyBlocked }: UsePageOpsParams) {
  const {
    page, setPage,
    totalPages, setTotalPages,
    pdfDoc, setPdfDoc,
    setBlocks,
    renderThumbnails,
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
    if (isCoreDocumentDirty?.()) { onCoreDirtyBlocked?.(); return; }
    onBeforePageChange?.();
    const guard = captureDocBlocksWriteGuard();
    const current = page - 1;
    const size = pdfLibDocRef.current.getPage(current).getSize();
    pdfLibDocRef.current.insertPage(page, [size.width, size.height]);
    // BUG FIX (Commit 4 +): insertPage(page) 在当前页之后插入新页（新页 = page+1）
    // 仅 page > 当前页 的 blocks 需要后移；当前页 blocks 保持原页
    setBlocks((prev) => guardedDocBlocksUpdate(guard, prev, (p) => p.map((b) => ({ ...b, page: b.page > page ? b.page + 1 : b.page }))));
    // B3-C-5：PDF 页结构已变 ⇒ 旧 Core/Sidecar 世代立即失效（Core 不拥有页容器，只等重新派生）
    onPageStructureChanged?.();
    const pdf = await reloadFromPdfLib();
    // Bug 17 FIX: 重新生成缩略图（包含新增的空白页）
    if (pdf) {
      renderThumbnails(pdf);
    }
    setPage(page + 1);
  };

  const handleMovePageUp = async () => {
    if (!pdfLibDocRef.current || page <= 1) return;
    if (isCoreDocumentDirty?.()) { onCoreDirtyBlocked?.(); return; }
    onBeforePageChange?.();
    const guard = captureDocBlocksWriteGuard();
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
    setBlocks((prev) => guardedDocBlocksUpdate(guard, prev, (p) => p.map((b) => {
      if (b.page === page) return { ...b, page: page - 1 };
      if (b.page === page - 1) return { ...b, page: page };
      return b;
    })));
    // B3-C-5：PDF 页序已变 ⇒ 旧 Core/Sidecar 世代立即失效（Core 的 EditorPage.index 不得被就地改写）
    onPageStructureChanged?.();
    const pdf = await reloadFromPdfLib();
    if (pdf) renderThumbnails(pdf);
    setPage(page - 1);
  };

  const handleMovePageDown = async () => {
    if (!pdfLibDocRef.current || page >= totalPages) return;
    if (isCoreDocumentDirty?.()) { onCoreDirtyBlocked?.(); return; }
    onBeforePageChange?.();
    const guard = captureDocBlocksWriteGuard();
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
    setBlocks((prev) => guardedDocBlocksUpdate(guard, prev, (p) => p.map((b) => {
      if (b.page === page) return { ...b, page: page + 1 };
      if (b.page === page + 1) return { ...b, page: page };
      return b;
    })));
    // B3-C-5：PDF 页序已变 ⇒ 旧 Core/Sidecar 世代立即失效（Core 的 EditorPage.index 不得被就地改写）
    onPageStructureChanged?.();
    const pdf = await reloadFromPdfLib();
    if (pdf) renderThumbnails(pdf);
    setPage(page + 1);
  };

  const handleDeletePage = async () => {
    if (!pdfLibDocRef.current || totalPages <= 1) return;
    if (isCoreDocumentDirty?.()) { onCoreDirtyBlocked?.(); return; }
    onBeforePageChange?.();
    const guard = captureDocBlocksWriteGuard();
    pdfLibDocRef.current.removePage(page - 1);
    setBlocks((prev) => guardedDocBlocksUpdate(guard, prev, (p) => p.filter((b) => b.page !== page).map((b) => b.page > page ? { ...b, page: b.page - 1 } : b)));
    // B3-C-5：PDF 页已删除 ⇒ 旧 Core/Sidecar 世代立即失效
    //（否则 Core 会继续持有已删页的 EditorPage + 其 objects，导出时写成孤儿内容）
    onPageStructureChanged?.();
    const pdf = await reloadFromPdfLib();
    if (pdf) renderThumbnails(pdf);
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
