/**
 * @diagnostic M7.8-035-R 复现脚本（不修改任何生产代码）。
 * 用真实 PDF 复现三个 BUG，产出真实栅格 diff（BUG-3 是真实导出 PDF 的 pixel diff）。
 *
 *   BUG-1：编辑一个字符 → 未编辑 glyph 几何是否变化 + 行级栅格 diff
 *   BUG-2：先后两次提交 → 第二次提交后第一次编辑的 glyph 几何是否变化
 *   BUG-3：编辑 → 导出真实 PDF → 栅格化 → 与原始 PDF 栅格 pixel diff
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PNG } from "pngjs";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";

import { parsePdfToEditableDocument } from "./pdf-importer";
import { exportEditableDocument, renderDocumentToExportCommands } from "./export-renderer";
import { applyTextOperation } from "./text-operation";

const _canvasCache: any[] = [];
(globalThis as any).document = {
  createElement(tag: string) {
    if (tag === "canvas") {
      const c = createCanvas(1, 1);
      _canvasCache.push(c);
      return c;
    }
    throw new Error(`diag: unsupported element <${tag}>`);
  },
  getElementsByTagName: () => [] as any,
  createElementNS: (_ns: string, tag: string) => (globalThis as any).document.createElement(tag),
} as any;
if (!(globalThis as any).Image) {
  (globalThis as any).Image = class { width = 0; height = 0; src = ""; onload: any = null; onerror: any = null; };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUT_DIR = resolve(__dirname, "..", "..", "..", "diag_bugs_out");
mkdirSync(OUT_DIR, { recursive: true });

GlobalWorkerOptions.workerSrc = new URL("../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).href;
const STANDARD_FONT_DATA_URL = new URL("../../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).href;

async function rasterize(pdfBytes: Uint8Array, pageNo: number, scale: number) {
  try {
    const bytes = pdfBytes instanceof Uint8Array ? new Uint8Array(pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength)) : new Uint8Array(pdfBytes as any);
  const pdf = await getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: false, standardFontDataUrl: STANDARD_FONT_DATA_URL }).promise;
    const page = await pdf.getPage(pageNo);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx as any, viewport } as any).promise;
    const vp1 = page.getViewport({ scale: 1 });
    await pdf.destroy();
    return { png: canvas.toBuffer("image/png"), pageW: vp1.width, pageH: vp1.height, error: null as string | null };
  } catch (e) {
    return { png: null, pageW: 0, pageH: 0, error: (e as Error).message };
  }
}

function pngBuf(b: Buffer) { return PNG.sync.read(b); }
function pixelDiff(a: Buffer, b: Buffer, tag: string, thr = 8) {
  const pa = pngBuf(a), pb = pngBuf(b);
  const w = Math.min(pa.width, pb.width), h = Math.min(pa.height, pb.height);
  const out = new PNG({ width: w, height: h });
  let diff = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
  const total = w * h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ri = (y * w + x) * 4;
    if (Math.abs(pa.data[ri] - pb.data[ri]) > thr || Math.abs(pa.data[ri+1] - pb.data[ri+1]) > thr || Math.abs(pa.data[ri+2] - pb.data[ri+2]) > thr || Math.abs(pa.data[ri+3] - pb.data[ri+3]) > thr) {
      diff++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      out.data[ri] = 255; out.data[ri+1] = 0; out.data[ri+2] = 0; out.data[ri+3] = 255;
    } else {
      out.data[ri] = pa.data[ri]; out.data[ri+1] = pa.data[ri+1]; out.data[ri+2] = pa.data[ri+2]; out.data[ri+3] = pa.data[ri+3];
    }
  }
  const outPath = resolve(OUT_DIR, `diff_${tag}.png`);
  writeFileSync(outPath, PNG.sync.write(out));
  return { diffPixels: diff, totalPixels: total, diffBBox: diff > 0 ? { x0, y0, x1, y1 } : null, outPath };
}

type AnyGlyph = Record<string, any>;
function geo(g: AnyGlyph) {
  return { char: g.char ?? g.originalChar, x: g.bbox?.x, y: g.bbox?.y, w: g.bbox?.width, h: g.bbox?.height, baseline: g.baseline, obx: g.originalBBox?.x, oby: g.originalBBox?.y, obw: g.originalBBox?.width, obh: g.originalBBox?.height, adv: g.advanceWidth, fontSize: g.styleRef !== undefined ? (g.__style?.fontSize) : undefined, modified: g.modified };
}
function lineTextOf(line: any): string { return (line.glyphs ?? []).map((g: any) => g.char ?? g.originalChar ?? g.text ?? "").join(""); }
function findLine(doc: any, textSub: string) {
  for (const page of doc.pages) for (const block of page.blocks) for (const line of block.lines) {
    const t = lineTextOf(line); if (t && t.includes(textSub)) return { page, block, line, blockId: block.id, lineId: line.id, text: t };
  }
  return null;
}

// 行级栅格（用一致的回退字体画每个 glyph，隔离几何变化）。返回 PNG buffer。
function rasterLine(line: any, scale = 4): Buffer {
  const gs = line.glyphs ?? [];
  if (!gs.length) return Buffer.alloc(0);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const g of gs) {
    minX = Math.min(minX, g.bbox.x); maxX = Math.max(maxX, g.bbox.x + g.bbox.width);
    minY = Math.min(minY, g.bbox.y); maxY = Math.max(maxY, g.bbox.y + g.bbox.height);
  }
  const pad = 4;
  const W = Math.ceil((maxX - minX + pad * 2) * scale);
  const H = Math.ceil((maxY - minY + pad * 2) * scale);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#000";
  ctx.textBaseline = "alphabetic";
  for (const g of gs) {
    const size = (g.styleRef !== undefined && g.__style) ? g.__style.fontSize : (g.fontSize ?? 11);
    const family = (g.styleRef !== undefined && g.__style) ? (g.__style.pdfjsFontFamily || g.__style.fontFamily || "sans-serif") : "sans-serif";
    ctx.font = `${g.__style?.fontWeight ?? "normal"} ${size}px ${family}`;
    const bl = g.baseline ?? (g.bbox.y + g.bbox.height * 0.8);
    const lx = (g.bbox.x - minX + pad) * scale;
    const ly = (bl - minY + pad) * scale;
    ctx.fillText(g.char ?? g.originalChar ?? "", lx, ly);
  }
  return canvas.toBuffer("image/png");
}

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) { console.error("用法: npx tsx _diag_bugs.mts <真实PDF> [--text 子串]"); process.exit(2); }
  const abs = resolve(pdfPath);
  const S = Number(arg("--scale") ?? "2");
  const textSub = arg("--text") ?? "ensurings";
  const fileBuf = readFileSync(abs);
  const originalBytes = new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength);

  console.log(`\n==== 载入 ${abs} ====`);
  const doc0 = await parsePdfToEditableDocument(originalBytes, "diag.pdf");
  const target = findLine(doc0, textSub);
  if (!target) { console.error(`[FAIL] 找不到含 "${textSub}" 的行`); process.exit(3); }
  console.log(`[定位] block=${target.blockId} line=${target.lineId} len=${target.text.length} text="${target.text.slice(0, 70)}"`);
  const n = target.text.length;

  // 把 styleRef 解析成 style，挂到 glyph.__style（仅供栅格用回退字体）
  const styleMap = (doc0.pages[0].blocks.find((b: any) => b.id === target.blockId)?.styles) ?? {};
  for (const g of target.line.glyphs) { if (g.styleRef !== undefined) g.__style = styleMap[g.styleRef]; }

  const origGlyphs = JSON.parse(JSON.stringify(target.line.glyphs));
  const origLinePng = rasterLine(target.line);
  writeFileSync(resolve(OUT_DIR, "bug1_orig_line.png"), origLinePng);

  // ── BUG-1：改中间一个字符 ──
  console.log("\n──── BUG-1：编辑一个字符 → 未编辑 glyph 几何是否变化 ────");
  const chIdx = Math.floor(n / 2);
  const repl1 = target.text.slice(0, chIdx) + "X" + target.text.slice(chIdx + 1);
  let doc1 = applyTextOperation(doc0, { type: "replace", blockId: target.blockId, lineId: target.lineId, range: { start: 0, end: n - 1 }, text: repl1 })?.document;
  if (!doc1) { console.error("[FAIL] BUG-1 applyTextOperation"); process.exit(4); }
  const line1 = doc1.pages[0].blocks.flatMap((b: any) => b.lines).find((l: any) => l.id === target.lineId);
  const styleMap1 = doc1.pages[0].blocks.find((b: any) => b.id === target.blockId)?.styles ?? {};
  for (const g of line1.glyphs) if (g.styleRef !== undefined) g.__style = styleMap1[g.styleRef];
  const glyphs1 = line1.glyphs;

  // 几何对比：未编辑的 glyph（char 未变，index 非 chIdx 或 char 仍相同）
  let bug1Changed = 0;
  const TOL = 0.5;
  for (let i = 0; i < glyphs1.length; i++) {
    const a = geo(origGlyphs[i] ?? {}), b = geo(glyphs1[i] ?? {});
    if (a.char === b.char) {
      const diffs: string[] = [];
      if (Math.abs((a.x ?? 0) - (b.x ?? 0)) > TOL) diffs.push(`x ${a.x?.toFixed?.(2)}→${b.x?.toFixed?.(2)}`);
      if (Math.abs((a.y ?? 0) - (b.y ?? 0)) > TOL) diffs.push(`y ${a.y?.toFixed?.(2)}→${b.y?.toFixed?.(2)}`);
      if (Math.abs((a.w ?? 0) - (b.w ?? 0)) > TOL) diffs.push(`w ${a.w?.toFixed?.(2)}→${b.w?.toFixed?.(2)}`);
      if (Math.abs((a.h ?? 0) - (b.h ?? 0)) > TOL) diffs.push(`h ${a.h?.toFixed?.(2)}→${b.h?.toFixed?.(2)}`);
      if (Math.abs((a.baseline ?? 0) - (b.baseline ?? 0)) > TOL) diffs.push(`baseline ${a.baseline?.toFixed?.(2)}→${b.baseline?.toFixed?.(2)}`);
      if (Math.abs((a.adv ?? 0) - (b.adv ?? 0)) > TOL) diffs.push(`advance ${a.adv?.toFixed?.(2)}→${b.adv?.toFixed?.(2)}`);
      if (diffs.length) { bug1Changed++; if (bug1Changed <= 6) console.log(`  [BUG-1] glyph[${i}] (${a.char}) 未编辑却几何变化: ${diffs.join(", ")}`); }
    }
  }
  const bug1Png = rasterLine(line1);
  writeFileSync(resolve(OUT_DIR, "bug1_edited_line.png"), bug1Png);
  const bug1Diff = pixelDiff(origLinePng, bug1Png, "bug1_line");
  console.log(`[BUG-1] 未编辑但几何变化的 glyph 数=${bug1Changed}；行级栅格 diff 像素=${bug1Diff.diffPixels} ${bug1Diff.diffBBox ? JSON.stringify(bug1Diff.diffBBox) : ""}`);
  // 编辑字符本身的变化是预期的；只有「未编辑 glyph 几何变化」才算失败
  console.log(`[BUG-1] ${bug1Changed === 0 ? "PASS(整行未编辑字形几何完全保持，仅被编辑字符本身变化)" : "FAIL(编辑导致未编辑字形几何变化)"}`);

  // ── BUG-2：两次提交 ──
  console.log("\n──── BUG-2：先后两次提交 → 第二次后第一次编辑 glyph 是否变化 ────");
  // 第一次编辑：末段一个词（后 1/4）
  const a0 = Math.floor(n * 0.75), a1 = n - 1;
  const newA = target.text.slice(a0, a1 + 1).replace(/(\w)\1*$/, "Z");
  const replA = target.text.slice(0, a0) + newA + target.text.slice(a1 + 1);
  let docA = applyTextOperation(doc0, { type: "replace", blockId: target.blockId, lineId: target.lineId, range: { start: 0, end: n - 1 }, text: replA })?.document;
  const lineA = docA.pages[0].blocks.flatMap((b: any) => b.lines).find((l: any) => l.id === target.lineId);
  const glyphsA = JSON.parse(JSON.stringify(lineA.glyphs)); // 提交 A 后的快照

  // 第二次编辑：前段（前 1/4），在 docA 之上
  const b0 = 0, b1 = Math.floor(n * 0.25);
  const newB = target.text.slice(b0, b1 + 1).replace(/(\w)\1*$/, "Y");
  const replB = replA.slice(0, b0) + newB + replA.slice(b1 + 1);
  let docB = applyTextOperation(docA, { type: "replace", blockId: target.blockId, lineId: target.lineId, range: { start: 0, end: replA.length - 1 }, text: replB })?.document;
  const lineB = docB.pages[0].blocks.flatMap((b: any) => b.lines).find((l: any) => l.id === target.lineId);
  const glyphsB = lineB.glyphs;

  // 比较 A 编辑区域（索引 a0..a1 对应 docA 里被改的 glyph）在 docA vs docB 是否变化
  let bug2Changed = 0;
  const lenA = glyphsA.length, lenB = glyphsB.length;
  for (let i = 0; i < Math.min(lenA, lenB); i++) {
    const a = geo(glyphsA[i] ?? {}), b = geo(glyphsB[i] ?? {});
    if (a.char === b.char) {
      const diffs: string[] = [];
      if (Math.abs((a.x ?? 0) - (b.x ?? 0)) > TOL) diffs.push(`x`);
      if (Math.abs((a.y ?? 0) - (b.y ?? 0)) > TOL) diffs.push(`y`);
      if (Math.abs((a.w ?? 0) - (b.w ?? 0)) > TOL) diffs.push(`w`);
      if (Math.abs((a.h ?? 0) - (b.h ?? 0)) > TOL) diffs.push(`h`);
      if (Math.abs((a.baseline ?? 0) - (b.baseline ?? 0)) > TOL) diffs.push(`baseline`);
      if (Math.abs((a.adv ?? 0) - (b.adv ?? 0)) > TOL) diffs.push(`advance`);
      if (diffs.length) { bug2Changed++; if (bug2Changed <= 6) console.log(`  [BUG-2] glyph[${i}] (${a.char}) 提交B后几何变化: ${diffs.join(",")}`); }
    }
  }
  const bug2PngA = rasterLine(lineA), bug2PngB = rasterLine(lineB);
  writeFileSync(resolve(OUT_DIR, "bug2_afterA_line.png"), bug2PngA);
  writeFileSync(resolve(OUT_DIR, "bug2_afterB_line.png"), bug2PngB);
  const bug2Diff = pixelDiff(bug2PngA, bug2PngB, "bug2_line");
  console.log(`[BUG-2] 提交B后、提交A所改 glyph 中几何变化数=${bug2Changed}；A→B 行级栅格 diff 像素=${bug2Diff.diffPixels} ${bug2Diff.diffBBox ? JSON.stringify(bug2Diff.diffBBox) : ""}`);
  // 提交 B 后，A 已提交字形的几何必须完全不变（B 自身编辑区的变化是预期的）
  console.log(`[BUG-2] ${bug2Changed === 0 ? "PASS(第二次提交不改变第一次已提交字形的任何几何)" : "FAIL(第二次提交改变了第一次编辑的字形)"}`);

  // ── BUG-3：导出真实 PDF → mutool 栅格 diff（真实产物）────
  console.log("\n──── BUG-3：编辑→导出真实 PDF→栅格 diff（真实产物，mutool）────");
  const exported = await exportEditableDocument(docB, originalBytes.buffer, undefined, undefined, undefined);
  writeFileSync(resolve(OUT_DIR, "bug3_export.pdf"), Buffer.from(exported));
  writeFileSync(resolve(OUT_DIR, "bug3_orig.pdf"), Buffer.from(originalBytes));
  const DPI = 200;
  const pxScale = DPI / 72;
  const m1 = spawnSync("mutool", ["draw", "-o", resolve(OUT_DIR, "bug3_orig.png"), "-r", String(DPI), resolve(OUT_DIR, "bug3_orig.pdf"), "1"], { encoding: "buffer" });
  const m2 = spawnSync("mutool", ["draw", "-o", resolve(OUT_DIR, "bug3_exp.png"), "-r", String(DPI), resolve(OUT_DIR, "bug3_export.pdf"), "1"], { encoding: "buffer" });
  if (m1.status !== 0 || m2.status !== 0) {
    console.error(`[FAIL] mutool 栅格化失败: orig=${m1.status} exp=${m2.status} ${String(m1.stderr ?? m2.stderr).slice(0, 300)}`);
  } else {
    const pa = pngBuf(readFileSync(resolve(OUT_DIR, "bug3_orig.png")));
    const pb = pngBuf(readFileSync(resolve(OUT_DIR, "bug3_exp.png")));
    const W = Math.min(pa.width, pb.width), H = Math.min(pa.height, pb.height);
    let diff = 0; const bbox = { x0: W, y0: H, x1: 0, y1: 0 };
    const out = new PNG({ width: W, height: H });
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const ri = (y * W + x) * 4;
      if (Math.abs(pa.data[ri] - pb.data[ri]) > 8 || Math.abs(pa.data[ri + 1] - pb.data[ri + 1]) > 8 || Math.abs(pa.data[ri + 2] - pb.data[ri + 2]) > 8 || Math.abs(pa.data[ri + 3] - pb.data[ri + 3]) > 8) {
        diff++; bbox.x0 = Math.min(bbox.x0, x); bbox.y0 = Math.min(bbox.y0, y); bbox.x1 = Math.max(bbox.x1, x); bbox.y1 = Math.max(bbox.y1, y);
        out.data[ri] = 255; out.data[ri + 1] = 0; out.data[ri + 2] = 0; out.data[ri + 3] = 255;
      } else { out.data[ri] = pa.data[ri]; out.data[ri + 1] = pa.data[ri + 1]; out.data[ri + 2] = pa.data[ri + 2]; out.data[ri + 3] = pa.data[ri + 3]; }
    }
    writeFileSync(resolve(OUT_DIR, "diff_bug3_page.png"), PNG.sync.write(out));
    // 编辑行像素区域（PDF 点 → 图像像素，y 翻转）
    const lgs = lineB.glyphs;
    const minX = Math.min(...lgs.map((g: any) => g.bbox.x)), minY = Math.min(...lgs.map((g: any) => g.bbox.y));
    const maxX = Math.max(...lgs.map((g: any) => g.bbox.x + g.bbox.width)), maxY = Math.max(...lgs.map((g: any) => g.bbox.y + g.bbox.height));
    const pageH = docB.pages[0].height ?? 792;
    const regX0 = Math.floor(minX * pxScale) - 12, regY0 = Math.floor((pageH - maxY) * pxScale) - 12;
    const regX1 = Math.ceil(maxX * pxScale) + 12, regY1 = Math.ceil((pageH - minY) * pxScale) + 12;
    let inReg = 0, outReg = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const ri = (y * W + x) * 4;
      if (out.data[ri] === 255 && out.data[ri + 1] === 0 && out.data[ri + 2] === 0) {
        if (y >= regY0 && y < regY1 && x >= regX0 && x < regX1) inReg++; else outReg++;
      }
    }
    console.log(`[BUG-3] 整页栅格 diff 像素=${diff}/${W * H} (${(100 * diff / (W * H)).toFixed(3)}%) 整页diff bbox=${JSON.stringify(bbox)}`);
    console.log(`[BUG-3] 编辑行像素区域=${JSON.stringify({ x0: regX0, y0: regY0, x1: regX1, y1: regY1 })}`);
    console.log(`[BUG-3] diff 落在编辑行内=${inReg} 落在编辑行外(疑似溢出/重影/侵占相邻行)=${outReg}`);
    console.log(`[BUG-3] 产物: ${OUT_DIR}/bug3_export.pdf + bug3_orig.png + bug3_exp.png + diff_bug3_page.png 可直接肉眼核对`);
    console.log(`[BUG-3] ${outReg === 0 && inReg > 0 ? "PASS(仅编辑行内变化，无溢出/重影/侵占相邻行)" : (outReg > 0 ? "FAIL(diff 溢出编辑行外)" : "FAIL(无任何变化？导出可能未生效)")}`);
  }

  console.log(`\n产物目录 ${OUT_DIR}`);
}
main().catch((e) => { console.error("异常:", e); process.exit(1); });
