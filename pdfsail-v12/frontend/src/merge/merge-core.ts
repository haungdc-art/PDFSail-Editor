import { PDFDocument } from "pdf-lib";

export async function mergePDFs(fileBytes: Uint8Array[]): Promise<Uint8Array> {
  const merged = await PDFDocument.create();
  for (const bytes of fileBytes) {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const count = doc.getPageCount();
    const pages = await merged.copyPages(doc, [...Array(count).keys()]);
    pages.forEach((p) => merged.addPage(p));
  }
  return await merged.save();
}
