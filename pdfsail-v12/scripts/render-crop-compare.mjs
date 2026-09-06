/**
 * render-crop-compare — 渲染原始 PDF 与导出 PDF 的编辑区域裁剪 PNG，视觉验证字距/重影。
 * 用法: node scripts/render-crop-compare.mjs <origPdf> <exportedPdf> <outPrefix>
 *
 * 定位策略：用 pdfjs getTextContent 找到锚点文本（"S33 PRO MAX" / "power 99%"）的
 * scale=1 设备坐标 (e, f)（f 为 top-down），直接按设备坐标裁剪，不做空间换算猜测。
 */
import * as fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";

GlobalWorkerOptions.workerSrc = new URL(
  "../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url,
).href;

const [, , origPath, expPath, outPrefix = "crop"] = process.argv;
if (!origPath || !expPath) {
  console.error("usage: node render-crop-compare.mjs <origPdf> <exportedPdf> [outPrefix]");
  process.exit(1);
}

const SCALE = 4; // 高倍渲染便于观察字距
const ANCHORS = [
  // 原 PDF 逐字符 Tj → item 可能是单字符；导出 PDF 是合并 run。按位置带定位最稳。
  { name: "row1", find: (it) => it.transform[4] > 340 && it.transform[5] > 748 && it.transform[5] < 772 },
  { name: "row2", find: (it) => it.transform[4] > 340 && it.transform[5] > 686 && it.transform[5] < 710 },
];

async function renderCrops(pdfPath, tag) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: false }).promise;
  const page = await doc.getPage(1); // pdf.js getPage 为 1-based；repro 编辑的是第 1 页
  const vp = page.getViewport({ scale: SCALE });
  const canvas = createCanvas(vp.width, vp.height);
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;

  // 用 scale=1 的 getTextContent 找锚点设备坐标
  const vp1 = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const outDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  for (const a of ANCHORS) {
    const it = tc.items.find((t) => t.str?.trim() && a.find(t));
    if (!it) {
      console.log(`[${tag}] anchor ${a.name}: NOT FOUND`);
      continue;
    }
    const [e, f] = [it.transform[4], it.transform[5]];
    console.log(`[${tag}] anchor ${a.name}: "${it.str}" e=${e.toFixed(2)} f=${f.toFixed(2)}`);
    // 实测：@napi-rs 渲染视口与 getTextContent transform 存在恒定 27.1pt 原点差
    // （crop [f-14, f+6] 实际显示 f+27.1 处内容）→ 裁剪时扣掉该偏移。
    const RENDER_OFFSET = 27.1;
    // 裁剪：x 从行首左侧 20pt 起、宽 200pt；y 从 baseline 上 14pt 到下 6pt（scale1 设备 pt → ×SCALE）
    const sx = Math.max(0, (e - 20) * SCALE);
    const sy = Math.max(0, (f - 14 - RENDER_OFFSET) * SCALE);
    const sw = 200 * SCALE;
    const sh = 20 * SCALE;
    const crop = createCanvas(sw, sh);
    const cctx = crop.getContext("2d");
    cctx.fillStyle = "#ffffff";
    cctx.fillRect(0, 0, sw, sh);
    cctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    const out = path.join(outDir, `${outPrefix}-${tag}-${a.name}.png`);
    fs.writeFileSync(out, crop.toBuffer("image/png"));
    console.log(`saved ${out}`);
  }
  await doc.destroy();
}

await renderCrops(origPath, "orig");
await renderCrops(expPath, "exp");
