import { PDFDocument, rgb } from "pdf-lib";
import type { Block } from "./types";
import { LockCoordSystem } from "./coord";

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

export async function exportPDF(blocks: Block[], coord: LockCoordSystem, originalBytes?: ArrayBuffer) {
  let pdf: PDFDocument;

  if (originalBytes) {
    pdf = await PDFDocument.load(originalBytes);
  } else {
    pdf = await PDFDocument.create();
    pdf.addPage([595, 842]);
  }

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
        const bytes = new Uint8Array(await resp.arrayBuffer());
        const img = resp.headers.get("content-type")?.includes("png") ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
        page.drawImage(img, { x: p.x, y: p.y, width: p.w, height: p.h });
      } catch (e) { console.warn("Export image failed:", b.id); }
    }

    if (b.type === "signature" && b.dataUrl) {
      try {
        const base64 = b.dataUrl.replace(/^data:image\/\w+;base64,/, "");
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        page.drawImage(await pdf.embedPng(bytes), { x: p.x, y: p.y, width: p.w, height: p.h });
      } catch (e) { console.warn("Export signature failed:", b.id); }
    }

    if (b.type === "redact") {
      page.drawRectangle({ x: p.x, y: p.y, width: p.w, height: p.h, color: rgb(0, 0, 0), borderWidth: 0 });
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

  return await pdf.save();
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
