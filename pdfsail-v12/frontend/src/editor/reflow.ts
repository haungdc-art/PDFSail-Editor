import type { PDFTextNode } from "./types";

export function reflowText(nodes: PDFTextNode[]): PDFTextNode[][] {
  const sorted = [...nodes].sort((a, b) => {
    if (Math.abs(a.y - b.y) < 5) return a.x - b.x;
    return b.y - a.y;
  });

  const lines: PDFTextNode[][] = [];
  let current: PDFTextNode[] = [];
  let lastY: number | null = null;

  for (const n of sorted) {
    if (lastY === null || Math.abs(n.y - lastY) < 5) {
      current.push(n);
    } else {
      lines.push(current);
      current = [n];
    }
    lastY = n.y;
  }

  if (current.length) lines.push(current);
  return lines;
}

export function updateTextNode(
  nodes: PDFTextNode[],
  id: string,
  newText: string
): PDFTextNode[] {
  return nodes.map((n) =>
    n.id === id ? { ...n, text: newText, width: newText.length * n.fontSize * 0.5 } : n
  );
}
