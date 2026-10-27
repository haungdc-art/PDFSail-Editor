/**
 * F3B-6.28-M（D2″ 第二阶段）—— 统一 ink 校正：纯几何 + 像素适配器分离
 *
 * 背景（D2′ 调查结论）：
 *   · Core-owned 流程中 box 的**唯一活跃写入者** = applyReconciliationToRenderState
 *     （模型几何 reconciliationRenderBox，无 ink 信息）⇒ mask 顶 = 字符定位框顶，
 *     字形墨迹上伸（CJK 5.02px / 西文 3.14px 实测）从未计入 ⇒ 清空/redo 后行空白残留；
 *   · markLineEdited 的 T2 ink 扫描在 Core-owned 路径不可达（清空场景 firstBaseline
 *     undefined 跳过；替换/redo 被 reconciliation upsert 覆盖）。
 *
 * 职责分离（用户裁决 §2.A）：
 *   · `correctBoxWithInkRows` —— **纯几何**：输入候选框 + 墨迹行扫描 + 邻行边界，
 *     输出校正后 box 或 fail-closed（不读 DOM/canvas/ref）；
 *   · `scanInkRowsForRange` —— **像素适配器**：接受显式 canvas 参数，负责
 *     CSS/backing 坐标换算与行扫描（无 React 耦合）。
 *
 * 语义（镜像 markLineEdited T2 现行为，逐条对应）：
 *   · rawInkTop/Bottom = 扫描区首/末 ink 行的 CSS 坐标；
 *   · inkTop = max(rawInkTop, topBoundary)；inkBottom = min(rawInkBottom, bottomBoundary)；
 *   · 无 ink 行 / inkBottom ≤ inkTop（退化）⇒ **fail-closed 返回候选框**（不猜、不扩）；
 *   · corrected = 相对候选框是否发生 y/height 变化。
 *
 * 重复写入规则（用户裁决 §2.C）：调用方**每次都从模型候选框重新计算**（候选框由
 * reconciliation 每次从模型几何重建，天然不携带上次校正结果）⇒ 不会累积扩张。
 */
import type { BBox } from "../../document-model/types";

export interface InkRowScan {
  /** backing-store 行序的 ink 有无（索引 0 = 扫描区首行） */
  inkRows: boolean[];
  /** 扫描区首行的 backing-store y */
  scanTopBacking: number;
  /** CSS px = backing px × cssScale（> 0） */
  cssScale: number;
}

export interface InkCorrectionBoundaries {
  /** 上一行保护边界（与候选框同空间的 CSS y）；缺省 ⇒ 上沿不钳制 */
  topBoundary?: number;
  /** 下一行保护边界；缺省 ⇒ 下沿不钳制 */
  bottomBoundary?: number;
}

export interface InkCorrectedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InkCorrectionResult {
  box: InkCorrectedBox;
  /** true = 墨迹扫描改变了候选框 */
  corrected: boolean;
  /** fail-closed 原因（corrected=false 时的可观测诊断） */
  reason?: "no-ink" | "degenerate-range" | "out-of-clamp";
}

export function correctBoxWithInkRows(
  candidate: InkCorrectedBox,
  scan: InkRowScan,
  boundaries: InkCorrectionBoundaries = {},
): InkCorrectionResult {
  const first = scan.inkRows.findIndex(Boolean);
  if (first < 0) {
    return { box: candidate, corrected: false, reason: "no-ink" };
  }
  let last = scan.inkRows.length - 1;
  while (last >= 0 && !scan.inkRows[last]) last -= 1;

  const rawInkTop = (scan.scanTopBacking + first) * scan.cssScale;
  const rawInkBottom = (scan.scanTopBacking + last + 1) * scan.cssScale;
  const inkTop = boundaries.topBoundary !== undefined ? Math.max(rawInkTop, boundaries.topBoundary) : rawInkTop;
  const inkBottom =
    boundaries.bottomBoundary !== undefined ? Math.min(rawInkBottom, boundaries.bottomBoundary) : rawInkBottom;
  if (!(inkBottom > inkTop)) {
    return { box: candidate, corrected: false, reason: "degenerate-range" };
  }
  const height = inkBottom - inkTop;
  if (inkTop === candidate.y && height === candidate.height) {
    return { box: candidate, corrected: false };
  }
  return {
    box: { x: candidate.x, y: inkTop, width: candidate.width, height },
    corrected: true,
  };
}

/**
 * 像素适配器：在 canvas 上扫描 [topCss, bottomCss) × [leftCss, leftCss+widthCss) 的
 * 行级墨迹分布（阈值与 markLineEdited T2 一致：<240 任一通道）。
 * canvas 不可用 / 范围退化 ⇒ null（调用方 fail-closed 保留候选框）。
 */
export function scanInkRowsForRange(
  canvas: HTMLCanvasElement | null | undefined,
  range: { leftCss: number; topCss: number; bottomCss: number; widthCss: number },
): InkRowScan | null {
  if (!canvas) return null;
  const cssScale = canvas.clientWidth > 0 && canvas.width > 0 ? canvas.clientWidth / canvas.width : 0;
  if (!(cssScale > 0)) return null;
  const left = Math.max(0, Math.floor(range.leftCss / cssScale));
  const top = Math.max(0, Math.floor(range.topCss / cssScale));
  const bottom = Math.min(canvas.height, Math.ceil(range.bottomCss / cssScale));
  const width = Math.min(canvas.width - left, Math.ceil(range.widthCss / cssScale));
  const height = bottom - top;
  if (height <= 0 || width <= 0) return null;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const data = ctx.getImageData(left, top, width, height).data;
  const inkRows: boolean[] = [];
  for (let row = 0; row < height; row++) {
    let hasInk = false;
    for (let col = 0; col < width; col++) {
      const px = (row * width + col) * 4;
      if (data[px] < 240 || data[px + 1] < 240 || data[px + 2] < 240) {
        hasInk = true;
        break;
      }
    }
    inkRows.push(hasInk);
  }
  return { inkRows, scanTopBacking: top, cssScale };
}
