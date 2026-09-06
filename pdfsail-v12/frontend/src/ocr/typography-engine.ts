/**
 * typography-engine.ts — Epic B：Typography Engine（重写 Font Size 模型）
 *
 * 正确顺序（从 OCR Block 到 Paragraph → Line → Font Size → Baseline）：
 *   1. Paragraph Builder：OCR region → Paragraph 聚类
 *   2. Line Detector：从位图像素检测真实文字行（不依赖 GLM-OCR 的 content/bbox）
 *   3. Font Size Estimator：从每行实际文字像素高度推断字号（废弃 fontSize = bboxH × 系数）
 *   4. Baseline Engine：每行独立计算 baseline
 *
 * 核心原则：
 *   - GLM-OCR block 是 Region，不是 Paragraph，更不是 Line
 *   - Line 必须从原始位图检测，不能靠 content 换行符
 *   - Font Size 从"真实文字像素高度"推断，不用 bbox 高度猜
 */

export interface TypoLine {
  y0: number;   // 行上边界（像素）
  y1: number;   // 行下边界（像素）
  x0: number;   // 行内首个文字像素 x
  x1: number;   // 行内最后文字像素 x
  height: number;   // 行高度（含 descender）
  capHeight: number; // 大写字母主体高度（近似文字核心像素高度）
  baseline: number;  // baseline y（行下边界附近的笔画底部）
  fontSize: number;  // 推断字号
}

export interface TypoParagraph {
  x0: number; y0: number; x1: number; y1: number;
  lines: TypoLine[];
  content: string;
}

/** 判断像素是否为暗（文字）像素 */
function isDark(px: number, data: Uint8ClampedArray): boolean {
  const g = data[px] * 0.299 + data[px + 1] * 0.587 + data[px + 2] * 0.114;
  return g < 128;
}

/**
 * Line Detector：从位图检测一个 region 内的真实文字行。
 * 用水平投影（每 y 的暗像素计数）找连续的暗像素带。
 *
 * @param data 位图 RGBA
 * @param w 位图宽
 * @param region 区域 {x0,y0,x1,y1}
 */
export function detectLines(
  data: Uint8ClampedArray,
  w: number,
  region: { x0: number; y0: number; x1: number; y1: number },
): TypoLine[] {
  const { x0, y0, x1, y1 } = region;
  const h = y1 - y0;

  // 水平投影：每 y 的暗像素数
  const proj = new Array<number>(h).fill(0);
  for (let y = y0; y < y1; y++) {
    let cnt = 0;
    for (let x = x0; x < x1; x++) {
      const px = (y * w + x) * 4;
      if (isDark(px, data)) cnt++;
    }
    proj[y - y0] = cnt;
  }

  // 阈值：区域最大暗像素计数的 5%，用于判定文字行
  const maxProj = Math.max(...proj);
  const threshold = Math.max(2, maxProj * 0.05);

  // 找连续暗像素带（行）
  const bands: Array<[number, number]> = []; // [y0, y1]
  let inBand = false, bandStart = 0;
  for (let i = 0; i < h; i++) {
    const dark = proj[i] >= threshold;
    if (dark && !inBand) { inBand = true; bandStart = i; }
    else if (!dark && inBand) {
      inBand = false;
      if (i - bandStart >= 3) bands.push([bandStart, i]); // 至少 3px 高才算文字行
    }
  }
  if (inBand) bands.push([bandStart, h]);

  // 合并间隙 < 2px 的带（抗噪）；丢弃高度 < 4px 的噪声带
  const merged: Array<[number, number]> = [];
  for (const b of bands) {
    if (b[1] - b[0] < 4) continue; // 丢弃噪声带（如 descender 残留）
    if (merged.length > 0 && b[0] - merged[merged.length - 1][1] < 3) {
      merged[merged.length - 1][1] = b[1];
    } else merged.push([...b]);
  }

  return merged.map(([by0, by1]) => {
    const absY0 = y0 + by0, absY1 = y0 + by1;
    // 该行内文字像素的 x 范围 + 垂直分布
    let minX = Infinity, maxX = -Infinity;
    const rowCount = new Array<number>(by1 - by0).fill(0);
    for (let y = absY0; y < absY1; y++) {
      let rc = 0;
      for (let x = x0; x < x1; x++) {
        const px = (y * w + x) * 4;
        if (isDark(px, data)) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          rc++;
        }
      }
      rowCount[y - absY0] = rc;
    }
    // 主体核心区：去掉顶部/底部稀疏行（ascender/descender 残留）
    const totalRows = by1 - by0;
    const coreStart = Math.floor(totalRows * 0.08);
    const coreEnd = totalRows - Math.floor(totalRows * 0.18);
    let coreMaxRow = 0;
    for (let i = coreStart; i < coreEnd; i++) if (rowCount[i] > coreMaxRow) coreMaxRow = rowCount[i];

    // baseline：找行下部暗像素最多的 y（笔画底部，含 descender 前）
    let baseline = absY0 + Math.floor(totalRows * 0.85);
    for (let i = Math.floor(totalRows * 0.55); i < totalRows; i++) {
      if (rowCount[i] > rowCount[baseline - absY0]) baseline = absY0 + i;
    }

    // capHeight：文字主体像素高（暗像素核心垂直跨度）
    let capHeight = 0;
    for (let i = coreStart; i < coreEnd; i++) if (rowCount[i] >= coreMaxRow * 0.35) capHeight++;

    const lineHeight = by1 - by0;
    // Font Size：从检测到的真实行高推断。
    // 物理测量：PDF 的 fontSize(em) → canvas 视觉行高的关系 ≈ 行高 × 1.3（行高 = em × 0.77）。
    // 因此要渲染出"检测行高"，fontSize ≈ lineHeight / 0.77 ≈ lineHeight × 1.3。
    // 这是像素检测反推，不是用 OCR block bbox 高度猜（废弃 fontSize = bboxH × 系数）。
    const fontSize = lineHeight / 0.77;
    return {
      y0: absY0, y1: absY1,
      x0: minX === Infinity ? x0 : minX,
      x1: maxX === -Infinity ? x1 : maxX,
      height: lineHeight,
      capHeight,
      baseline,
      fontSize: +fontSize.toFixed(1),
    };
  });
}

/**
 * Paragraph Builder：把多个 OCR text region 聚合成 Paragraph。
 * 简单实现：每个 region 本身作为一个 paragraph（保持稳定），
 * 但用 detectLines 正确拆出行。
 */
export function buildParagraphs(
  regions: Array<{ x0: number; y0: number; x1: number; y1: number; content: string }>,
  data: Uint8ClampedArray,
  w: number,
): TypoParagraph[] {
  return regions.map((r) => {
    const lines = detectLines(data, w, { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 });
    // 合并所有行边界为 paragraph bbox
    const x0 = Math.min(r.x0, ...lines.map((l) => l.x0));
    const x1 = Math.max(r.x1, ...lines.map((l) => l.x1));
    const y0 = lines.length ? Math.min(...lines.map((l) => l.y0)) : r.y0;
    const y1 = lines.length ? Math.max(...lines.map((l) => l.y1)) : r.y1;
    return { x0, y0, x1, y1, lines, content: r.content };
  });
}
