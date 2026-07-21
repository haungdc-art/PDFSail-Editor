import * as pdfjs from "pdfjs-dist";

export interface TextItem {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
}

/**
 * Extract text items from a PDF page with their bounding boxes
 * mapped to canvas coordinates.
 */
export async function getTextItems(
  pdf: pdfjs.PDFDocumentProxy,
  pageNum: number,
  canvas: HTMLCanvasElement
): Promise<TextItem[]> {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1.5 });
  const textContent = await page.getTextContent();

  const scaleX = canvas.width / viewport.width;
  const scaleY = canvas.height / viewport.height;

  const items: TextItem[] = [];

  for (const item of textContent.items) {
    if (!("str" in item)) continue;
    const ti = item as any;
    const text = ti.str.trim();
    if (!text) continue;

    const transform = ti.transform;
    const tx = transform[4];
    const ty = transform[5];
    const fontSize = Math.sqrt(transform[0] ** 2 + transform[1] ** 2);

    // Approximate width based on font size × text length
    const avgCharWidth = fontSize * 0.5;
    const width = text.length * avgCharWidth;

    items.push({
      text,
      x: tx * scaleX,
      y: (viewport.height - ty - fontSize) * scaleY,
      w: width * scaleX,
      h: fontSize * scaleY * 1.3,
      fontSize,
    });
  }

  return items;
}
