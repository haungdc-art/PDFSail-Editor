/**
 * FontDetector — 扫描件原字体检测（M7.7-004U-EditStyle）
 *
 * 背景：
 *   扫描 PDF 的"原文"是页面图像里的像素（无文本层）。编辑某行后，新文本由 CSS span 渲染，
 *   若字体/字重与扫描原文不一致，用户会看到"编辑后字体样式与原文本完全不一样"。
 *   OCR 引擎（GLM-OCR）不返回字体信息，因此需从页面图像推断原字体。
 *
 * 原理：
 *   对每个 OCR block 的文字区域，把扫描像素二值化，再与候选字体（Arial/Times/Helvetica/
 *   Georgia/Courier 的 regular/bold）在若干字号 × 水平偏移下渲染的文本做 **Jaccard 相似度**
 *   （与 tools/_font-match-analyze.mjs 验证过的离线方法一致）。得分最高的候选即该行最接近的字体。
 *
 * v2 关键改进（修复：OCR block 常含多行，旧版按 lineHeight 数学裁剪导致首行+后续行混入扫描区，
 * 得分被稀释 → 误判 / 匹配失败）：
 *   1. 块内做**行暗像素带检测**，隔离出第一行墨迹带（行带法，与离线 analyze 一致）。
 *   2. 首行带内再取**墨迹 x 范围**裁剪（忽略块右侧空白）。
 *   3. 候选渲染后按**候选墨迹宽度右裁剪**扫描（OCR 文本常比渲染首行长/短，避免右侧空匹配）。
 *   4. 水平偏移搜索扩到 -8..8。
 *
 * 坐标系约定（与 OCR adapter / display canvas 一致）：
 *   - 传入的 canvas 是 pdf.js 以 scale=1.5 渲染的页面（display canvas）。
 *   - OCR block 的 x/y/w/h/fontSize 同处 scale=1.5 空间 → 与 canvas 像素 1:1。
 *
 * 输出：
 *   - byBlock: blockId → 该块最佳匹配字体
 *   - dominant: 全页多数投票的字体（用于未能匹配的块 / 兜底）
 */
import type { BBox } from "./types";

/** 检测出的字体样式 */
export interface DetectedFont {
  /** CSS font-family（单个族名，如 "Arial"） */
  fontFamily: string;
  /** CSS font-weight（400/700） */
  fontWeight: number;
  /** 匹配置信度（0..1，Jaccard 得分） */
  confidence: number;
}

/** 字体检测结果 */
export interface FontDetectionResult {
  /** blockId → 检测字体（仅成功匹配的块） */
  byBlock: Map<string, DetectedFont>;
  /** 全页多数投票字体（任何块都能用，作兜底） */
  dominant: DetectedFont | null;
}

/** 参与匹配的 OCR block（最小契约：id + 几何 + 文本） */
export interface FontDetectionBlock {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fontSize: number;
}

/** 候选字体族（拉丁扫描件的常见字体；字重单独按笔画宽度判定）。
 *  ⚠️ 不包含 Helvetica：它与 Arial 度量/字形几乎相同，得分恒相等 → top2 gap=0 → 置信度门槛误拒所有块。 */
const FAMILY_CANDIDATES: Array<{ family: string }> = [
  { family: "Arial" },
  { family: "Times New Roman" },
  { family: "Georgia" },
  { family: "Courier New" },
];

/** 单块最多匹配的字符数（加速 + 抗噪） */
const MAX_TEXT_CHARS = 48;
/** 最多参与检测的块数（大文档限流，超出部分走 dominant） */
const MAX_BLOCKS = 40;
/** 灰度阈值：< 128 视为墨迹 */
const INK_GRAY = 128;

/**
 * 计算扫描二值图与候选渲染二值图的 Jaccard 相似度。
 *
 * scan: 扫描区域二值图（宽 bw × 高 bh，0/1）
 * cdata: 候选 canvas 的 RGBA 像素
 * cw: 候选 canvas 宽
 * off: 水平偏移（候选字相对扫描）
 * margin: 垂直裁剪边距（跳过候选图顶部杂边）
 * effW: 有效比较宽度（扫描右裁剪，见右对齐说明）
 */
