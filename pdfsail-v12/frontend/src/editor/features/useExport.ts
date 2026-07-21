/**
 * useExport — Commit 3 / Feature 3
 *
 * 导出业务能力：检查免费额度 + 应用 blocks 到 PDF + 下载。
 * 从 PDFEditor.tsx L444-464 提取。
 *
 * Ref 由 PDFEditorInner 持有并注入：
 *   coordRef / pdfBytesRef / cssScaleRef
 */

import { useEditor } from "../core/EditorProvider";
import { exportPDF, downloadPDF } from "../export-pdf";
import type { LockCoordSystem } from "../coord";

interface UseExportParams {
  coordRef: React.MutableRefObject<LockCoordSystem | null>;
  pdfBytesRef: React.MutableRefObject<ArrayBuffer | null>;
  cssScaleRef: React.MutableRefObject<number>;
}

export interface ExportResult {
  bytes: Uint8Array;
  blob: Blob;
  fileName: string;
}

export function useExport({ coordRef, pdfBytesRef, cssScaleRef }: UseExportParams) {
  const { docBlocks, fileName, setShowPayModal } = useEditor();

  /**
   * 生成 PDF 并返回 blob（Commit 4+：供 DownloadButton 上传到 R2）。
   * 同时也触发本地下载（保留原行为，作为 fallback）。
   *
   * @param skipPay 跳过支付检查
   * @param download 是否触发本地下载（默认 true；DownloadButton 上传 R2 成功时传 false）
   * @returns ExportResult 或 null（支付弹窗打开时返回 null）
   */
  const handleExport = async (skipPay?: boolean, download = true): Promise<ExportResult | null> => {
    if (!coordRef.current || !pdfBytesRef.current) return null;
    if (!skipPay) {
      try {
        const res = await fetch("/api/billing/usage");
        const usage = await res.json();
        if (usage.exportsRemaining > 0) {
          // 有免费额度，直接导出
        } else {
          setShowPayModal(true);
          return null;
        }
      } catch {
        // 后端不可用时默认允许导出
      }
    }
    const s = cssScaleRef.current;
    const pxBlocks = docBlocks.map((b) => ({ ...b, x: b.x / s, y: b.y / s, w: b.w / s, h: b.h / s }));
    const bytes = await exportPDF(pxBlocks, coordRef.current, pdfBytesRef.current);
    const outName = `edited-${fileName || "output"}.pdf`;
    if (download) {
      downloadPDF(bytes, outName);
    }
    // 构造 blob 供 R2 上传使用
    const blob = new Blob([bytes.slice().buffer], { type: "application/pdf" });
    return { bytes, blob, fileName: outName };
  };

  return { handleExport };
}
