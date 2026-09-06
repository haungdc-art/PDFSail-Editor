/**
 * @diagnostic 临时诊断脚本（不修改任何生产代码）。
 * 目的：在真实 PDF 上跑通 Test C（零编辑基线）：
 *   Original → Import → Export → Rasterize → pixel diff
 * 节点内只读调用：parsePdfToEditableDocument / exportEditableDocument / runBaseline / pdf-lib 读 bytes。
 *
 * 运行：npx tsx frontend/src/document-model/_diag_testc.mts <path-to-real.pdf>
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { runBaseline } from "./baseline-runner";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { exportEditableDocument } from "./export-renderer";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUT_DIR = resolve(__dirname, "..", "..", "..", "_diag_out");
mkdirSync(OUT_DIR, { recursive: true });

GlobalWorkerOptions.workerSrc = new URL(
  "../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url,
).href;
const STANDARD_FONT_DATA_URL = new URL(
  "../../../node_modules/pdfjs-dist/standard_fonts/",
  import.meta.url,
).href;

/** Node 渲染单页 PDF 为 PNG buffer（用 @napi-rs/canvas 作为 pdf.js 的 canvas backend） */
async function rasterizePage(pdfBytes: Uint8Array, pageNo: number, scale = 2): Promise<Buffer> {
  const pdf = await getDocument({
    data: new Uint8Array(pdfBytes),
    isEvalSupported: false,
    useSystemFonts: false,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  }).promise;
  const page = await pdf.getPage(pageNo);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  const renderTask = page.render({ canvasContext: ctx as any, viewport } as any);
  await renderTask.promise;
  await pdf.destroy();
  return canvas.toBuffer("image/png");
}

/** 用纯像素差做 diff：返回 { diffPixels, totalPixels, outPath } */
async function pixelDiff(
  a: Buffer,
  b: Buffer,
  tag: string,
): Promise<{ diffPixels: number; totalPixels: number; outPath: string }> {
  const { PNG } = await import("pngjs").catch(() => ({ PNG: null }));
  if (!PNG) {
    // pngjs 不可用，退化为文件大小对比（不精确，仅占位）
    return { diffPixels: -1, totalPixels: -1, outPath: "pngjs-not-installed" };
  }
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  const w = Math.min(pa.width, pb.width);
  const h = Math.min(pa.height, pb.height);
  const out = new PNG({ width: w, height: h });
  let diff = 0;
  const total = w * h;
  for (let i = 0; i < total; i++) {
    const ri = i * 4;
    const dr = Math.abs(pa.data[ri] - pb.data[ri]);
    const dg = Math.abs(pa.data[ri + 1] - pb.data[ri + 1]);
    const db = Math.abs(pa.data[ri + 2] - pb.data[ri + 2]);
    const da = Math.abs(pa.data[ri + 3] - pb.data[ri + 3]);
    if (dr > 8 || dg > 8 || db > 8 || da > 8) {
      diff++;
      out.data[ri] = 255;
      out.data[ri + 1] = 0;
      out.data[ri + 2] = 0;
      out.data[ri + 3] = 255;
    } else {
      out.data[ri] = pa.data[ri];
      out.data[ri + 1] = pa.data[ri + 1];
      out.data[ri + 2] = pa.data[ri + 2];
      out.data[ri + 3] = pa.data[ri + 3];
    }
  }
  const outPath = resolve(OUT_DIR, `diff_${tag}.png`);
  writeFileSync(outPath, PNG.sync.write(out));
  return { diffPixels: diff, totalPixels: total, outPath };
}

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error("用法: npx tsx _diag_testc.mts <真实PDF路径>");
    process.exit(2);
  }
  const abs = resolve(pdfPath);
  console.log(`[Test C] 载入 ${abs}`);
  const originalBytes = new Uint8Array(readFileSync(abs));

  // 1) 原始 PDF 栅格化（第 1 页）
  const origPng = await rasterizePage(originalBytes, 1);
  writeFileSync(resolve(OUT_DIR, "orig_p1.png"), origPng);

  // 2) 零编辑基线：Import → Export
  const doc = await parsePdfToEditableDocument(originalBytes, "diag.pdf");
  const exportBytes = await exportEditableDocument(doc, originalBytes.buffer);
  writeFileSync(resolve(OUT_DIR, "export_zeroedit.pdf"), Buffer.from(exportBytes));

  // 3) 导出 PDF 栅格化（第 1 页）
  const expPng = await rasterizePage(exportBytes, 1);
  writeFileSync(resolve(OUT_DIR, "export_p1.png"), expPng);

  // 4) 像素 diff
  const diff = await pixelDiff(origPng, expPng, "c_zeroedit");
  console.log(`[Test C] 零编辑 pixel diff: diffPixels=${diff.diffPixels} / total=${diff.totalPixels} → ${OUT_DIR}/diff_c_zeroedit.png`);

  // 5) 顺带跑 runBaseline 的文本/坐标比较（看 export 是否动了原内容）
  try {
    const r = await runBaseline(originalBytes);
    console.log(`[Test C] runBaseline: 原始项=${r.originalItemCount} 报告=`);
    console.log(JSON.stringify(r.report.summary ?? r.report, null, 2).slice(0, 2000));
  } catch (e) {
    console.log(`[Test C] runBaseline 失败（不影响 pixel diff）: ${(e as Error).message}`);
  }

  console.log("[Test C] 完成。结论判定:");
  console.log("  diffPixels===0 → Export 只在 mutation 后出问题（edit 是触发点）");
  console.log("  diffPixels>0  → Export pipeline 本身破坏原 PDF");
}

main().catch((e) => {
  console.error("诊断脚本异常:", e);
  process.exit(1);
});
