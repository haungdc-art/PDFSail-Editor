/**
 * useOperationState — Commit 1 / Step 3
 *
 * 工具处理相关 state：处理中标志、日志、各工具的选项模态开关、工具参数。
 * 统一管理 compress / split / rotate / pagenum / ocr / paywall 的运行态。
 *
 * 不包含具体的处理函数（processInline / handleOCR / handleExport 等），
 * 它们仍留在 PDFEditor.tsx 中，因为跨 domain 依赖（docBlocks / pdfDoc）。
 */

import { useState } from "react";

export function useOperationState() {
  // 处理状态
  const [processingTool, setProcessingTool] = useState<string | null>(null);
  const [processingLog, setProcessingLog] = useState<string[]>([]);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [showPayModal, setShowPayModal] = useState(false);

  // 工具选项模态开关
  const [showCompressOptions, setShowCompressOptions] = useState(false);
  const [showSplitOptions, setShowSplitOptions] = useState(false);
  const [showRotateOptions, setShowRotateOptions] = useState(false);
  const [showPageNumOptions, setShowPageNumOptions] = useState(false);

  // 工具参数
  const [splitMode, setSplitMode] = useState<"all" | "range">("all");
  const [splitRange, setSplitRange] = useState<[number, number]>([1, 1]);
  const [rotateDeg, setRotateDeg] = useState<90 | 180 | 270>(90);
  const [rotateMode, setRotateMode] = useState<"all" | "current">("all");
  const [pageNumOpts, setPageNumOpts] = useState({
    position: "bottom" as "bottom" | "top",
    align: "center" as "center" | "left" | "right",
    format: "Page %d",
    startFrom: 1,
    fontSize: 12,
    color: "#333333",
  });
  const [compressQuality, setCompressQuality] = useState(60);

  return {
    // 处理状态
    processingTool,
    setProcessingTool,
    processingLog,
    setProcessingLog,
    ocrBusy,
    setOcrBusy,
    showPayModal,
    setShowPayModal,
    // 工具选项模态开关
    showCompressOptions,
    setShowCompressOptions,
    showSplitOptions,
    setShowSplitOptions,
    showRotateOptions,
    setShowRotateOptions,
    showPageNumOptions,
    setShowPageNumOptions,
    // 工具参数
    splitMode,
    setSplitMode,
    splitRange,
    setSplitRange,
    rotateDeg,
    setRotateDeg,
    rotateMode,
    setRotateMode,
    pageNumOpts,
    setPageNumOpts,
    compressQuality,
    setCompressQuality,
  };
}

export type UseOperationState = ReturnType<typeof useOperationState>;
