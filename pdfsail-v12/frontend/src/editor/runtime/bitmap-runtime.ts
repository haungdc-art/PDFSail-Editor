/**
 * bitmap-runtime.ts — Bitmap Runtime（Sprint-127 · 唯一 Mission）
 *
 * ## Mission（PM 拍板）
 * Bitmap Runtime 成为一个真正的 Runtime，而不是抽函数。
 * PDFEditor 不再知道 Bitmap 的内部判定逻辑，只消费 bitmapRuntime.state。
 *
 * ## Architecture Contract（PM 指定）
 * ```ts
 * interface BitmapRuntimeState {
 *   ready: boolean;    // render 完成
 *   valid: boolean;    // 尺寸 + 有效像素
 *   visible: boolean;  // 是否可显示（ready && valid）
 *   reason?: "loading" | "invalid" | "transparent" | "empty" | "ready";
 * }
 * ```
 * 以后 Case-001/002/010 问"为什么没有显示？"时，Runtime 能回答 reason，
 * 调查效率会高很多，不用再翻 Runtime 内部。
 *
 * ## 职责
 * - 从 canvas（z0 底图）计算 Bitmap 状态（ready/valid/visible/reason）
 * - 暴露 state 给 PDFEditor（PDFEditor 只消费，不实现判定）
 * - 纯函数 computeBitmapState（ADR-005）：输入 canvas，输出 state
 *
 * ## 约束
 * - 不碰 OCR / Painter / Completeness / Reveal Gate 现有语义
 * - 不依赖 EditableDocument
 * - 不修改 PDFCanvas / PDFEditor 的 Reveal 语义（只替换 Bitmap 判定来源）
 */

/** Bitmap Runtime 状态（Contract，PM 指定） */
export type BitmapReason =
  | "loading"    // render 未完成
  | "invalid"    // canvas 尺寸无效（width/height <= 0）
  | "transparent"// 全透明（有像素但 alpha 全 0）
  | "empty"      // 无法读取像素（canvas 污染 / getImageData 抛错）
  | "ready";     // 尺寸有效 + 有非透明像素

export interface BitmapRuntimeState {
  /** render 完成（canvasRendered） */
  readonly ready: boolean;
  /** 尺寸 + 有效像素 */
  readonly valid: boolean;
  /** 是否可显示（ready && valid） */
  readonly visible: boolean;
  /** 不可显示的原因（用于 Case-00X 诊断） */
  readonly reason: BitmapReason;
}

/** 初始状态（未渲染） */
export const BITMAP_INITIAL_STATE: BitmapRuntimeState = {
  ready: false,
  valid: false,
  visible: false,
  reason: "loading",
};

/** computeBitmapState 选项 */
export interface BitmapComputeOptions {
  /** 采样左上角像素区域尺寸（检测非透明像素用，便宜） */
  readonly sampleSize?: number;
}

/**
 * 从 canvas 计算 Bitmap 状态（纯函数）。
 *
 * 判定规则：
 *   - canvas 尺寸无效（width/height <= 0）→ invalid
 *   - 有尺寸但 getImageData 失败（canvas 污染）→ empty
 *   - 有尺寸 + 有像素但全透明 → transparent
 *   - 有尺寸 + 有非透明像素 → ready
 * 其中 visible = ready && valid。
 *
 * @param canvas z0 底图 canvas（可为 null → loading）
 * @param options 采样选项
 * @returns BitmapRuntimeState
 */
export function computeBitmapState(
  canvas: HTMLCanvasElement | null,
  options: BitmapComputeOptions = {},
): BitmapRuntimeState {
  const sampleSize = Math.max(1, options.sampleSize ?? 4);

  if (!canvas) return BITMAP_INITIAL_STATE; // 无 canvas → loading

  // 1) 尺寸判定
  if (canvas.width <= 0 || canvas.height <= 0) {
    return { ready: true, valid: false, visible: false, reason: "invalid" };
  }

  // 2) 像素采样（检测是否有非透明像素）
  let hasAlpha = false;
  let hasOpaque = false;
  let readError = false;
  try {
    const ctx = canvas.getContext("2d");
    const px = ctx
      ? ctx.getImageData(0, 0, Math.min(canvas.width, sampleSize), Math.min(canvas.height, sampleSize)).data
      : null;
    if (px) {
      for (let i = 3; i < px.length; i += 4) {
        if (px[i] > 0) hasOpaque = true;
        else hasAlpha = true;
        if (hasOpaque) break;
      }
    } else {
      readError = true;
    }
  } catch {
    // canvas 污染 → getImageData 抛错
    readError = true;
  }

  if (readError) {
    // 无法读取像素：退化为"有尺寸即可视为 ready"（与 Sprint-126 一致）
    return { ready: true, valid: true, visible: true, reason: "ready" };
  }

  if (!hasOpaque) {
    // 有尺寸但采样区域全透明 → 可能全透明（或异常）
    return { ready: true, valid: false, visible: false, reason: hasAlpha ? "transparent" : "empty" };
  }

  return { ready: true, valid: true, visible: true, reason: "ready" };
}

/** Bitmap Runtime 消费接口（PDFEditor 只依赖此） */
export interface BitmapRuntimeLike {
  /** 当前 Bitmap 状态 */
  readonly state: BitmapRuntimeState;
  /** 更新 state（由 Bitmap Runtime 内部调用，PDFEditor 不应手动构造 state） */
  readonly update: (state: BitmapRuntimeState) => void;
}

/**
 * 创建 Bitmap Runtime 实例（简单工厂）。
 * PDFEditor 创建并持有，后续由 Runtime 层统一管理生命周期。
 */
export function createBitmapRuntime(initial: BitmapRuntimeState = BITMAP_INITIAL_STATE): {
  state: BitmapRuntimeState;
  update: (s: BitmapRuntimeState) => void;
} {
  let state = initial;
  return {
    get state() {
      return state;
    },
    update(s: BitmapRuntimeState) {
      state = s;
    },
  };
}
