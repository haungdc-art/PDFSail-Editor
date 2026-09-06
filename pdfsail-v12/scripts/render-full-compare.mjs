/**
 * render-full-compare — 整页渲染原始 PDF 与导出 PDF（scale 2），用于整页视觉对比。
 * 用法: node scripts/render-full-compare.mjs <origPdf> <exportedPdf> <outPrefix>
 */
import * as fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";

GlobalWorkerOptions.workerSrc = new URL(
  "../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url,
).href;

const [, , origPath, expPath, outPrefix = "full"] = process.argv;
if (!origPath || !expPath) {
  console.error("usage: node render-full-compare.mjs <origPdf> <exportedPdf> [outPrefix]");
  process.exit(1);
}

async function renderFull(pdfPath, tag) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: false }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 2 });
  const canvas = createCanvas(vp.width, vp.height);
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const outDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const out = path.join(outDir, `${outPrefix}-${tag}-page1.png`);
  fs.writeFileSync(out, canvas.toBuffer("image/png"));
  console.log(`saved ${out} (${vp.width}x${vp.height})`);
  await doc.destroy();
}

await renderFull(origPath, "orig");
await renderFull(expPath, "exp");
