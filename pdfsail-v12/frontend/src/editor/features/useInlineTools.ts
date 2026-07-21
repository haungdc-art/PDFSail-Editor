/**
 * useInlineTools — Commit 3 / Feature 5
 *
 * 内联工具处理业务能力：compress / split / rotate / pagenum / word / excel / watermark。
 * 从 PDFEditor.tsx L536-653 提取。
 *
 * 工作流：若有 edits 先 export 得到 sourceBytes → switch case 调用对应 core 函数
 * → 下载结果 + 更新 workspace state。
 *
 * Ref 由 PDFEditorInner 持有并注入：
 *   pdfBytesRef / coordRef
 */

import { useCallback } from "react";
import { useEditor } from "../core/EditorProvider";
import { exportPDF, downloadPDF } from "../export-pdf";
import type { LockCoordSystem } from "../coord";
// Inline tool imports
import { compressPDF } from "../../compress/compress-core";
import { splitPDF } from "../../split/split-core";
import { rotatePDF } from "../../rotate/rotate-core";
import { addPageNumbers } from "../../pagenum/pagenum-core";
import { convertPdfToDocx } from "../../pdftoword/pdftoword-core";
import { convertPdfToExcel } from "../../pdftoexcel/pdftoexcel-core";
import { removeWatermark } from "../../watermark/watermark-core";
import { convertPdfToJpg } from "../../pdftojpg/pdftojpg-core";

interface UseInlineToolsParams {
  pdfBytesRef: React.MutableRefObject<ArrayBuffer | null>;
  coordRef: React.MutableRefObject<LockCoordSystem | null>;
}

