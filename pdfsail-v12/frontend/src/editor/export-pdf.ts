import { PDFDocument, rgb } from "pdf-lib";
import type { Block } from "./types";
import { LockCoordSystem } from "./coord";
import { applyTrueRedaction, type RedactionRect } from "../document-model/redaction-strip";

/**
 * 将文本渲染为 PNG 图片（用于非 ASCII 字符，如中文）。
 * pdf-lib 默认使用 WinAnsi 编码，无法编码中文等字符。
 * 将文本绘制到 canvas → 转 PNG → 嵌入 PDF，绕过编码限制。
 */
async function textToPng(
  text: string,
  fontSize: number,
  maxWidth: number,
  color: [number, number, number] = [0, 0, 0]
): Promise<Uint8Array | null> {
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // 使用高分辨率渲染（2x）保证清晰度
    const scale = 2;
    const font = `${fontSize * scale}px "Noto Sans SC", "Microsoft YaHei", "PingFang SC", "WenQuanYi Micro Hei", sans-serif`;
    ctx.font = font;

    // 自动换行
    const lines: string[] = [];
    let currentLine = "";
    for (const ch of text) {
      const testLine = currentLine + ch;
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidth * scale && currentLine) {
        lines.push(currentLine);
        currentLine = ch;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);

    const lineH = fontSize * scale * 1.3;
    canvas.width = Math.ceil(maxWidth * scale);
    canvas.height = Math.ceil(lines.length * lineH);

    // 重新设置 font（canvas resize 会重置 context）
    ctx.font = font;
    ctx.fillStyle = `rgb(${color[0] * 255}, ${color[1] * 255}, ${color[2] * 255})`;
    ctx.textBaseline = "top";

    lines.forEach((line, i) => {
      ctx.fillText(line, 0, i * lineH);
    });

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png")
    );
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * M7.7-009C: 判断文本是否需要走 Unicode fallback（PNG 栅格化）。
 * 欧洲语言（葡萄牙语/西班牙语/法语等）的重音字符均在 WinAnsi 可编码范围内，
 * 走 drawText 矢量路径。仅 CJK/emoji 等超出 Latin-1 范围的字符走 PNG fallback。
 */
function needsUnicodeFallback(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) continue;
    if (code <= 0xa0) continue;
    return true;
  }
  return false;
}

export interface ExportPdfResult {
  bytes: Uint8Array;
  /**
   * 资源导出失败清单（如图片 URL 404、签名 dataURL 解码失败）。
   *
   * 语义：这些都是**内容丢失**，必须交给调用方显式呈现，
   * 不允许在 exporter 内部吞掉后照常返回「成功的 PDF」。
   */
  warnings: string[];
}

