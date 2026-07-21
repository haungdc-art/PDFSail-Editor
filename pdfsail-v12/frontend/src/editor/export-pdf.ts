import { PDFDocument, rgb } from "pdf-lib";
import type { Block } from "./types";
import { LockCoordSystem } from "./coord";

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

    if (b.type === "text" && b.text) {
      // p.h = fontSize * 1.3 → fontSize = p.h / 1.3, baseline offset = p.h * 0.23
      const pdfFontSize = p.h / 1.3;
      // 先画白色矩形遮住原文，避免字体不同产生重影
      page.drawRectangle({
        x: p.x,
        y: p.y,
        width: p.w,
        height: p.h,
        color: rgb(1, 1, 1),
        borderColor: rgb(1, 1, 1),
        borderWidth: 0,
      });
      page.drawText(b.text, {
        x: p.x,
        y: p.y + pdfFontSize * 0.3,
        size: pdfFontSize,
        color: rgb(0, 0, 0),
        maxWidth: p.w,
      });
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
      page.drawText(`💬 ${b.text}`, { x: p.x, y: p.y + p.h, size: 8, color: rgb(0.2, 0.2, 0.8), maxWidth: p.w });
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
