/**
 * @diagnostic 分叉诊断脚本（不修改任何生产代码）。
 * 一次运行 Test A / B / C 三个实验，验证假设而非改架构。
 *
 *   Test A：Editor 数据前后对照（原始 glyph vs 编辑后 replacement glyph）
 *   Test B：第二个 EditBox 的像素责任人（编辑→导出→栅格化→pixel diff→定位 command）
 *   Test C：零编辑基线（Original→Import→Export→栅格化→diff，不编辑）
 *
 * 运行：
 *   npx tsx frontend/src/document-model/_diag_fork.mts <真实PDF路径> [--text 子串] [--edit 替换文本] [--scale 2] [--realbox]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PNG } from "pngjs";

import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";

import { parsePdfToEditableDocument } from "./pdf-importer";
import { exportEditableDocument, renderDocumentToExportCommands } from "./export-renderer";
import { applyTextOperation } from "./text-operation";

// ── 最小 DOM shim：让依赖 document.createElement('canvas') 的字体测量在 Node 下可用 ──
// （@napi-rs/canvas 提供 canvas + 2d context，覆盖 importer/font-detector 的测量需求）
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
  (globalThis as any).Image = class {
    width = 0; height = 0; src = ""; onload: any = null; onerror: any = null;
  };
}

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

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ── 栅格化 ───────────────────────────────────────────────
async function rasterize(pdfBytes: Uint8Array, pageNo: number, scale: number) {
  try {
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
    await page.render({ canvasContext: ctx as any, viewport } as any).promise;
    const vp1 = page.getViewport({ scale: 1 });
    await pdf.destroy();
    return { png: canvas.toBuffer("image/png"), pageW: vp1.width, pageH: vp1.height, error: null as string | null };
  } catch (e) {
    return { png: null, pageW: 0, pageH: 0, error: (e as Error).message };
  }
}

function pngBuf(b: Buffer) {
  return PNG.sync.read(b);
}

// 像素 diff，返回 { diffPixels, total, diffBBox:{x0,y0,x1,y1}(像素,from top-left), outPath }
function pixelDiff(a: Buffer, b: Buffer, tag: string) {
  const pa = pngBuf(a);
  const pb = pngBuf(b);
  const w = Math.min(pa.width, pb.width);
  const h = Math.min(pa.height, pb.height);
  const out = new PNG({ width: w, height: h });
  let diff = 0;
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  const total = w * h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ri = (y * w + x) * 4;
      const dr = Math.abs(pa.data[ri] - pb.data[ri]);
      const dg = Math.abs(pa.data[ri + 1] - pb.data[ri + 1]);
      const db = Math.abs(pa.data[ri + 2] - pb.data[ri + 2]);
      const da = Math.abs(pa.data[ri + 3] - pb.data[ri + 3]);
      if (dr > 8 || dg > 8 || db > 8 || da > 8) {
        diff++;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y);
        x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        out.data[ri] = 255; out.data[ri + 1] = 0; out.data[ri + 2] = 0; out.data[ri + 3] = 255;
      } else {
        out.data[ri] = pa.data[ri]; out.data[ri + 1] = pa.data[ri + 1];
        out.data[ri + 2] = pa.data[ri + 2]; out.data[ri + 3] = pa.data[ri + 3];
      }
    }
  }
  const outPath = resolve(OUT_DIR, `diff_${tag}.png`);
  writeFileSync(outPath, PNG.sync.write(out));
  return {
    diffPixels: diff,
    totalPixels: total,
    diffBBox: diff > 0 ? { x0, y0, x1, y1 } : null,
    outPath,
  };
}

// ── 工具 ───────────────────────────────────────────────
type AnyGlyph = Record<string, any>;
function dumpGlyphFields(g: AnyGlyph) {
  const m = g.glyphMetrics ?? g.rawGlyph ?? {};
  return {
    char: g.char ?? g.originalChar,
    fontFamily: g.fontFamily ?? m.fontFamily,
    fontSize: g.fontSize ?? m.fontSize,
    fontWeight: g.fontWeight ?? m.fontWeight,
    fontStyle: g.fontStyle ?? m.fontStyle,
    lineHeight: g.lineHeight ?? m.lineHeight,
    width: g.width,
    height: g.height,
    bbox: g.bbox,
    baseline: g.baseline,
    transform: g.transform ?? m.transform,
    scaleX: g.scaleX ?? m.scaleX,
    scaleY: g.scaleY ?? m.scaleY,
    advanceWidth: g.advanceWidth ?? m.advanceWidth,
    pdfTransform: g.pdfTransform ?? m.pdfTransform,
    fontIdentity: g.fontIdentity ?? m.fontIdentity,
    pdfCharCode: g.pdfCharCode ?? m.pdfCharCode,
  };
}

function lineTextOf(line: any): string {
  return (line.glyphs ?? []).map((g: any) => g.char ?? g.originalChar ?? g.text ?? "").join("");
}
function findLine(doc: any, textSub?: string) {
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        const t = lineTextOf(line);
        if (!t) continue;
        if (!textSub || t.includes(textSub)) {
          return { page, block, line, blockId: block.id, lineId: line.id, text: t };
        }
      }
    }
  }
  return null;
}

function firstChangedField(a: AnyGlyph, b: AnyGlyph): string | null {
  const fa = dumpGlyphFields(a);
  const fb = dumpGlyphFields(b);
  for (const k of Object.keys(fa)) {
    const va = JSON.stringify(fa[k]);
    const vb = JSON.stringify(fb[k]);
    if (va !== vb) return k;
  }
  return null;
}

// 把像素 bbox（from top-left, scale S）换算成 PDF pt（bottom-left origin）
function pxToPt(bbox: { x0: number; y0: number; x1: number; y1: number }, S: number, pageHpt: number) {
  const xL = bbox.x0 / S;
  const xR = bbox.x1 / S;
  const yTop = pageHpt - bbox.y1 / S;
  const yBot = pageHpt - bbox.y0 / S;
  return { xL, xR, yTop, yBot, w: xR - xL, h: yBot - yTop };
}

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error("用法: npx tsx _diag_fork.mts <真实PDF路径> [--text 子串] [--edit 替换文本] [--scale 2]");
    process.exit(2);
  }
  const abs = resolve(pdfPath);
  const S = Number(arg("--scale") ?? "2");
  const textSub = arg("--text") ?? undefined;
  const editArg = arg("--edit");
  const useRealBox = process.argv.includes("--realbox");

  console.log(`\n==== 载入 ${abs} ====`);
  const fileBuf = readFileSync(abs);
  const originalBytes = new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength);

  let imported = await parsePdfToEditableDocument(originalBytes, "diag.pdf");
  const target = findLine(imported, textSub);
  if (!target) {
    console.error(`[FAIL] 找不到包含 "${textSub ?? ""}" 的文本行（或 PDF 无文本层）。`);
    process.exit(3);
  }
  console.log(`[定位] block=${target.blockId} line=${target.lineId} text="${target.text.slice(0, 60)}"`);
  const origGlyphs = JSON.parse(JSON.stringify(target.line.glyphs));

  // ── Test A：编辑前/后 glyph 字段对照 ──
  console.log("\n──── Test A：Editor 数据前后对照 ────");
  const len = target.text.length;
  const mid = Math.floor(len / 2);
  const replacement = editArg ?? target.text.slice(0, mid) + "X" + target.text.slice(mid + 1);
  const op: any = {
    type: "replace",
    blockId: target.blockId,
    lineId: target.lineId,
    range: { start: 0, end: len - 1 },
    text: replacement,
  };
  const mut = applyTextOperation(imported, op);
  if (!mut || !mut.mutated) {
    console.error("[FAIL] applyTextOperation 失败:", mut?.reason ?? "unknown");
    process.exit(4);
  }
  // applyTextOperation 返回「新 doc」（不原地改），需接住并重新定位被编辑的 block/line
  imported = mut.document;
  const editedBlock = imported.pages[0].blocks.find((b: any) => b.id === target.blockId);
  if (editedBlock) {
    editedBlock.layoutMode = "reconstruct";
    editedBlock.isEdited = true;
  }
  const editedLine = imported.pages[0].blocks
    .flatMap((b: any) => b.lines)
    .find((l: any) => l.id === target.lineId) ?? target.line;
  // 取其编辑后 glyph 数组
  const replGlyphs = editedLine.glyphs;
  const n = Math.min(origGlyphs.length, replGlyphs.length);
  let firstChangedFieldName: string | null = null;
  let changedGlyphIdx = -1;
  for (let i = 0; i < n; i++) {
    const fo = dumpGlyphFields(origGlyphs[i]);
    const fr = dumpGlyphFields(replGlyphs[i]);
    const diffs = Object.keys(fo).filter((k) => JSON.stringify(fo[k]) !== JSON.stringify(fr[k]));
    if (diffs.length) {
      changedGlyphIdx = i;
      firstChangedFieldName = diffs[0];
      console.log(`[Test A] glyph[${i}] 原始:`, fo);
      console.log(`[Test A] glyph[${i}] 替换:`, fr);
      console.log(`[Test A] glyph[${i}] 差异字段:`, diffs);
      break;
    }
  }
  if (changedGlyphIdx < 0) {
    // 字形数量或字段都未变，比较整行文本/字段集合
    const fo0 = dumpGlyphFields(origGlyphs[0] ?? {});
    const fr0 = dumpGlyphFields(replGlyphs[0] ?? {});
    const diffs = Object.keys(fo0).filter((k) => JSON.stringify(fo0[k]) !== JSON.stringify(fr0[k]));
    console.log(`[Test A] 逐字形字段无差异，glyph[0] 差异字段:`, diffs);
    firstChangedFieldName = diffs[0] ?? null;
  }
  console.log(`[Test A] 第一个发生变化的字段 = ${firstChangedFieldName ?? "(无变化)"}`);

  // ── 合成 editedLineBoxes（模拟编辑器 canvas 扫描的真实墨迹盒）──
  let editedLineBoxes: Map<string, any> | undefined;
  if (useRealBox) {
    editedLineBoxes = new Map();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const g of editedLine.glyphs) {
      const b = g.bbox;
      if (!b) continue;
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
    }
    if (maxX > minX) {
      editedLineBoxes.set(target.lineId, {
        x: minX - 2, y: minY - 2, width: maxX - minX + 4, height: maxY - minY + 4,
      });
    }
  }

  // ── Test B：几何定位「哪一个 command 把 A 的下半部分弄没了」──
  // 不依赖栅格化：直接比对导出命令里 编辑行 的 mask 区域 与 重绘 glyph 区域。
  // 若 mask 区域 > 重绘区域（尤其 mask.bottom > 重绘.bottom），则下半段被 mask 擦掉却没被重绘覆盖 → mask 是责任人。
  console.log("\n──── Test B：几何责任人（mask 区域 vs 重绘区域）────");
  const exportBytes = await exportEditableDocument(imported, originalBytes.buffer, undefined, undefined, editedLineBoxes);
  writeFileSync(resolve(OUT_DIR, "B_export.pdf"), Buffer.from(exportBytes));

  const ctx = {
    renderScale: imported.runtime?.renderScale ?? 1.5,
    cssScale: imported.runtime?.cssScale ?? 1,
    pageHeightPt: imported.pages[0]?.height ?? 792,
  } as any;
  const commands = renderDocumentToExportCommands(imported, ctx, undefined, editedLineBoxes) as any[];

  // 找到被编辑行在 commands 中的 lineIndex
  const editedLineIndex = (() => {
    for (const blk of imported.pages[0].blocks) {
      const idx = blk.lines.findIndex((l: any) => l.id === target.lineId);
      if (idx >= 0) return idx;
    }
    return 0;
  })();

  const maskCmds = commands.filter(
    (c) => c.purpose === "mask" && c.type === "drawLine" && c.lineIndex === editedLineIndex,
  );
  const redrawCmds = commands.filter(
    (c) => (c.type === "drawTextGlyph" || c.purpose === "replacement") && c.lineIndex === editedLineIndex,
  );

  function region(c: any) {
    return { xL: c.x, xR: c.x + (c.width ?? 0), yTop: c.y + (c.height ?? 0), yBot: c.y, w: c.width ?? 0, h: c.height ?? 0 };
  }
  let maskR: any = null;
  for (const m of maskCmds) {
    const r = region(m);
    if (!maskR) maskR = { ...r };
    else {
      maskR.xL = Math.min(maskR.xL, r.xL); maskR.xR = Math.max(maskR.xR, r.xR);
      maskR.yTop = Math.min(maskR.yTop, r.yTop); maskR.yBot = Math.max(maskR.yBot, r.yBot);
    }
  }
  let redrawR: any = null;
  for (const d of redrawCmds) {
    const r = region(d);
    if (!redrawR) redrawR = { ...r };
    else {
      redrawR.xL = Math.min(redrawR.xL, r.xL); redrawR.xR = Math.max(redrawR.xR, r.xR);
      redrawR.yTop = Math.min(redrawR.yTop, r.yTop); redrawR.yBot = Math.max(redrawR.yBot, r.yBot);
    }
  }

  console.log(`[Test B] mask 命令数=${maskCmds.length}  重绘 glyph 命令数=${redrawCmds.length}`);
  if (maskR) console.log(`[Test B] mask 区域(pt): x[${maskR.xL.toFixed(1)},${maskR.xR.toFixed(1)}] y[bot=${maskR.yBot.toFixed(1)},top=${maskR.yTop.toFixed(1)}] h=${(maskR.yTop - maskR.yBot).toFixed(1)}`);
  if (redrawR) console.log(`[Test B] 重绘区域(pt): x[${redrawR.xL.toFixed(1)},${redrawR.xR.toFixed(1)}] y[bot=${redrawR.yBot.toFixed(1)},top=${redrawR.yTop.toFixed(1)}] h=${(redrawR.yTop - redrawR.yBot).toFixed(1)}`);

  if (maskR && redrawR) {
    // 阈值：AA padding 约 1.3pt；>2pt 视为真正的空隙/错位
    const T = 2;
    // mask 比 redraw 更靠下（mask 底 < redraw 底）→ 下半段被擦掉却没重绘
    const uncoveredBottomH = Math.max(0, redrawR.yBot - maskR.yBot);
    // mask 比 redraw 更靠上（mask 顶 > redraw 顶）→ 上半段被擦掉却没重绘 → 重影
    const uncoveredTopH = Math.max(0, maskR.yTop - redrawR.yTop);
    // redraw 超出 mask 左右（新文字画到 mask 外）→ 原文字该侧漏擦 → 重影
    const redrawOverflowL = Math.max(0, redrawR.xL - maskR.xL);
    const redrawOverflowR = Math.max(0, maskR.xR - redrawR.xR);
    console.log(`[Test B] 空隙(pt): 下沿空隙=${uncoveredBottomH.toFixed(1)} 上沿空隙=${uncoveredTopH.toFixed(1)} 左溢出=${redrawOverflowL.toFixed(1)} 右溢出=${redrawOverflowR.toFixed(1)}`);
    if (uncoveredBottomH > T) {
      console.log(`[Test B] ★ 结论：MASK 命令擦掉了比「重绘」更靠下的区域（多出 ${uncoveredBottomH.toFixed(1)}pt）→ A 的下半部分被 mask 弄没、且重绘未覆盖 → 责任人是 MASK 命令（其 y/height 算大了，或重绘 glyph 的 bbox 算小了）。`);
    } else if (uncoveredTopH > T) {
      console.log(`[Test B] ★ 结论：MASK 顶比「重绘」高 ${uncoveredTopH.toFixed(1)}pt → 原文字上半段没被擦净 → 重影（责任人也是 MASK，太小）。`);
    } else if (redrawOverflowL > T || redrawOverflowR > T) {
      console.log(`[Test B] ★ 结论：重绘 glyph 在左右方向溢出 mask（左溢 ${redrawOverflowL.toFixed(1)} / 右溢 ${redrawOverflowR.toFixed(1)}pt）→ 原文字两侧漏擦 → 重影（责任人是重绘 glyph 的 x/width 或 MASK 太窄）。`);
    } else {
      console.log(`[Test B] ★ 结论：mask 区域与重绘区域基本重合（差值 < ${T}pt，属 AA padding）→ 几何上不会弄没 A 的下半部分。若仍重影，根因在字体/坐标变换（drawTextGlyph 的 baseline / pdfTransform / 字体度量），不是 mask 尺寸。`);
    }
  } else {
    console.log(`[Test B] 未找到编辑行的 mask 或重绘命令 → 导出未对该行做 overlay（可能走了 native rewrite 原字体重写路径）。需要进一步看 native 重写是否对齐。`);
  }

  // ── Test C：零编辑基线（几何代理：零编辑时导出是否仍产生 overlay 命令）──
  console.log("\n──── Test C：零编辑基线 ────");
  const doc2 = await parsePdfToEditableDocument(originalBytes, "diag2.pdf");
  const ctx2 = {
    renderScale: doc2.runtime?.renderScale ?? 1.5,
    cssScale: doc2.runtime?.cssScale ?? 1,
    pageHeightPt: doc2.pages[0]?.height ?? 792,
  } as any;
  const cmds0 = renderDocumentToExportCommands(doc2, ctx2, undefined, undefined) as any[];
  const overlay0 = cmds0.filter(
    (c) => c.purpose === "mask" || c.type === "drawTextGlyph" || c.purpose === "replacement",
  );
  console.log(`[Test C] 零编辑导出命令总数=${cmds0.length}，其中 overlay(masked/redraw/replacement) 命令数=${overlay0.length}`);
  if (overlay0.length === 0) {
    console.log(`[Test C] 结论：零编辑不产生任何 overlay 命令 → Export 只在 mutation 后出问题（pipeline 本身不改未编辑内容）。`);
  } else {
    const byB = new Map<string, number>();
    for (const c of overlay0) byB.set(c.blockId, (byB.get(c.blockId) ?? 0) + 1);
    console.log(`[Test C] 结论：零编辑仍产生 overlay 命令（blocks=${JSON.stringify([...byB.entries()])}）→ Export pipeline 本身会改动内容。`);
  }

  console.log(`\n诊断产物在 ${OUT_DIR}（B_export.pdf 可单独用浏览器/Adobe 打开人工核对）`);
}

main().catch((e) => {
  console.error("诊断异常:", e);
  process.exit(1);
});
