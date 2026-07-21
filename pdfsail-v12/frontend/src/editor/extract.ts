import * as pdfjsLib from "pdfjs-dist";
import type { PDFTextNode } from "./types";

export async function extractTextNodes(
  page: pdfjsLib.PDFPageProxy
): Promise<PDFTextNode[]> {
  const content = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1.5 });

  const scaleX = viewport.width / viewport.width;
  const scaleY = viewport.height / viewport.height;

  return content.items
    .filter((item: any) => item.str?.trim())
    .map((item: any) => ({
      id: crypto.randomUUID(),
      page: page.pageNumber,
      text: item.str,
      x: item.transform[4],
      y: viewport.height - item.transform[5] - (item.height || item.fontSize || 12),
      width: item.width || item.str.length * (item.fontSize || 12) * 0.5,
      height: item.height || item.fontSize || 12,
      fontSize: item.fontSize || item.height || 12,
    }));
}
