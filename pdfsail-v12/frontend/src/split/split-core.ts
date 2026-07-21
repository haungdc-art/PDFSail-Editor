import { PDFDocument } from "pdf-lib";

export interface SplitResult {
  pages: { index: number; bytes: Uint8Array }[];
  totalPages: number;
}

export async function splitPDF(sourceBytes: Uint8Array, mode: "all" | "range", range?: [number, number]): Promise<SplitResult> {
  const doc = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
  const totalPages = doc.getPageCount();

  const pages: { index: number; bytes: Uint8Array }[] = [];

  if (mode === "all") {
    for (let i = 0; i < totalPages; i++) {
      const sub = await PDFDocument.create();
      const [page] = await sub.copyPages(doc, [i]);
      sub.addPage(page);
      pages.push({ index: i, bytes: await sub.save() });
    }
  } else if (range) {
    const [start, end] = range;
    const indices: number[] = [];
    for (let i = start; i <= end && i < totalPages; i++) indices.push(i);
    const sub = await PDFDocument.create();
    const copied = await sub.copyPages(doc, indices);
    copied.forEach((p) => sub.addPage(p));
    pages.push({ index: start, bytes: await sub.save() });
  }

  return { pages, totalPages };
}
