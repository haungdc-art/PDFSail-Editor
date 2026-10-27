/**
 * 压缩引擎的纯规则层（零依赖：无 pdfjs、无 DOM）。
 *
 * 抽出的原因：`clientCompress.ts` 在模块顶层要设置 pdf.js 的 GlobalWorkerOptions，
 * 并 import 带 `?url` 后缀的 Vite worker 资源 ⇒ Node/tsx 无法加载该模块。
 * 把输入归一化与「是否有收益」的判定放到这里，行为契约才是可被单测覆盖的。
 */

export type CompressMode = "stage1_lib" | "stage2_raster" | "fallback";

/** Stage 2 输出相对原文件的容忍阈值：>10% 视为本次压缩没有收益 */
export const STAGE2_SIZE_TOLERANCE = 1.1;

/**
 * 输入归一化 —— 必须按 Uint8Array 的**视图范围**取字节。
 *
 * 直接取 `view.buffer` 会把底层整个 backing buffer（含视图之外的字节）交给 PDF 解析器，
 * 对 `new Uint8Array(backing, offset, length)` 这类子视图会造成解析错误或夹带无关数据。
 */
export async function toPdfBytes(
  input: File | Uint8Array | ArrayBuffer
): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input.slice();
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input && typeof (input as Blob).arrayBuffer === "function") {
    return new Uint8Array(await (input as Blob).arrayBuffer());
  }
  throw new TypeError("[compress] unsupported input type");
}

export type Stage2Outcome = "publish" | "fallback";

/**
 * Stage 2（Canvas 光栅化）产物是否有收益。
 * `fallback` = 未能进一步压缩 ⇒ 走「保留原文件」的有效 fallback，不是失败。
 */
export function decideStage2Outcome(
  originalSize: number,
  stage2Size: number
): Stage2Outcome {
  if (originalSize <= 0) return "publish";
  return stage2Size / originalSize > STAGE2_SIZE_TOLERANCE ? "fallback" : "publish";
}
