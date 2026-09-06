/**
 * AutoOCRService — 扫描件自动 OCR（Story-W1）。
 *
 * 职责：把"扫描件自动 OCR"Workflow 从 PDFEditor（UI 层）抽离出来。
 * PDFEditor 只负责调用 start(pdfBytes, onTaskId)，不知道 runFullOcr / IndexedDB / taskId。
 * 以后替换 OCR Provider（Cloud/Local/Hybrid）时，PDFEditor 零修改。
 */

import type { OcrTextBlock } from "./ocr-storage";

/** 防重复：同一实例内只触发一次（Workflow State，不属 UI） */
let started = false;

/**
 * 开始扫描件自动 OCR。
 *
 * @param pdfBytes 原始 PDF 字节
 * @param onTaskId OCR 完成后回调 taskId（由上层触发现有注入 effect 构建 EditableDocument）
 */
export function startAutoOcr(
  pdfBytes: ArrayBuffer,
  onTaskId: (taskId: string) => void
): void {
  if (started || !pdfBytes) return;
  started = true;

  const autoTaskId = `auto-${crypto.randomUUID()}`;
  import("./ocr-utils").then(({ runFullOcr }) => {
    runFullOcr(
      pdfBytes,
      autoTaskId,
      () => {}, // 后台 OCR，首页已显示，无需进度 UI
      async (tid, blocks) => {
        const { saveOcrResult } = await import("./ocr-storage");
        await saveOcrResult({ taskId: tid, blocks });
        onTaskId(tid); // 触发现有注入 effect → 构建 EditableDocument
      }
    ).catch((err) => {
      console.error("[AutoOCRService] auto OCR failed", err);
    });
  });
}

/** 重置防重复状态（重新上传时调用） */
export function resetAutoOcr(): void {
  started = false;
}

// 导出类型避免未使用告警（OcrTextBlock 供 saveOcrResult 隐式使用）
export type { OcrTextBlock };