function jaccard(
  scan: Uint8Array,
  bw: number,
  bh: number,
  cdata: Uint8ClampedArray,
  cw: number,
  off: number,
  margin: number,
  effW: number
): number {
  let darkBoth = 0, darkScan = 0, darkCand = 0;
  const rows = cdata.length / 4 / cw;
  for (let y = 0; y < bh; y++) {
    const cy = y + margin;
    if (cy >= rows) continue;
    for (let x = 0; x < effW; x++) {
      const s = scan[y * bw + x];
      if (s === 1) darkScan++;
      const cx = x + off;
      if (cx < 0 || cx >= cw) continue;
      const cp = (cy * cw + cx) * 4;
      const g = cdata[cp] * 0.299 + cdata[cp + 1] * 0.587 + cdata[cp + 2] * 0.114;
      if (g < 128) darkCand++;
      if (s === 1 && g < 128) darkBoth++;
    }
  }
  const union = darkScan + darkCand - darkBoth;
  return union > 0 ? darkBoth / union : 0;
}

/** 候选画布中墨迹的最右 x（无墨迹返回 -1）。用于把扫描右裁剪到候选文本宽度。 */
function inkRightEdge(data: Uint8ClampedArray, cw: number, ch: number): number {
  const rows = ch;
  let maxX = -1;
  for (let y = 0; y < rows; y++) {
    for (let x = cw - 1; x >= 0; x--) {
      const cp = (y * cw + x) * 4;
      const g = data[cp] * 0.299 + data[cp + 1] * 0.587 + data[cp + 2] * 0.114;
      if (g < 128) {
        if (x > maxX) maxX = x;
        break;
      }
    }
  }
  return maxX;
}

/**
 * 计算二值图（0/1）的横向暗像素 run 长度中位数 —— 即文本的「平均笔画宽度」。
 *
 * 字重判定关键指标：bold 的笔画显著粗于 regular（同字号下 median run 约 1.5×）。
 * 扫描有模糊/锯齿会让 run 略粗，但 regular/bold 的相对差异保持。
 */
function medianRunLength(bin: Uint8Array, w: number, h: number): number {
  const runs: number[] = [];
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x < w; x++) {
      if (bin[y * w + x]) run++;
      else {
        if (run > 0) { runs.push(run); run = 0; }
      }
    }
    if (run > 0) runs.push(run);
  }
  if (runs.length === 0) return 0;
  runs.sort((a, b) => a - b);
  return runs[Math.floor(runs.length / 2)];
}

/**
 * 检测单个 block 的最佳字体。
 *
 * @returns 最佳候选；无法可靠匹配（无暗像素 / 区域过小 / 低置信度）返回 null
 */
