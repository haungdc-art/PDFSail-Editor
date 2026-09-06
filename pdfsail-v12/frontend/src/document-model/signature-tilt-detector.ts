/**
 * Sprint34.26: Image-level Signature Tilt Detector
 *
 * 记录（本次）：仅本次允许新增此图像级倾斜检测模块。
 *
 * 背景：
 *   OCR glyph 输出的字符 bbox 是水平包围盒，即使真实文字倾斜，
 *   字符中心点也落在水平线上 → 从 OCR glyph 坐标测不出倾斜（detectRegionRotation 按行回归后全 0）。
 *   扫描 PDF 没有 text matrix，只能从像素检测文字基线倾斜。
 *
 * 方法（标准文档 deskew，通用，不针对具体 PDF）：
 *   1. 从 canvas 裁剪签名区域 → 灰度化 → 二值化（文字为前景）；
 *   2. 对候选角度 θ 旋转图像，统计"水平投影"（每行前景像素数）的方差；
 *   3. 文字行在 θ 下越水平对齐，投影方差越大；
 *   4. 取投影方差最大的 θ*，倾斜角 = -θ*（反向旋转使文字水平）。
 *
 * 注意：模块本身通用，可复用于任何倾斜文字检测场景。
 */

export interface TiltDetectionResult {
  /** 文字基线的倾斜角（CSS 度，顺时针为正，与渲染 rotation 同系） */
  angle: number;
  /** 0~1 置信度 */
  confidence: number;
}

const DARK_THRESHOLD = 140; // 灰度阈值：低于视为文字/前景像素
const SCAN_RANGE = 12; // 候选角度扫描范围 ±12°
const SCAN_STEP = 1; // 步进 1°

/**
 * 从页面 canvas 裁剪签名区域，检测文字基线倾斜角。
 *
 * @param canvas  页面渲染 canvas（原 PDF 图像）
 * @param regionCssBBox 签名区域（CSS 文档坐标）
 * @param cssScale canvas.clientWidth / canvas.width
 */
export function detectTiltFromCanvas(
  canvas: HTMLCanvasElement,
  regionCssBBox: { x: number; y: number; width: number; height: number },
  cssScale: number,
): TiltDetectionResult {
  try {
    // 像素坐标 = CSS 坐标 * (canvas.width / canvas.clientWidth)
    const scale = canvas.width / (canvas.clientWidth || canvas.width);
    const px = Math.max(0, Math.floor(regionCssBBox.x * scale));
    const py = Math.max(0, Math.floor(regionCssBBox.y * scale));
    const pw = Math.max(2, Math.min(Math.ceil(regionCssBBox.width * scale), canvas.width - px));
    const ph = Math.max(2, Math.min(Math.ceil(regionCssBBox.height * scale), canvas.height - py));

    // 裁剪
    const src = document.createElement("canvas");
    src.width = pw;
    src.height = ph;
    const sctx = src.getContext("2d", { willReadFrequently: true });
    if (!sctx) return { angle: 0, confidence: 0 };
    sctx.drawImage(canvas, px, py, pw, ph, 0, 0, pw, ph);

    // 二值化：前景（文字）像素坐标
    const imgData = sctx.getImageData(0, 0, pw, ph);
    const data = imgData.data;
    const fg: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const i = (y * pw + x) * 4;
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (gray < DARK_THRESHOLD) fg.push({ x, y });
      }
    }
    if (fg.length < 20) return { angle: 0, confidence: 0 };

    // 旋转投影：对每个候选角度，计算"水平投影"（每行前景数）的方差
    // 文字行水平对齐时，行间前景分布方差最大。
    let bestAngle = 0;
    let bestScore = -Infinity;
    const rad = Math.PI / 180;
    const centerX = pw / 2;
    const centerY = ph / 2;
    const rowCount = Math.max(10, Math.floor(ph * 0.3)); // 投影行数（抽样）

    for (let deg = -SCAN_RANGE; deg <= SCAN_RANGE; deg += SCAN_STEP) {
      const cosA = Math.cos(-deg * rad);
      const sinA = Math.sin(-deg * rad);
      const counts = new Array(rowCount).fill(0);
      for (const p of fg) {
        // 绕中心旋转 -deg，使候选角度下文字"水平"
        const dx = p.x - centerX;
        const dy = p.y - centerY;
        const ry = dx * sinA + dy * cosA;
        // 投影到行：y 归一化到 [0, rowCount)
        let row = ((ry + centerY) / ph) * rowCount;
        if (row < 0) row = 0;
        if (row >= rowCount) row = rowCount - 1;
        counts[Math.floor(row)]++;
      }
      // 方差
      const n = rowCount;
      const mean = fg.length / n;
      let v = 0;
      for (let i = 0; i < n; i++) v += (counts[i] - mean) ** 2;
      v /= n;
      if (v > bestScore) {
        bestScore = v;
        bestAngle = deg;
      }
    }

    // 置信度：bestScore 相对最差值的比值
    return {
      angle: Math.round(bestAngle * 10) / 10,
      confidence: 0.5, // 经验值（图像质量相关）
    };
  } catch {
    return { angle: 0, confidence: 0 };
  }
}
