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
import { exportPDF } from "../export-pdf";
import type { LockCoordSystem } from "../coord";
// Inline tool imports
import { compressPDF, type CompressQuality } from "../../compress/compress-core";
import { splitPDF } from "../../split/split-core";
import { rotatePDF } from "../../rotate/rotate-core";
import { addPageNumbers } from "../../pagenum/pagenum-core";
import { convertPdfToDocx } from "../../pdftoword/pdftoword-core";
import { convertPdfToExcel } from "../../pdftoexcel/pdftoexcel-core";
import { removeWatermark } from "../../watermark/watermark-core";
import { convertPdfToJpg } from "../../pdftojpg/pdftojpg-core";
import { PDFDocument } from "pdf-lib";

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
    setCompletionResult,
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
      let info = "";
      let savingsPct: number | undefined;

      switch (tool) {
        case "compress": {
          const preset = (extra.quality as CompressQuality) || "ebook";
          addLog(`Compressing PDF (preset: ${preset})...`);
          const r = await compressPDF(sourceBytes, preset, (pct) => {
            if (pct % 25 === 0) addLog(`Progress: ${pct}%`);
          });
          result = new Uint8Array(r.compressed);
          fileName = `compressed_${r.savings}pct.pdf`;
          savingsPct = r.savings;
          info = `Mode: ${r.mode}`;
          addLog(`Compressed: ${(r.originalSize / 1024).toFixed(0)}KB → ${(r.compressedSize / 1024).toFixed(0)}KB (${r.savings}% saved, ${r.mode})`);
          break;
        }
        case "split": {
          addLog(`Splitting PDF (mode: ${extra.mode})...`);
          const r = await splitPDF(sourceBytes, extra.mode as any, extra.range);
          if (r.pages.length === 1) {
            result = new Uint8Array(r.pages[0].bytes);
            fileName = `page_${r.pages[0].index + 1}.pdf`;
          } else {
            // 多页：合并成一个 PDF 上传到 R2（Ready 页只支持单文件付费下载）
            addLog(`Merging ${r.pages.length} split pages into one PDF...`);
            const merged = await PDFDocument.create();
            for (const p of r.pages) {
              const doc = await PDFDocument.load(p.bytes);
              const pages = await merged.copyPages(doc, doc.getPageIndices());
              pages.forEach((pg) => merged.addPage(pg));
            }
            result = new Uint8Array(await merged.save());
            fileName = `split_merged.pdf`;
          }
          addLog(`Split: ${r.totalPages} pages into ${r.pages.length} file(s).`);
          info = `${r.pages.length} file(s) from ${r.totalPages} pages`;
          break;
        }
        case "rotate": {
          addLog(`Rotating PDF (${extra.degrees}°, mode: ${extra.mode})...`);
          const r = await rotatePDF(sourceBytes, extra.degrees as any, extra.mode as any, extra.pageIndex || 0);
          result = new Uint8Array(r);
          fileName = `rotated_${extra.degrees}.pdf`;
          info = `Rotated ${extra.degrees}°`;
          addLog(`Rotation complete.`);
          break;
        }
        case "pagenum": {
          addLog(`Adding page numbers (${extra.opts.position}, ${extra.opts.align})...`);
          const r = await addPageNumbers(sourceBytes, extra.opts);
          result = new Uint8Array(r);
          fileName = `numbered.pdf`;
          info = `Page numbers added to ${totalPages} pages`;
          addLog(`Page numbers added to ${totalPages} pages.`);
          break;
        }
        case "word": {
          addLog(`Converting PDF to Word...`);
          const r = await convertPdfToDocx(sourceBytes);
          result = r.blob;
          fileName = `converted.docx`;
          info = `Quality: ${(r.quality * 100).toFixed(0)}%`;
          addLog(`Conversion complete (quality: ${(r.quality * 100).toFixed(0)}%).`);
          if (r.paywall !== "free") addLog(`⚠ ${r.paywall} tier — price: $${r.price}`);
          break;
        }
        case "excel": {
          addLog(`Converting PDF to Excel...`);
          const r = await convertPdfToExcel(sourceBytes);
          result = r.blob;
          fileName = `converted.xlsx`;
          info = `${r.rowCount} rows × ${r.colCount} cols`;
          addLog(`Converted: ${r.rowCount} rows × ${r.colCount} cols (confidence: ${(r.tableConfidence * 100).toFixed(0)}%).`);
          if (r.paywall !== "free") addLog(`⚠ ${r.paywall} tier — price: $${r.price}`);
          break;
        }
        case "watermark": {
          addLog(`Analyzing and removing watermarks...`);
          const r = await removeWatermark(sourceBytes);
          result = r.blob;
          fileName = `cleaned.pdf`;
          info = `Removed ${r.removed} watermark(s)`;
          addLog(`Removed ${r.removed} watermark(s) across ${r.pagesAffected} pages.`);
          addLog(`Intent: ${r.intent} | Confidence: ${(r.confidence * 100).toFixed(0)}%`);
          if (r.paywall !== "free") addLog(`⚠ ${r.paywall} tier — price: $${r.price}`);
          break;
        }
        case "jpg": {
          addLog(`Converting PDF to JPG images...`);
          const r = await convertPdfToJpg(sourceBytes, { scale: 2, quality: 0.92 });
          addLog(`Rendered ${r.count} page(s) to JPG.`);
          if (r.blobs.length === 1) {
            result = r.blobs[0].blob;
            fileName = `page_${r.blobs[0].index + 1}.jpg`;
          } else {
            addLog(`Merging ${r.count} JPG images into one PDF...`);
            const merged = await PDFDocument.create();
            for (const p of r.blobs) {
              const jpgBytes = new Uint8Array(await p.blob.arrayBuffer());
              const img = await merged.embedJpg(jpgBytes);
              const page = merged.addPage([img.width, img.height]);
              page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
            }
            result = new Uint8Array(await merged.save());
            fileName = `pdf_to_jpg.pdf`;
          }
          info = `${r.count} page(s) to JPG`;
          break;
        }
      }

      if (result) {
        addLog(`✅ ${tool} complete.`);
        const blob = result instanceof Blob ? result : new Blob([result as BlobPart], { type: "application/octet-stream" });
        // 不自动跳转：弹完成弹框，用户点 Download 才上传 R2 + 跳转 /ready
        setCompletionResult({
          tool,
          fileName,
          originalSize: sourceBytes.length,
          resultSize: blob.size,
          savings: savingsPct,
          info,
          blob,
        });
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
  }, [docBlocks, pdfDoc, pdfBytesRef, coordRef, totalPages, workspaceMode, addLog, setProcessingTool, setProcessingLog, setWsActionsDone, setWsShowFlow, setWsAction, setCompletionResult]);

  return { processInline };
}
