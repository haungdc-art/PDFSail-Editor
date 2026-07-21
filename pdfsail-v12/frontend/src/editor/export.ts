import { PDFDocument } from "pdf-lib";
import type { Block } from "./types";
import type { EditorEngine } from "./engine";

export async function exportPDF(engine: EditorEngine) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([800, 1100]);

  engine.getAll().forEach((b: Block) => {
    if (b.type === "text" && b.text) {
      page.drawText(b.text, {
        x: b.x,
        y: 1100 - b.y - b.h,
        size: 14,
        maxWidth: b.w,
      });
    }
  });

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
