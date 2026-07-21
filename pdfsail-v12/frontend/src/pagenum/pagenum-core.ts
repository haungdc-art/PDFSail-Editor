import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

export interface PageNumOptions {
  position: "top" | "bottom";
  align: "left" | "center" | "right";
  format: string;   // e.g. "Page %d", "— %d —"
  startFrom: number; // 1-based
  fontSize: number;
  color: string;    // hex
}

export async function addPageNumbers(
  sourceBytes: Uint8Array,
  opts: PageNumOptions
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const count = doc.getPageCount();

  const margin = 40;
  const hex = opts.color.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;

  for (let i = 0; i < count; i++) {
    const page = doc.getPage(i);
    const { width, height } = page.getSize();
    const text = opts.format.replace("%d", String(i + opts.startFrom));

    const y = opts.position === "top" ? height - margin : margin + opts.fontSize * 0.3;
    let x: number;
    const textWidth = font.widthOfTextAtSize(text, opts.fontSize);
    if (opts.align === "left") x = margin;
    else if (opts.align === "right") x = width - margin - textWidth;
    else x = (width - textWidth) / 2;

    page.drawText(text, { x, y, size: opts.fontSize, font, color: rgb(r, g, b) });
  }

  return await doc.save();
}
