import { readFileSync, writeFileSync } from "node:fs";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";

GlobalWorkerOptions.workerSrc = new URL("../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).href;
const STD = new URL("../../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).href;

async function render(path: string, out: string) {
  try {
    const b = readFileSync(path);
    const u = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    const pdf = await getDocument({ data: u, isEvalSupported: false, useSystemFonts: true, standardFontDataUrl: STD.href }).promise;
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 2.2 });
    const cv = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = cv.getContext("2d");
    await page.render({ canvasContext: ctx as any, viewport: vp } as any).promise;
    await pdf.destroy();
    writeFileSync(out, cv.toBuffer("image/png"));
    console.log("RENDERED", out, Math.ceil(vp.width), Math.ceil(vp.height));
  } catch (e) {
    console.log("RENDER_FAIL", path, (e as Error).message, (e as Error).stack?.slice(0, 200));
  }
}

await render("D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf", "C:/Users/admin/Downloads/_orig_p1.png");
await render("C:/Users/admin/Downloads/edited-edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf.pdf", "C:/Users/admin/Downloads/_exp_p1.png");