export async function exportPDF(
  blocks: Block[],
  coord: LockCoordSystem,
  originalBytes?: ArrayBuffer
): Promise<ExportPdfResult> {
  let pdf: PDFDocument;
  const warnings: string[] = [];

  if (originalBytes) {
    pdf = await PDFDocument.load(originalBytes);
  } else {
    pdf = await PDFDocument.create();
    pdf.addPage([595, 842]);
  }

  // 真正 Redaction：先收集所有 redact 区域，循环末尾从原始 content stream 删除落入其内的 showText 算子
  const redactRects: RedactionRect[] = [];

  for (const b of blocks) {
    if (b.type !== "text" && b.type !== "image" && b.type !== "signature" && b.type !== "comment" && b.type !== "redact") continue;

    const pageIdx = Math.min(Math.max((b.page || 1) - 1, 0), pdf.getPageCount() - 1);
    const page = pdf.getPage(pageIdx);
    const p = coord.toPDF(b);

    if (b.type === "text") {
      // OCR 块的 b.h 是多行总高度，不能用 p.h/1.3（会变成 3 倍字号）
      // OCR 块已存了正确的单行 fontSize（canvas px），换算到 PDF pt：fontSize * p.h / b.h
      // 非 OCR 块（手动添加）没有 fontSize，回退到 p.h / 1.3
      const pdfFontSize = b.fontSize
        ? (b.fontSize * p.h) / b.h
        : p.h / 1.3;

      // 用 block 自身 bbox 画白色遮盖（段落 bbox 覆盖全部原文）
      page.drawRectangle({
        x: p.x, y: p.y, width: p.w, height: p.h,
        color: rgb(1, 1, 1), borderColor: rgb(1, 1, 1), borderWidth: 0,
      });
      if (b.text) {
        if (needsUnicodeFallback(b.text)) {
          // Unicode fallback（超出 WinAnsi 范围）：渲染为图片嵌入 PDF
          try {
            const pngBytes = await textToPng(b.text, pdfFontSize, p.w);
            if (pngBytes) {
              const img = await pdf.embedPng(pngBytes);
              // 图片高度按原始比例缩放到 pdfFontSize
              const imgH = (img.height / img.width) * p.w;
              page.drawImage(img, {
                x: p.x,
                y: p.y + p.h - imgH, // 底部对齐
                width: p.w,
                height: imgH,
              });
            }
          } catch (e) {
            console.warn("Export CJK text failed, skipping:", b.id, e);
          }
        } else {
          // WinAnsi 可编码文本：直接 drawText（矢量，更清晰）
          // M7.7-009C: 欧洲语言（葡萄牙语/西班牙语/法语等）的重音字符均在此路径。
          // OCR 块的行距 = singleLineHeight = fontSize / 0.72 ≈ fontSize * 1.389
          // pdf-lib 默认 lineHeight 是 size * 1.15，对多行 OCR 文本会偏窄导致溢出
          const lineHeight = b.fontSize
            ? pdfFontSize / 0.72
            : pdfFontSize * 1.3;
          page.drawText(b.text, {
            x: p.x,
            y: p.y + pdfFontSize * 0.3,
            size: pdfFontSize,
            color: rgb(0, 0, 0),
            maxWidth: p.w,
            lineHeight,
          });
        }
      }
    }

    if (b.type === "image" && b.src) {
      try {
        const resp = await fetch(b.src);
        if (!resp.ok) {
          // HTTP 404 / 失效 URL 必须显式失败：否则图片静默消失、PDF 看起来导出成功
          throw new Error(`HTTP ${resp.status} ${resp.statusText}`.trim());
        }
        const bytes = new Uint8Array(await resp.arrayBuffer());
        const img = resp.headers.get("content-type")?.includes("png") ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
        page.drawImage(img, { x: p.x, y: p.y, width: p.w, height: p.h });
      } catch (e: any) {
        warnings.push(`image ${b.id}: ${e?.message ?? String(e)}`);
      }
    }

    if (b.type === "signature" && b.dataUrl) {
      try {
        const base64 = b.dataUrl.replace(/^data:image\/\w+;base64,/, "");
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        page.drawImage(await pdf.embedPng(bytes), { x: p.x, y: p.y, width: p.w, height: p.h });
      } catch (e: any) {
        warnings.push(`signature ${b.id}: ${e?.message ?? String(e)}`);
      }
    }

    if (b.type === "redact") {
      page.drawRectangle({ x: p.x, y: p.y, width: p.w, height: p.h, color: rgb(0, 0, 0), borderWidth: 0 });
      // 记录 redaction 区域，循环结束后从原始 content stream 真正删除落入其中的 showText 算子
      if (originalBytes) {
        redactRects.push({
          pageIndex: pageIdx,
          x: p.x,
          y: p.y,
          width: p.w,
          height: p.h,
        });
      }
    }

    if (b.type === "comment" && b.text) {
      const commentText = `💬 ${b.text}`;
      if (needsUnicodeFallback(commentText)) {
        try {
          const pngBytes = await textToPng(commentText, 8, p.w, [0.2, 0.2, 0.8]);
          if (pngBytes) {
            const img = await pdf.embedPng(pngBytes);
            const imgH = (img.height / img.width) * p.w;
            page.drawImage(img, { x: p.x, y: p.y + p.h - imgH, width: p.w, height: imgH });
          }
        } catch {}
      } else {
        page.drawText(commentText, { x: p.x, y: p.y + p.h, size: 8, color: rgb(0.2, 0.2, 0.8), maxWidth: p.w });
      }
    }
  }

  // 真正 Redaction：在所有绘制（黑框等）完成后，从原始 content stream 删除落入 redaction 区域的
  // showText 算子，使被遮文本在文本提取 / Ctrl+F / 复制中均不可恢复（黑框仍保留作为视觉指示）。
  if (originalBytes && redactRects.length > 0) {
    try {
      applyTrueRedaction(pdf, redactRects);
    } catch (e) {
      console.warn("[export-pdf] true redaction failed (falling back to overlay-only):", e);
    }
  }

  return { bytes: await pdf.save(), warnings };
}

export function downloadPDF(bytes: Uint8Array, name = "edited.pdf") {
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 强 PDF 校验（生产用）：复用仓库已有 pdf-lib loader 重新打开 bytes 并校验 pageCount > 0。
 *
 * 这是 Core 生产导出 validation 阶段的**强校验器**，由 `useExport` 注入
 * `runCoreProductionExport({ validatePdf })`，使 binding 层不依赖 pdf-lib（binding 只保留
 * 轻量结构性兜底默认）。不自行实现 PDF parser。
 */
export async function validateExportedPdf(bytes: Uint8Array): Promise<boolean> {
  try {
    if (!bytes || bytes.length < 8) return false;
    const header = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]);
    if (header !== "%PDF-") return false;
    const doc = await PDFDocument.load(bytes);
    return doc.getPageCount() > 0;
  } catch {
    return false;
  }
}
