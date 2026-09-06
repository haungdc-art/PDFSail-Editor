/**
 * Sprint 31.1: Background Reconstructor Module
 *
 * Local Background Reconstruction + Feather Mask pipeline。
 * 替换旧的 white-fill / inpaintTextPixels，变成自然的局部背景羽化混合。
 */

export { estimateBackground, estimateBackgroundsForBboxes } from "./LocalBackgroundEstimator";
export type { LocalBackground, BackgroundEstimate } from "./LocalBackgroundEstimator";

export { createFeatherMask } from "./FeatherMask";

export { localInpaint } from "./LocalInpaint";