export function useInlineTools({ pdfBytesRef, coordRef }: UseInlineToolsParams) {
  const {
    pdfDoc,
    docBlocks,
    totalPages,
    workspaceMode,
    setProcessingTool,
    setProcessingLog,
    setWsActionsDone,
    setWsShowFlow,
    setWsAction,
  } = useEditor();

  const addLog = useCallback((msg: string) => {
    setProcessingLog((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  const processInline = useCallback(async (tool: string, extra: any = {}) => {
    if (!pdfBytesRef.current && !pdfDoc) return;
    setProcessingTool(tool);
    setProcessingLog([`Starting: ${tool}...`]);
    addLog(`Loading document bytes...`);

    // If there are edits, export first to get final bytes
    let sourceBytes: Uint8Array;
    if (docBlocks.length > 0 && coordRef.current) {
      addLog(`Applying ${docBlocks.length} edit(s) to source PDF...`);
      sourceBytes = await exportPDF(docBlocks, coordRef.current, pdfBytesRef.current?.slice(0));
      addLog(`Edits applied successfully.`);
    } else {
      sourceBytes = new Uint8Array(pdfBytesRef.current?.slice(0) || []);
    }

    try {
      let result: Uint8Array | Blob | null = null;
      let fileName = "";

      switch (tool) {
        case "compress": {
          addLog(`Compressing PDF (quality: ${extra.quality || 60})...`);
          const r = await compressPDF(sourceBytes, extra.quality || 60);
          result = new Uint8Array(r.bytes);
          fileName = `compressed_${r.ratio.toFixed(0)}pct.pdf`;
          addLog(`Compressed: ${(r.originalSize / 1024).toFixed(0)}KB → ${(r.compressedSize / 1024).toFixed(0)}KB (${r.ratio.toFixed(0)}%)`);
          break;
        }
        case "split": {
          addLog(`Splitting PDF (mode: ${extra.mode})...`);
          const r = await splitPDF(sourceBytes, extra.mode as any, extra.range);
          if (r.pages.length === 1) {
            result = new Uint8Array(r.pages[0].bytes);
            fileName = `page_${r.pages[0].index + 1}.pdf`;
          } else {
            // Download all as zip-like individual files
            for (const p of r.pages) {
              downloadPDF(new Uint8Array(p.bytes), `page_${p.index + 1}.pdf`);
            }
            addLog(`Downloaded ${r.pages.length} individual page(s).`);
            setProcessingTool(null);
            return;
          }
          addLog(`Split: ${r.totalPages} pages into ${r.pages.length} file(s).`);
          break;
        }
        case "rotate": {
          addLog(`Rotating PDF (${extra.degrees}°, mode: ${extra.mode})...`);
          const r = await rotatePDF(sourceBytes, extra.degrees as any, extra.mode as any, extra.pageIndex || 0);
          result = new Uint8Array(r);
          fileName = `rotated_${extra.degrees}.pdf`;
          addLog(`Rotation complete.`);
          break;
        }
        case "pagenum": {
          addLog(`Adding page numbers (${extra.opts.position}, ${extra.opts.align})...`);
          const r = await addPageNumbers(sourceBytes, extra.opts);
          result = new Uint8Array(r);
          fileName = `numbered.pdf`;
          addLog(`Page numbers added to ${totalPages} pages.`);
          break;
        }
        case "word": {
          addLog(`Converting PDF to Word...`);
          const r = await convertPdfToDocx(sourceBytes);
          result = r.blob;
          fileName = `converted.docx`;
          addLog(`Conversion complete (quality: ${(r.quality * 100).toFixed(0)}%).`);
          if (r.paywall !== "free") addLog(`⚠ ${r.paywall} tier — price: $${r.price}`);
          break;
        }
        case "excel": {
          addLog(`Converting PDF to Excel...`);
          const r = await convertPdfToExcel(sourceBytes);
          result = r.blob;
          fileName = `converted.xlsx`;
          addLog(`Converted: ${r.rowCount} rows × ${r.colCount} cols (confidence: ${(r.tableConfidence * 100).toFixed(0)}%).`);
          if (r.paywall !== "free") addLog(`⚠ ${r.paywall} tier — price: $${r.price}`);
          break;
        }
        case "watermark": {
          addLog(`Analyzing and removing watermarks...`);
          const r = await removeWatermark(sourceBytes);
          result = r.blob;
          fileName = `cleaned.pdf`;
          addLog(`Removed ${r.removed} watermark(s) across ${r.pagesAffected} pages.`);
          addLog(`Intent: ${r.intent} | Confidence: ${(r.confidence * 100).toFixed(0)}%`);
          if (r.paywall !== "free") addLog(`⚠ ${r.paywall} tier — price: $${r.price}`);
          break;
        }
        case "jpg": {
          addLog(`Converting PDF to JPG images...`);
          const r = await convertPdfToJpg(sourceBytes, { scale: 2, quality: 0.92 });
          addLog(`Rendered ${r.count} page(s) to JPG.`);
          // 多页逐个下载（与 split 一致）
          for (const p of r.blobs) {
            const url = URL.createObjectURL(p.blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `page_${p.index + 1}.jpg`;
            a.click();
            URL.revokeObjectURL(url);
          }
          addLog(`📥 Downloaded ${r.count} JPG file(s).`);
          setProcessingTool(null);
          return;
        }
      }

      if (result) {
        addLog(`✅ ${tool} complete. Downloading...`);
        const blob = result instanceof Blob ? result : new Blob([result], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = fileName; a.click();
        URL.revokeObjectURL(url);
        addLog(`📥 Downloaded: ${fileName}`);
      }
      // Update workspace state
      if (workspaceMode) {
        setWsActionsDone((prev) => [...prev, tool]);
        setWsShowFlow(true);
        setWsAction(null);
      }
    } catch (err: any) {
      addLog(`❌ Error: ${err.message}`);
    } finally {
      setTimeout(() => setProcessingTool(null), 1500);
    }
  }, [docBlocks, pdfDoc, pdfBytesRef, coordRef, totalPages, workspaceMode, addLog, setProcessingTool, setProcessingLog, setWsActionsDone, setWsShowFlow, setWsAction]);

  return { processInline };
}
