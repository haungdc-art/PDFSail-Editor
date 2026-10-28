/**
 * useInlineTools — V12
 *
 * PDF to Word / Compress / Excel / JPG / Split / Remove Watermark。
 * 所有非编辑功能统一走「保存到 IndexedDB → 跳转 paywall → 支付后执行转换」流程。
 * 付费前先做无损检测（水印扫描件/有无水印）和简单校验，避免无效支付。
 */

import { useCallback } from "react";
import { useEditor } from "../core/EditorProvider";
import { exportPDF } from "../export-pdf";
import type { LockCoordSystem } from "../coord";
import { analyzeWatermarks } from "../../lib/watermark-remover";

const API_BASE = import.meta.env.VITE_API_BASE || "";

interface UseInlineToolsParams {
  pdfBytesRef: React.MutableRefObject<ArrayBuffer | null>;
  coordRef: React.MutableRefObject<LockCoordSystem | null>;
  cssScaleRef: React.MutableRefObject<number>;
}

export function useInlineTools({ pdfBytesRef, coordRef, cssScaleRef }: UseInlineToolsParams) {
  const {
    pdfDoc,
    docBlocks,
    setProcessingTool,
    setProcessingLog,
  } = useEditor();

  const addLog = useCallback((msg: string) => {
    setProcessingLog((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  // 统一的付费前置：保存源 PDF + 设置转换工具 + 跳转 paywall
  const goToPaywall = useCallback(async (tool: string, sourceBytes: Uint8Array) => {
    addLog(`Preparing ${tool} conversion...`);
    const { savePendingPdf } = await import("../../lib/indexedDB");
    await savePendingPdf({
      blob: new Blob([sourceBytes.slice()], { type: "application/pdf" }),
      fileName: "input.pdf",
      blockCount: 0,
    });
    sessionStorage.setItem("pdfaide_convert_tool", tool);
    addLog(`✅ Ready for payment. Redirecting to paywall...`);
    window.location.href = "/paywall";
  }, [addLog]);

  const processInline = useCallback(async (tool: string, _extra: any = {}) => {
    if (!pdfBytesRef.current && !pdfDoc) return;
    setProcessingTool(tool);
    setProcessingLog([`Starting: ${tool}...`]);
    addLog(`Loading document bytes...`);

    // If there are edits, export first to get final bytes
    let sourceBytes: Uint8Array;
    if (docBlocks.length > 0 && coordRef.current) {
      addLog(`Applying ${docBlocks.length} edit(s) to source PDF...`);
      // docBlocks 坐标在 CSS 显示空间（canvas_px × cssScale），需转回 canvas px (scale=1.5)
      const s = cssScaleRef.current;
      const pxBlocks = docBlocks.map((b) => ({
        ...b,
        x: b.x / s,
        y: b.y / s,
        w: b.w / s,
        h: b.h / s,
        fontSize: b.fontSize ? b.fontSize / s : b.fontSize,
      }));
      const exported = await exportPDF(pxBlocks, coordRef.current, pdfBytesRef.current?.slice(0));
      sourceBytes = exported.bytes;
      if (exported.warnings.length > 0) {
        // 图片 / 签名未能写入 ⇒ 必须显式告知用户，而不是产出一份悄悄缺图的 PDF
        addLog(`⚠️ ${exported.warnings.length} asset(s) could not be exported`);
        exported.warnings.forEach((w) => addLog(`   · ${w}`));
      }
      addLog(`Edits applied successfully.`);
    } else {
      sourceBytes = new Uint8Array(pdfBytesRef.current?.slice(0) || []);
    }

    try {
      // 所有非编辑类工具统一走 paywall
      const paywallTools = ["word", "compress", "excel", "jpg", "split", "watermark"];
      if (paywallTools.includes(tool)) {
        // watermark 先做检测，避免无效支付
        if (tool === "watermark") {
          addLog(`Analyzing PDF for watermarks...`);
          const analysis = await analyzeWatermarks(sourceBytes.slice());
          if (analysis.isScanned) {
            addLog(`⚠️ Scanned PDF not supported`);
            alert(
              "Scanned PDF not supported\n\nThis PDF appears to be a scanned document where watermarks are fused into images and cannot be removed losslessly."
            );
            return;
          }
          if (analysis.watermarks.length === 0) {
            addLog(`ℹ️ No watermarks detected.`);
            alert("No watermarks detected\n\nWe couldn't find any obvious watermarks in your PDF.");
            return;
          }
          addLog(
            `✅ Detected ${analysis.watermarks.length} watermark(s): ` +
              analysis.watermarks
                .map((w) => `${w.content} (${w.type}, ${Math.round(w.confidence * 100)}%)`)
                .join(", ")
          );
        }
        await goToPaywall(tool, sourceBytes);
        return;
      }
    } catch (err: any) {
      addLog(`❌ Error: ${err.message}`);
    } finally {
      setTimeout(() => setProcessingTool(null), 1500);
    }
  }, [docBlocks, pdfDoc, pdfBytesRef, coordRef, cssScaleRef, addLog, setProcessingTool, setProcessingLog, goToPaywall]);

  return { processInline };
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
