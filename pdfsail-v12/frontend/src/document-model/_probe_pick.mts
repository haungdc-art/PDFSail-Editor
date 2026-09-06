import { readFileSync } from "node:fs";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { parsePdfToEditableDocument } from "./pdf-importer";

(globalThis as any).document = {
  createElement(tag: string) {
    if (tag === "canvas") return createCanvas(1, 1);
    throw new Error(`diag: unsupported element <${tag}>`);
  },
  getElementsByTagName: () => [] as any,
  createElementNS: (_ns: string, tag: string) => (globalThis as any).document.createElement(tag),
} as any;

GlobalWorkerOptions.workerSrc = new URL(
  "../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url,
).href;
const STANDARD_FONT_DATA_URL = new URL(
  "../../../node_modules/pdfjs-dist/standard_fonts/",
  import.meta.url,
).href;

const cands = [
  "tests/render-golden/contract/003/original.pdf",
  "tests/render-golden/contract/026/original.pdf",
  "tests/render-golden/contract/005/original.pdf",
  "tests/render-golden/contract/008/original.pdf",
  "tests/render-golden/contract/013/original.pdf",
  "tests/render-golden/certificate/001/original.pdf",
  "tests/render-golden/receipt/001/original.pdf",
  "cases/Case-001/original.pdf",
];

for (const c of cands) {
  try {
    const b = readFileSync(c);
    const u = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    const doc = await parsePdfToEditableDocument(u, "p.pdf");
    let lines = 0;
    let sample = "";
    for (const p of doc.pages)
      for (const blk of p.blocks)
        for (const ln of blk.lines) {
          lines++;
          if (!sample) sample = (ln.glyphs ?? []).map((g: any) => g.char ?? "").join("").slice(0, 30);
        }
    let raster = "?";
    try {
      const pdf = await getDocument({ data: new Uint8Array(u), isEvalSupported: false, useSystemFonts: false, standardFontDataUrl: STANDARD_FONT_DATA_URL }).promise;
      const page = await pdf.getPage(1);
      const vp = page.getViewport({ scale: 1 });
      const cv = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      await page.render({ canvasContext: cv.getContext("2d") as any, viewport: vp } as any).promise;
      await pdf.destroy();
      raster = "OK";
    } catch { raster = "FAIL"; }
    console.log(`${lines > 0 ? "LINES" : "nolines"} ${raster}  lines=${lines}  sample="${sample}"  ${c}`);
  } catch (e) {
    console.log(`ERR    ${(e as Error).message.slice(0, 40)}  ${c}`);
  }
}
