// 一次性脚本：替换 PDFEditor.tsx 中 onConvertClick 块（D1 适配）
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "frontend/src/editor/PDFEditor.tsx";
const lines = readFileSync(FILE, "utf8").split("\n");

// 定位块边界（1-indexed）：起于 /** ... Bug 5: convert 注释，止于 }, [handleExportWithCommit, docBlocks, pdfDoc, navigate]);
const startIdx = lines.findIndex((l) => l.includes("Bug 5: convert 下拉菜单点击处理")) - 1; // 上一行是 /**
const endIdx = lines.findIndex((l) => l.trim() === "}, [handleExportWithCommit, docBlocks, pdfDoc, navigate]);");
if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
  console.error("anchor not found", { startIdx, endIdx });
  process.exit(1);
}
const replacement = `  /**
   * Bug 5: convert 下拉菜单点击处理（V12 移植适配：先转换后付费，保留本项目 paywall 链路）
   * - compress：打开压缩质量选项弹窗（用户选择后经 processInline 本地转换）
   * - word/excel/jpg：先经 handleExportWithCommit 导出含字形级编辑的最终 PDF，
   *   本地完成转换 → 完成弹窗 → 用户点击下载时 uploadToR2AndRedirect
   *   上传 R2 → 跳 www.pdfsail.com/[locale]/ready → /paywall
   */
  const onConvertClick = useCallback(async (tool: string) => {
    if (tool === "compress") {
      setShowCompressOptions(true);
      return;
    }
    await processInline(tool);
  }, [processInline, setShowCompressOptions]);`;

lines.splice(startIdx, endIdx - startIdx + 1, replacement);
writeFileSync(FILE, lines.join("\n"), "utf8");
console.log("onConvertClick replaced. old block lines:", endIdx - startIdx + 1);