function detectBlockFont(
  canvas: HTMLCanvasElement,
  block: FontDetectionBlock
): DetectedFont | null {
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const fontSize = block.fontSize;
  if (!Number.isFinite(fontSize) || fontSize <= 0) return null;

  // 1) 裁剪 block bbox（含可能的多行；带 2px 内缩避开相邻元素）
  const pad = 2;
  const x0 = Math.max(0, Math.round(block.x) + pad);
  const y0 = Math.max(0, Math.round(block.y));
  const bw = Math.min(W - x0, Math.max(0, Math.round(block.w) - pad * 2));
  const bh = Math.min(H - y0, Math.max(8, Math.round(block.h)));
  if (bw < 20 || bh < 8) return null;

  let img: ImageData;
  try {
    img = ctx.getImageData(x0, y0, bw, bh);
  } catch {
    return null;
  }
  const d = img.data;

  // 2) 逐行暗像素数 → 找首行墨迹带（行带法：隔离第一行，避免多行混入）
  const rowDark = new Uint32Array(bh);
  let totalDark = 0;
  for (let y = 0; y < bh; y++) {
    const base = y * bw * 4;
    let c = 0;
    for (let x = 0; x < bw; x++) {
      const px = base + x * 4;
      const g = d[px] * 0.299 + d[px + 1] * 0.587 + d[px + 2] * 0.114;
      if (g < INK_GRAY) c++;
    }
    rowDark[y] = c;
    totalDark += c;
  }
  if (totalDark < 24) return null;

  // 带阈值取峰值 4%（宽松，覆盖完整行；25% 会把首行截成字母顶端细条）。
  // 首行 = 块内第一个连续墨迹带（行间空白自然分隔多行）。
  const maxRowDark = Math.max(...rowDark);
  const bandThr = Math.max(2, maxRowDark * 0.04);
  let bandStart = -1;
  let bandEnd = -1;
  for (let y = 0; y < bh; y++) {
    if (rowDark[y] >= bandThr) {
      bandStart = y;
      let j = y;
      while (j < bh && rowDark[j] >= bandThr) j++;
      bandEnd = j;
      break;
    }
  }
  if (bandStart < 0) return null;
  // 首行高度上限：不超过 fontSize 的 1.7 倍（避免把第二行/下划线并入）
  const lineH = Math.min(bandEnd - bandStart, Math.ceil(fontSize * 1.7));
  if (lineH < 6) return null;
  const ly1 = bandStart + lineH;

  // 3) 首行带内墨迹 x 范围
  let minX = bw;
  let maxX = -1;
  for (let y = bandStart; y < ly1; y++) {
    const base = y * bw * 4;
    for (let x = 0; x < bw; x++) {
      const px = base + x * 4;
      const g = d[px] * 0.299 + d[px + 1] * 0.587 + d[px + 2] * 0.114;
      if (g < INK_GRAY) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  if (maxX < 0) return null;
  const ix0 = Math.max(0, minX - 3);
  const iw = Math.min(bw - ix0, maxX - minX + 7);
  const ih = ly1 - bandStart;
  if (iw < 20 || ih < 8) return null;

  // 4) 二值化首行扫描
  const scan = new Uint8Array(iw * ih);
  let dark = 0;
  for (let y = 0; y < ih; y++) {
    const srcRow = (bandStart + y) * bw * 4;
    for (let x = 0; x < iw; x++) {
      const px = srcRow + (ix0 + x) * 4;
      const g = d[px] * 0.299 + d[px + 1] * 0.587 + d[px + 2] * 0.114;
      if (g < INK_GRAY) {
        scan[y * iw + x] = 1;
        dark++;
      }
    }
  }
  if (dark < 24) return null;

  // 5) 候选文本：取块文本首行（OCR 可能未按渲染换行拆分）
  const firstLine = (block.text.split("\n").find((l) => l.trim().length > 0) ?? block.text).trim();
  const text = firstLine.slice(0, MAX_TEXT_CHARS);
  if (text.length < 2) return null;

  // 6) 候选匹配 —— 分两步：
  //    a) 对每个 (family, size)：先用「笔画宽度接近度」定字重（regular/bold 谁的中位数更接近
  //       扫描），再用该字重的 Jaccard 作为该 (family,size) 得分 → 选 family + size。
  //    b) 候选族只留度量不同的（Arial 与 Helvetica 字形度量相同，去掉 Helvetica 避免两个族
  //       得分几乎相等导致 gap 误拒）。
  // 血泪教训：不能直接对 7 个候选（含 regular/bold）比 Jaccard 选 family —— 扫描模糊下
  //   Jaccard 有系统性加粗偏差（粗体笔画更粗更贴合模糊像素），且噪声会让错误族（如 Georgia）
  //   得分反超 Arial（实测 Georgia bold@50=0.267 > Arial bold@58=0.241）。必须先按笔画宽度
  //   把字重钉死，再在「同一笔画宽度」下比 Jaccard 形状。
  const sizes = [fontSize * 0.85, fontSize * 1.0, fontSize * 1.15];
  const scanMedian = medianRunLength(scan, iw, ih);

  // 渲染候选文本，返回 { jac, median }（jac 为该候选与扫描的最大 Jaccard；median 为该字号下笔画宽度中位数）
  const renderMatch = (family: string, weight: number, size: number): { jac: number; median: number } | null => {
    const cw = Math.max(iw + 24, Math.ceil(text.length * size * 0.7) + 24);
    const ch = ih + 8;
    const cvs = document.createElement("canvas");
    cvs.width = cw;
    cvs.height = ch;
    const cctx = cvs.getContext("2d")!;
    cctx.fillStyle = "#fff";
    cctx.fillRect(0, 0, cw, ch);
    cctx.fillStyle = "#000";
    cctx.font = `${weight} ${Math.max(6, Math.round(size))}px "${family}"`;
    cctx.textBaseline = "top";
    cctx.textAlign = "left";
    cctx.fillText(text, 0, 0);
    const cimg = cctx.getImageData(0, 0, cw, ch);
    // 右裁剪：扫描只比较到候选文本墨迹右缘（OCR 文本常比渲染首行长/短）
    const candRight = inkRightEdge(cimg.data, cw, ch);
    if (candRight < 0) return null;
    const effW = Math.min(iw, candRight + 1);
    if (effW < 20) return null;
    let jac = 0;
    for (let off = -8; off <= 8; off++) {
      const s = jaccard(scan, iw, ih, cimg.data, cw, off, 2, effW);
      if (s > jac) jac = s;
    }
    const cbin = new Uint8Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) {
      const px = i * 4;
      cbin[i] =
        cimg.data[px] * 0.299 + cimg.data[px + 1] * 0.587 + cimg.data[px + 2] * 0.114 < 128 ? 1 : 0;
    }
    return { jac, median: medianRunLength(cbin, cw, ch) };
  };

  const famScores: Array<{ family: string; jac: number; weight: number }> = [];
  for (const fam of FAMILY_CANDIDATES) {
    let best: { jac: number; weight: number } | null = null;
    for (const size of sizes) {
      const reg = renderMatch(fam.family, 400, size);
      const bold = renderMatch(fam.family, 700, size);
      // 该字号下选字重：笔画宽度（median run）更接近扫描者胜
      let jac = 0;
      let weight = 400;
      if (reg && bold) {
        const dReg = Math.abs(scanMedian - reg.median);
        const dBold = Math.abs(scanMedian - bold.median);
        if (dBold < dReg) { jac = bold.jac; weight = 700; }
        else { jac = reg.jac; weight = 400; }
      } else if (reg) { jac = reg.jac; weight = 400; }
      else if (bold) { jac = bold.jac; weight = 700; }
      if (!best || jac > best.jac) best = { jac, weight };
    }
    if (best && best.jac > 0) famScores.push({ family: fam.family, ...best });
  }
  famScores.sort((a, b) => b.jac - a.jac);
  const bestFam = famScores[0];
  const secondFam = famScores[1];

  // 7) 置信度门槛：绝对得分 + 与次优候选族差距，避免短/噪文本把无关字体（如 Georgia）误判为最佳。
  if (!bestFam || !secondFam || bestFam.jac < 0.06 || bestFam.jac - secondFam.jac < 0.015) {
    return null;
  }

  return {
    fontFamily: bestFam.family,
    fontWeight: bestFam.weight,
    confidence: bestFam.jac,
  };
}

/**
 * 从已渲染页面 canvas 检测所有 OCR block 的字体。
 *
 * @param canvas pdf.js 渲染后的页面 canvas（scale=1.5，与 OCR block 同空间）
 * @param blocks OCR blocks（id/x/y/w/h/text/fontSize，scale=1.5）
 * @returns per-block 检测结果 + dominant 多数投票字体
 */
export function detectFontsFromCanvas(
  canvas: HTMLCanvasElement,
  blocks: FontDetectionBlock[]
): FontDetectionResult {
  const byBlock = new Map<string, DetectedFont>();
  const matched: DetectedFont[] = [];
  const limited = blocks.slice(0, MAX_BLOCKS);
  for (const b of limited) {
    try {
      const d = detectBlockFont(canvas, b);
      if (d) {
        byBlock.set(b.id, d);
        matched.push(d);
      }
    } catch {
      // 单块失败不影响整体
    }
  }

  // 多数投票（同 family+weight 聚合，按票数 + 平均置信度排序）
  let dominant: DetectedFont | null = null;
  if (matched.length > 0) {
    const groups = new Map<string, { family: string; weight: number; count: number; conf: number }>();
    for (const d of matched) {
      const key = `${d.fontFamily}|${d.fontWeight}`;
      const g = groups.get(key);
      if (g) { g.count++; g.conf += d.confidence; }
      else groups.set(key, { family: d.fontFamily, weight: d.fontWeight, count: 1, conf: d.confidence });
    }
    let bestKey = "";
    for (const [key, g] of groups) {
      if (!bestKey) { bestKey = key; continue; }
      const cur = groups.get(bestKey)!;
      const curScore = cur.count + cur.conf / cur.count;
      const nextScore = g.count + g.conf / g.count;
      if (nextScore > curScore) bestKey = key;
    }
    const g = groups.get(bestKey)!;
    dominant = { fontFamily: g.family, fontWeight: g.weight, confidence: g.conf / g.count };
  }

  return { byBlock, dominant };
}

/**
 * 便捷函数：仅返回 dominant 字体（单字体扫描件的场景）。
 */
export function detectDominantFont(
  canvas: HTMLCanvasElement,
  blocks: FontDetectionBlock[]
): DetectedFont | null {
  return detectFontsFromCanvas(canvas, blocks).dominant;
}

// 导出类型别名，方便消费方只依赖本模块
export type { BBox };
