import { readFileSync } from "node:fs";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";

GlobalWorkerOptions.workerSrc = new URL(
  "../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url,
).href;
const STANDARD_FONT_DATA_URL = new URL(
  "../../../node_modules/pdfjs-dist/standard_fonts/",
  import.meta.url,
).href;

const candidates = [
  "cases/m7-font-metrics-fixture.pdf",
  "cases/m75-004-cid.pdf",
  "cases/m77-003-rotation-fixture.pdf",
  "cases/_probe_cid.pdf",
];

for (const c of candidates) {
  try {
    const b = readFileSync(c);
    const u = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    const pdf = await getDocument({
      data: u,
      isEvalSupported: false,
      useSystemFonts: false,
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
    }).promise;
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 2 });
    const cv = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = cv.getContext("2d");
    await page.render({ canvasContext: ctx as any, viewport: vp } as any).promise;
    await pdf.destroy();
    console.log("OK  ", c);
  } catch (e) {
    console.log("FAIL", c, (e as Error).message.slice(0, 60));
  }
}
