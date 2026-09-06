/**
 * Sprint 31.1: Feather Mask
 *
 * 将二值 mask（0/1）转换为羽化 alpha mask（0~1）。
 *
 * 规则：
 *   - 中心（远离边缘的 mask 像素）：alpha = 1.0（完全替换为背景色）
 *   - 边缘（靠近非 mask 的 mask 像素）：alpha = 0.3 ~ 1.0（渐入过渡）
 *   - 非 mask 像素：alpha = 0（保留原像素）
 *
 * 算法：
 *   - City-block (Manhattan) 距离变换（2-pass）
 *   - 计算每个 mask 像素到最近非 mask 像素的距离
 *   - 将距离映射为 alpha 值
 *
 * 输入:
 *   mask: Uint8Array[]  (h rows, each w long, 1=erase, 0=keep)
 *
 * 输出:
 *   alpha: Float32Array[] (h rows, each w long, 0~1)
 */

/** 羽化半径（像素），边缘过渡带的宽度 */
const FEATHER_RADIUS = 3;

/** 最小 alpha 值（最边缘处） */
const MIN_ALPHA = 0.3;

/**
 * 从二值 mask 创建羽化 alpha mask。
 *
 * @param mask          - 二值 mask（1 = 需擦除，0 = 保留）
 * @param featherRadius - 羽化半径，默认 3px
 * @param minAlpha      - 最小 alpha，默认 0.3
 * @returns alpha mask（每个像素 0~1 的浮点值）
 */
export function createFeatherMask(
  mask: Uint8Array[],
  featherRadius: number = FEATHER_RADIUS,
  minAlpha: number = MIN_ALPHA,
): Float32Array[] {
  const h = mask.length;
  if (h === 0) return [];
  const w = mask[0].length;

  // Step 1: 距离变换（city-block / Manhattan distance）
  const dist = distanceTransform(mask, w, h);

  // Step 2: 将距离映射为 alpha
  const alpha: Float32Array[] = [];
  for (let r = 0; r < h; r++) {
    const row = new Float32Array(w);
    for (let c = 0; c < w; c++) {
      if (mask[r][c] === 0) {
        // 非 mask 像素 → alpha = 0（完全保留原像素）
        row[c] = 0;
      } else {
        // mask 像素 → 根据到边缘的距离计算 alpha
        // distance 0 = 边缘像素（紧邻非 mask） → alpha = minAlpha
        // distance >= featherRadius → alpha = 1.0
        // 中间线性插值
        const d = dist[r][c];
        if (d >= featherRadius) {
          row[c] = 1.0;
        } else {
          row[c] = minAlpha + (1.0 - minAlpha) * (d / featherRadius);
        }
      }
    }
    alpha.push(row);
  }

  return alpha;
}

/**
 * City-block (Manhattan) 距离变换（2-pass）。
 *
 * 对于 mask[r][c] == 1 的像素，计算到最近 mask[r'][c'] == 0 的距离。
 *
 * Forward pass（左上 → 右下）:
 *   dist[r][c] = min(dist[r][c], 1 + dist[r-1][c], 1 + dist[r][c-1])
 *
 * Backward pass（右下 → 左上）:
 *   dist[r][c] = min(dist[r][c], 1 + dist[r+1][c], 1 + dist[r][c+1])
 *
 * @returns dist[r][c]: mask=1 像素到最近非 mask 像素的距离
 */
function distanceTransform(
  mask: Uint8Array[],
  w: number,
  h: number,
): Float32Array[] {
  const INF = w + h + 1;

  // 初始化
  const dist: Float32Array[] = [];
  for (let r = 0; r < h; r++) {
    const row = new Float32Array(w);
    for (let c = 0; c < w; c++) {
      row[c] = mask[r][c] === 0 ? 0 : INF;
    }
    dist.push(row);
  }

  // Forward pass: top-left → bottom-right
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (mask[r][c] === 0) continue;
      if (r > 0) dist[r][c] = Math.min(dist[r][c], 1 + dist[r - 1][c]);
      if (c > 0) dist[r][c] = Math.min(dist[r][c], 1 + dist[r][c - 1]);
    }
  }

  // Backward pass: bottom-right → top-left
  for (let r = h - 1; r >= 0; r--) {
    for (let c = w - 1; c >= 0; c--) {
      if (mask[r][c] === 0) continue;
      if (r + 1 < h) dist[r][c] = Math.min(dist[r][c], 1 + dist[r + 1][c]);
      if (c + 1 < w) dist[r][c] = Math.min(dist[r][c], 1 + dist[r][c + 1]);
    }
  }

  return dist;
}
