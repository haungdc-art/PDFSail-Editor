/**
 * SignatureBackgroundReconstructor — Sprint 19
 *
 * Adobe 风格的签名区域背景重建器。
 *
 * 与 Sprint 18 像素 mask 的关键区别：
 *   Sprint 18: 为每个文字像素段生成独立 DrawRectCommand → 3685 commands
 *   Sprint 19: 在 canvas 上直接修复图像，输出单张 DrawImageCommand（1 command per region）
 *
 * 算法：
 *   1. 从 page canvas 裁剪签名区域 → ImageData
 *   2. 按行扫描，灰度阈值检测暗像素
 *   3. 水平游程分类：短 → 文字（需擦除），长 → 横线（保留）
 *   4. 水平插值修复：对文字像素段，用左右最近背景像素颜色填充
 *   5. 旋转检测：PCA / 线性回归分析手写 block glyph 位置 → 基线角度
 *   6. 输出：单张清理后的背景图像 data URL
 *
 * 渲染顺序：Image (z=0) → BackgroundPatch (z=1) → EditableGlyph (z=2)
 */

import type { SignatureReplacement } from "./signature-replacement-model";
import type { SignatureRegion } from "./signature-region-merger";
import type { SignatureCompositeRegion } from "./signature-composite-region";
import type { BBox } from "./types";
// Sprint 30: OCR mask generator
import { generateOCRMask, generateEnhancedOCRMask, generateMaskFromBboxes, type OCRMaskBlockDebug } from "./signature-ocr-mask-generator";
// Sprint 31: Sub-region segmentation
import { segmentSignatureRegion, classifySegments, isSprint31Enabled } from "./signature-region-segmenter";
import type { SignatureRegionSegmentDebug, SignatureClassificationDebug } from "./signature-sub-region";
// Sprint 31.1: Local Background Reconstruction + Feather Mask
import { estimateBackgroundsForBboxes, type LocalBackground } from "./background-reconstructor/LocalBackgroundEstimator";
import { createFeatherMask } from "./background-reconstructor/FeatherMask";
import { localInpaint } from "./background-reconstructor/LocalInpaint";
// Sprint34.26（记录，仅本次）：图像级倾斜检测
import { detectTiltFromCanvas } from "./signature-tilt-detector";

// ────────────────────────────────────────────────────────────
// 工具函数
// ────────────────────────────────────────────────────────────

/** 计算多个 bbox 的并集 */
function unionBBox(bboxes: BBox[]): BBox {
  if (bboxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of bboxes) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// ────────────────────────────────────────────────────────────
// 配置常量
// ────────────────────────────────────────────────────────────

/** 灰度阈值：低于此值视为 "暗像素" */
const DARK_THRESHOLD = 140;

/** 水平游程 ≥ 此值（canvas px）视为 "横线"（保留），否则为 "文字"（擦除） */
const LINE_RUN_LENGTH = 50;

/** 遍历非暗像素时的最大搜索距离（canvas px），超出则使用边缘采样估算 */
const MAX_NEARBY_SEARCH = 80;

// ────────────────────────────────────────────────────────────
// 调试类型
// ────────────────────────────────────────────────────────────

export interface BackgroundReconstructorDebug {
  region: { x: number; y: number; w: number; h: number };
  zoneCanvasPx: { x: number; y: number; w: number; h: number };
  darkPixelCount: number;
  textPixelCount: number;
  linePixelCount: number;
  backgroundRgb: [number, number, number];
  maskRectsEstimate: number;
  rotationAngle: number;
  rotationConfidence: number;
  reconstructionMethod: string;
  /** 清理后的背景图像预览（小尺寸缩略图 data URL） */
  patchPreviewDataURL: string | null;
}

// ────────────────────────────────────────────────────────────
// 公共 API
// ────────────────────────────────────────────────────────────

/**
 * 为所有签名区域重建背景，生成 SignatureReplacement 数组。
 *
 * @param regions - SignatureRegionMerger 检测到的签名区域
 * @param canvas - page canvas（已渲染 PDF 页面图像）
 * @param cssScale - canvas.clientWidth / canvas.width
 * @returns SignatureReplacement[] + debug 信息
 */
export function reconstructAllSignatureBackgrounds(
  regions: SignatureRegion[],
  canvas: HTMLCanvasElement,
  cssScale: number,
): {
  replacements: SignatureReplacement[];
  debug: BackgroundReconstructorDebug[];
} {
  const replacements: SignatureReplacement[] = [];
  const debug: BackgroundReconstructorDebug[] = [];

  for (const region of regions) {
    const result = reconstructOneRegion(region, canvas, cssScale);
    if (result) {
      replacements.push(result.replacement);
      debug.push(result.debug);
    }
  }

  return { replacements, debug };
}

// ────────────────────────────────────────────────────────────
// Sprint 20: 复合签名区域背景重建
// ────────────────────────────────────────────────────────────

/**
 * 为所有复合签名区域重建背景。
 *
 * 与旧版的区别:
 *   - 输入: SignatureCompositeRegion（整个复合区域）而非单个 SignatureRegion
 *   - zone: 从所有 source blocks 计算（而非仅 suppressed blocks）
 *   - 所有 duplicate blocks 的像素一起清理
 *   - rotation 从 composite region 自带
 *
 * @param compositeRegions - detectCompositeSignatureRegions 的输出
 * @param canvas - page canvas
 * @param cssScale - canvas.clientWidth / canvas.width
 */
export function reconstructCompositeRegionBackgrounds(
  compositeRegions: SignatureCompositeRegion[],
  canvas: HTMLCanvasElement,
  cssScale: number,
): {
  replacements: SignatureReplacement[];
  debug: BackgroundReconstructorDebug[];
} {
  const replacements: SignatureReplacement[] = [];
  const debug: BackgroundReconstructorDebug[] = [];

  for (const region of compositeRegions) {
    const result = reconstructCompositeRegion(region, canvas, cssScale);
    if (result) {
      replacements.push(result.replacement);
      debug.push(result.debug);
    }
  }

  return { replacements, debug };
}

function reconstructCompositeRegion(
  composite: SignatureCompositeRegion,
  canvas: HTMLCanvasElement,
  cssScale: number,
  editableDocument?: any,
): { replacement: SignatureReplacement; debug: BackgroundReconstructorDebug } | null {
  // zone: 从整个 composite bbox 计算（含 padding）
  const zone = computeCompositeZone(composite, cssScale);
  if (!zone) return null;

  // ── 入口诊断日志（无条件，所有分支都打印）──
  console.log(
    "[Sprint31.1] reconstructCompositeRegion 入口",
    JSON.stringify({
      id: composite.id,
      dupBlocks: composite.duplicateBlockIds?.length ?? 0,
      editableBlocks: composite.editableBlockIds?.length ?? 0,
      sprint31Enabled: typeof window !== "undefined" ? isSprint31Enabled() : "no-window",
      sprint30OCRMask: typeof window !== "undefined" ? !!(window as any).__sprint30_useOCRMask : "no-window",
      lsSprint30: typeof window !== "undefined" ? localStorage.getItem("__sprint30_useOCRMask") : "no-window",
      lsSprint31: typeof window !== "undefined" ? localStorage.getItem("__sprint31_enabled") : "no-window",
    }),
  );

  // Sprint 30: OCR mask 模式
  // Sprint 31 依赖 OCR mask，所以 Sprint31 on 时自动 useOCRMask=true
  // 用 localStorage 持久化，避免刷新后丢失；同时读 window.__sprint30_useOCRMask
  // 优先级: localStorage 为准（可在 console 设后 persist）
  let useOCRMask = false;
  if (typeof window !== "undefined") {
    // Sprint 31 开启时自动启用 OCR mask
    if (isSprint31Enabled()) {
      useOCRMask = true;
      console.log("[Sprint31.1] isSprint31Enabled()=true → useOCRMask=true");
    } else {
      const lsVal = localStorage.getItem("__sprint30_useOCRMask");
      const winVal = (window as any).__sprint30_useOCRMask;
      if (winVal === true && lsVal !== "true") {
        localStorage.setItem("__sprint30_useOCRMask", "true");
        useOCRMask = true;
      } else if (lsVal === "true") {
        (window as any).__sprint30_useOCRMask = true;
        useOCRMask = true;
      } else if (winVal === true) {
        useOCRMask = true;
      }
      console.log("[Sprint31.1] isSprint31Enabled()=false, useOCRMask=" + useOCRMask);
    }
  }
  if (useOCRMask) {
    console.log("[Sprint30] OCR mask 分支已命中, composite:", composite.id, "dupBlocks:", composite.duplicateBlockIds?.length ?? 0);

    // Sprint 31: 子区域分割（优先级最高，默认启用）
    const useSprint31 = isSprint31Enabled();
    if (useSprint31) {
      console.log("[Sprint31] 子区域分割模式启用");

      // Sprint 31.2: 追踪 pipeline 步骤
      const pipelineTrace: any = {
        region: composite.id,
        steps: {
          detected: true,
          segmented: false,
          maskCreated: false,
          reconstructionCreated: false,
          patchInserted: false,
          rendered: false,
        },
        layers: {
          backgroundPatch: false,
          glyphLayer: false,
          pdfCanvas: false,
        },
        startedAt: Date.now(),
      };
      try {
        const result = reconstructCompositeRegionWithSubRegions(composite, canvas, cssScale, zone);
        if (result) {
          pipelineTrace.steps.reconstructionCreated = true;
          pipelineTrace.method = result.reconstructionMethod;
        }
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[Sprint31] 子区域分割路径抛错:", msg, e);
        // Sprint 31.2: 不再回退到 classifyPixels（white-fill），直接返回 null
        // 避免白块出现
        console.warn("[Sprint31] ⚠️ 子区域分割失败，返回 null（禁止 white-fill 回退）。错误:", msg);
        return null;
      }
    }

    // Sprint30.1: 检查是否启用增强 mask（同步 localStorage，避免刷新丢失）
    const enhancedLsVal = typeof window !== "undefined" ? localStorage.getItem("__signatureUseEnhancedMask") : null;
    const useEnhanced = enhancedLsVal === "true" || ((window as any).__signatureUseEnhancedMask === true);
    if (useEnhanced) {
      // 同步到 window（万一只有 localStorage）
      (window as any).__signatureUseEnhancedMask = true;
      console.log("[Sprint30.1] 使用增强 OCR mask（expand + dilate）");
    } else {
      console.log("[Sprint30.1] 使用原始 OCR mask（无 expand/dilate）");
    }
    try {
      return useEnhanced
        ? reconstructCompositeRegionWithEnhancedOCRMask(composite, canvas, cssScale, zone)
        : reconstructCompositeRegionWithOCRMask(composite, canvas, cssScale, zone);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[Sprint30] OCR mask 路径抛错:", msg, e);
      console.log("[Sprint30] ⚠️ OCR mask 路径抛错，回退到 classifyPixels 旧路径。错误详情:", msg);
      // fall through to old path
    }
  }

  // ── 旧路径：classifyPixels ──

  // 1. 从 canvas 裁剪像素数据
  let imageData: ImageData;
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    imageData = ctx.getImageData(zone.cx, zone.cy, zone.cw, zone.ch);
  } catch {
    return null;
  }

  // 2. 像素分类：text / line / background
  const classification = classifyPixels(imageData);

  // 3. 背景颜色估计
  const bgColor = estimateBackgroundColor(imageData, classification);

  // 4. 水平插值修复文字像素
  const patchedData = inpaintTextPixels(imageData, classification, bgColor);

  // 5. 转换为 data URL
  const patchDataURL = imageDataToDataURL(patchedData, zone.cw, zone.ch);

  // 6. 使用 composite 自带的 rotation（无需重新检测）
  const angle = composite.rotation.angle;
  const rotConf = composite.rotation.confidence;

  // 7. 构建 SignatureReplacement
  const replacement: SignatureReplacement = {
    id: composite.id,
    type: "signature-replacement",
    originalRegion: zone.bbox,
    backgroundPatch: patchDataURL,
    editableTextBlocks: composite.sourceBlocks.filter(
      (b) => composite.editableBlockIds.includes(b.id),
    ),
    rotationAngle: angle,
    rotationConfidence: rotConf,
    confidence: composite.confidence,
    reconstructionMethod: "inpainting",
  };

  // 8. Debug
  const debug: BackgroundReconstructorDebug = {
    region: { x: zone.bbox.x, y: zone.bbox.y, w: zone.bbox.width, h: zone.bbox.height },
    zoneCanvasPx: { x: zone.cx, y: zone.cy, w: zone.cw, h: zone.ch },
    darkPixelCount: classification.darkCount,
    textPixelCount: classification.textCount,
    linePixelCount: classification.lineCount,
    backgroundRgb: bgColor,
    maskRectsEstimate: classification.textRunCount,
    rotationAngle: angle,
    rotationConfidence: rotConf,
    reconstructionMethod: "inpainting",
    patchPreviewDataURL: createThumbnail(patchedData, zone.cw, zone.ch, 200),
  };

  return { replacement, debug };
}

// ────────────────────────────────────────────────────────────
// Sprint 30: OCR Mask 重建路径
// ────────────────────────────────────────────────────────────

/**
 * 使用 OCR 精确像素 mask 替代 thresholdDarkPixels() heuristic。
 *
 * 关键区别：
 *   - classifyPixels: 灰度阈值 (DARK_THRESHOLD=140) → run-length → text/line 分类
 *   - generateOCRMask:   OCR block bbox → 精确知道重复文字位置 → 100% mask
 */
function reconstructCompositeRegionWithOCRMask(
  composite: SignatureCompositeRegion,
  canvas: HTMLCanvasElement,
  cssScale: number,
  zone: NonNullable<ReturnType<typeof computeCompositeZone>>,
): { replacement: SignatureReplacement; debug: BackgroundReconstructorDebug } | null {
  const log = (step: string, detail?: any) => {
    console.log(`[Sprint30::OCRMask] ${composite.id} — ${step}`, detail ?? "");
  };
  log("进入 OCR mask 路径", { zoneCx: zone.cx, zoneCy: zone.cy, zoneCw: zone.cw, zoneCh: zone.ch });

  // 1. 从 canvas 裁剪像素数据
  let imageData: ImageData;
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) { log("失败: getContext 返回 null"); return null; }
    imageData = ctx.getImageData(zone.cx, zone.cy, zone.cw, zone.ch);
    log("Step 1/6: canvas crop 成功", `${zone.cw}x${zone.ch}`);
  } catch (e) {
    log("失败: canvas crop 抛错", e);
    return null;
  }

  // "before" data URL（原始裁剪）
  const beforeDataURL = imageDataToDataURL(imageData.data, zone.cw, zone.ch);

  // 2. 生成 OCR mask
  log("Step 2/6: 开始生成 OCR mask", { dupBlockIds: composite.duplicateBlockIds, sourceBlockCount: composite.sourceBlocks?.length });
  const dummyDoc = { pages: [], styles: [], metadata: { pageCount: 0, createdAt: 0 } };
  const maskResult = generateOCRMask(imageData, zone.cx, zone.cy, cssScale, composite, dummyDoc);
  log("Step 2/6: OCR mask 生成完成", { maskedBlockIds: maskResult.maskedBlockIds, maskPixelCount: maskResult.maskPixelCount });

  // 3. 从 OCR mask 创建 PixelClassification（兼容 inpaintTextPixels 接口）
  const classification = createClassificationFromMask(imageData, maskResult.mask);
  log("Step 3/6: 分类完成", { darkCount: classification.darkCount, textCount: classification.textCount });

  // 4. 背景颜色估计
  const bgColor = estimateBackgroundColor(imageData, classification);
  log("Step 4/6: 背景色", bgColor);

  // 5. 水平插值修复被 mask 的像素
  const patchedData = inpaintTextPixels(imageData, classification, bgColor);
  log("Step 5/6: inpaint 完成", `${patchedData.length} bytes`);

  // 6. 转换为 data URL
  const patchDataURL = imageDataToDataURL(patchedData, zone.cw, zone.ch);
  log("Step 6/6: dataURL 生成完成", `${patchDataURL.length} chars`);

  // 7. 使用 composite 自带的 rotation
  const angle = composite.rotation.angle;
  const rotConf = composite.rotation.confidence;

  // 8. 构建 SignatureReplacement
  const replacement: SignatureReplacement = {
    id: composite.id,
    type: "signature-replacement",
    originalRegion: zone.bbox,
    backgroundPatch: patchDataURL,
    editableTextBlocks: composite.sourceBlocks.filter(
      (b) => composite.editableBlockIds.includes(b.id),
    ),
    rotationAngle: angle,
    rotationConfidence: rotConf,
    confidence: composite.confidence,
    reconstructionMethod: "ocr-mask",
  };

  // 9. 获取被 mask 的 block 文本（用于 debug）
  const dupBlockIds = new Set(composite.duplicateBlockIds);
  const dupBlocks = composite.sourceBlocks.filter((b) => dupBlockIds.has(b.id));
  const maskedBlockTexts = dupBlocks.map((b) => {
    const firstLine = b.lines?.[0];
    const firstGlyph = firstLine?.glyphs?.[0];
    return firstGlyph?.text ?? `block-${b.id.slice(0, 8)}`;
  });

  // 10. Debug
  const debug: BackgroundReconstructorDebug = {
    region: { x: zone.bbox.x, y: zone.bbox.y, w: zone.bbox.width, h: zone.bbox.height },
    zoneCanvasPx: { x: zone.cx, y: zone.cy, w: zone.cw, h: zone.ch },
    darkPixelCount: maskResult.maskPixelCount,
    textPixelCount: maskResult.maskPixelCount,
    linePixelCount: 0,
    backgroundRgb: bgColor,
    maskRectsEstimate: maskResult.maskedBlockIds.length,
    rotationAngle: angle,
    rotationConfidence: rotConf,
    reconstructionMethod: "ocr-mask",
    patchPreviewDataURL: createThumbnail(patchedData, zone.cw, zone.ch, 200),
  };

  // Sprint 30: 暴露 debug 到 window
  if (typeof window !== "undefined") {
    (window as any).__sprint30_maskDebug.push({
      region: composite.id,
      maskedBlocks: maskedBlockTexts,
      maskPixels: maskResult.maskPixelCount,
      before: beforeDataURL,
      after: patchDataURL,
    });
  }

  return { replacement, debug };
}

// ────────────────────────────────────────────────────────────
// Sprint 30.1: 增强 OCR Mask 重建（expand + dilate）
// ────────────────────────────────────────────────────────────

/**
 * 增强版 OCR mask 重建。
 *
 * 与原始 reconstructCompositeRegionWithOCRMask 的区别：
 *   - 使用 generateEnhancedOCRMask（expand bbox + dilate）替代 generateOCRMask
 *   - 更好的文字边缘覆盖，消除抗锯齿残留
 */
function reconstructCompositeRegionWithEnhancedOCRMask(
  composite: SignatureCompositeRegion,
  canvas: HTMLCanvasElement,
  cssScale: number,
  zone: NonNullable<ReturnType<typeof computeCompositeZone>>,
): { replacement: SignatureReplacement; debug: BackgroundReconstructorDebug } | null {
  const log = (step: string, detail?: any) => {
    console.log(`[Sprint30.1::EnhancedMask] ${composite.id} — ${step}`, detail ?? "");
  };
  const err = (step: string, detail?: any) => {
    console.error(`[Sprint30.1::EnhancedMask] ${composite.id} — ${step}`, detail ?? "");
  };
  log("进入增强 OCR mask 路径", { zoneCx: zone.cx, zoneCy: zone.cy, zoneCw: zone.cw, zoneCh: zone.ch });

  // 1. 从 canvas 裁剪像素数据
  let imageData: ImageData;
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) { err("Step 1/7 FAIL: getContext 返回 null"); return null; }
    imageData = ctx.getImageData(zone.cx, zone.cy, zone.cw, zone.ch);
    log("Step 1/7 OK: canvas crop", `${zone.cw}x${zone.ch}`);
  } catch (e) {
    err("Step 1/7 FAIL: canvas crop 抛错", e);
    return null;
  }

  // "before" data URL（原始裁剪）
  const beforeDataURL = imageDataToDataURL(imageData.data, zone.cw, zone.ch);

  // 2. 生成增强 OCR mask（expand + dilate）
  let maskResult: ReturnType<typeof generateEnhancedOCRMask>;
  try {
    log("Step 2/7 START: 生成增强 OCR mask", { dupBlockIds: composite.duplicateBlockIds?.length ?? 0 });
    const dummyDoc = { pages: [], styles: [], metadata: { pageCount: 0, createdAt: 0 } };
    maskResult = generateEnhancedOCRMask(imageData, zone.cx, zone.cy, cssScale, composite, dummyDoc);
    log("Step 2/7 OK: 增强 mask 完成", {
      maskRows: maskResult.mask.length,
      maskRowLen: maskResult.mask[0]?.length ?? 0,
      maskedBlockIds: maskResult.maskedBlockIds,
      maskPixelCount: maskResult.maskPixelCount,
      dilatedPixelCount: maskResult.dilatedPixelCount,
      blocks: maskResult.blocks?.length ?? 0,
    });
  } catch (e) {
    err("Step 2/7 FAIL: mask 生成抛错", e);
    return null;
  }

  // 3. 从 OCR mask 创建 PixelClassification
  let classification: PixelClassification;
  try {
    classification = createClassificationFromMask(imageData, maskResult.mask);
    log("Step 3/7 OK: 分类完成", { darkCount: classification.darkCount, textCount: classification.textCount });
  } catch (e) {
    err("Step 3/7 FAIL: createClassificationFromMask 抛错", e);
    return null;
  }

  // 4. 背景颜色估计
  let bgColor: [number, number, number];
  try {
    bgColor = estimateBackgroundColor(imageData, classification);
    log("Step 4/7 OK: 背景色", bgColor);
  } catch (e) {
    err("Step 4/7 FAIL: 背景色估计抛错", e);
    return null;
  }

  // 5. 水平插值修复被 mask 的像素
  let patchedData: Uint8ClampedArray;
  try {
    patchedData = inpaintTextPixels(imageData, classification, bgColor);
    log("Step 5/7 OK: inpaint 完成", `${patchedData.length} bytes`);
  } catch (e) {
    err("Step 5/7 FAIL: inpaint 抛错", e);
    return null;
  }

  // 6. 转换为 data URL
  let patchDataURL: string;
  try {
    patchDataURL = imageDataToDataURL(patchedData, zone.cw, zone.ch);
    log("Step 6/7 OK: dataURL 生成完成", `${patchDataURL.length} chars`);
  } catch (e) {
    err("Step 6/7 FAIL: dataURL 转换抛错", e);
    return null;
  }

  // 7. 构建 SignatureReplacement
  const angle = composite.rotation.angle;
  const rotConf = composite.rotation.confidence;

  const replacement: SignatureReplacement = {
    id: composite.id,
    type: "signature-replacement",
    originalRegion: zone.bbox,
    backgroundPatch: patchDataURL,
    editableTextBlocks: composite.sourceBlocks.filter(
      (b) => composite.editableBlockIds.includes(b.id),
    ),
    rotationAngle: angle,
    rotationConfidence: rotConf,
    confidence: composite.confidence,
    reconstructionMethod: "ocr-mask-enhanced",
  };

  // 8. Debug
  const debug: BackgroundReconstructorDebug = {
    region: { x: zone.bbox.x, y: zone.bbox.y, w: zone.bbox.width, h: zone.bbox.height },
    zoneCanvasPx: { x: zone.cx, y: zone.cy, w: zone.cw, h: zone.ch },
    darkPixelCount: maskResult.maskPixelCount,
    textPixelCount: maskResult.maskPixelCount,
    linePixelCount: 0,
    backgroundRgb: bgColor,
    maskRectsEstimate: maskResult.blocks?.length ?? 0,
    rotationAngle: angle,
    rotationConfidence: rotConf,
    reconstructionMethod: "ocr-mask-enhanced",
    patchPreviewDataURL: createThumbnail(patchedData, zone.cw, zone.ch, 200),
  };

  // Sprint30.1: 增强 debug 输出
  if (typeof window !== "undefined") {
    (window as any).__sprint30_maskDebug.push({
      region: composite.id,
      blocks: maskResult.blocks ?? [],
      inpaint: { radius: 2, method: "horizontal" },
      before: beforeDataURL,
      after: patchDataURL,
      reconstructionMethod: "ocr-mask-enhanced",
    });
  }

  log("Step 7/7 DONE: BackgroundReconstructor 增强路径完成", { method: "ocr-mask-enhanced", id: composite.id });
  return { replacement, debug };
}

// ────────────────────────────────────────────────────────────
// Sprint 31: 子区域分割重建
// ────────────────────────────────────────────────────────────

/**
 * 使用子区域分割的 OCR mask 重建。
 *
 * 与增强 OCR mask 的核心区别：
 *   - 增强: 对 composite 中所有 duplicate blocks 整体 mask（整个区域）
 *   - 子区域: 先 segment 为 duplicate-text / editable-text / signature-line，
 *            只 mask duplicate-text bbox，signature-line 像素永不进入 mask
 *
 * 效果：保留横线，只擦除重复文字。
 */
function reconstructCompositeRegionWithSubRegions(
  composite: SignatureCompositeRegion,
  canvas: HTMLCanvasElement,
  cssScale: number,
  zone: NonNullable<ReturnType<typeof computeCompositeZone>>,
): { replacement: SignatureReplacement; debug: BackgroundReconstructorDebug } | null {
  const log = (step: string, detail?: any) => {
    console.log(`[Sprint31::SubRegion] ${composite.id} — ${step}`, detail ?? "");
  };
  const err = (step: string, detail?: any) => {
    console.error(`[Sprint31::SubRegion] ${composite.id} — ${step}`, detail ?? "");
  };
  log("进入子区域分割路径", { zoneCx: zone.cx, zoneCy: zone.cy, zoneCw: zone.cw, zoneCh: zone.ch });

  // 1. 从 canvas 裁剪像素数据
  let imageData: ImageData;
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) { err("Step 1/6 FAIL: getContext 返回 null"); return null; }
    imageData = ctx.getImageData(zone.cx, zone.cy, zone.cw, zone.ch);
    log("Step 1/6 OK: canvas crop", `${zone.cw}x${zone.ch}`);
  } catch (e) {
    err("Step 1/6 FAIL: canvas crop 抛错", e);
    return null;
  }

  const beforeDataURL = imageDataToDataURL(imageData.data, zone.cw, zone.ch);

  // Sprint 31.2: 初始化 pipeline trace（每步成功后更新）
  const pipeTrace: Record<string, boolean> = {
    detected: true,
    segmented: false,
    maskCreated: false,
    backgroundEstimated: false,
    featherMaskCreated: false,
    reconstructionWritten: false,
    rendered: false,
  };

  // 2. 分割为子区域
  let segmentDebug: SignatureRegionSegmentDebug;
  try {
    const segmentResult = segmentSignatureRegion(composite, imageData, cssScale, zone);
    segmentDebug = segmentResult.debug;
    pipeTrace.segmented = true;
    log("Step 2/6 OK: 分割完成", segmentDebug.summary);

    // ── Sprint 31.3: 语义分类（当前 debug-only） ──
    try {
      const classification = classifySegments(
        segmentResult.subRegions, composite, imageData, cssScale, zone.cx, zone.cy,
      );
      (window as any).__sprint31_3_classification = {
        region: composite.id,
        compositeBbox: composite.bbox,
        rotation: composite.rotation,
        segments: classification,
        summary: {
          printed_text: classification.filter((c) => c.type === "printed_text").length,
          stamp_text: classification.filter((c) => c.type === "stamp_text").length,
          signature_text: classification.filter((c) => c.type === "signature_text").length,
          signature_line: classification.filter((c) => c.type === "signature_line").length,
          artifact: classification.filter((c) => c.type === "artifact").length,
          keepCount: classification.filter((c) => c.action === "keep").length,
          maskCount: classification.filter((c) => c.action === "mask").length,
        },
      } satisfies SignatureClassificationDebug;
      log("Step 2.1 OK: 语义分类完成", (window as any).__sprint31_3_classification.summary);
    } catch (e) {
      log("Step 2.1 WARN: 语义分类失败", e);
    }

    // 暴露 debug
    if (typeof window !== "undefined") {
      (window as any).__sprint31_signatureSegments = segmentDebug;
    }
  } catch (e) {
    err("Step 2/6 FAIL: 分割抛错", e);
    return null;
  }

  // 3. 获取 duplicate-text 子区域的 CSS bbox 列表
  const dupTextBboxes = segmentDebug.segments
    .filter((s) => s.type === "duplicate-text")
    .map((s) => s.bbox);

  const lineBboxes = segmentDebug.segments
    .filter((s) => s.type === "signature-line")
    .map((s) => s.bbox);

  log("Step 3/6: 收集子区域 bbox", {
    dupTextCount: dupTextBboxes.length,
    lineCount: lineBboxes.length,
    editableCount: segmentDebug.segments.filter((s) => s.type === "editable-text").length,
  });

  // 4. 从 duplicate-text bbox 生成 OCR mask（expand + dilate）
  //    signature-line bbox 不进入 mask → 天然被保护
  let maskResult: ReturnType<typeof generateMaskFromBboxes>;
  try {
    maskResult = generateMaskFromBboxes(
      imageData, zone.cx, zone.cy, cssScale,
      dupTextBboxes,
      { expand: true, dilate: true },
    );
    log("Step 4/6 OK: mask 生成完成", {
      maskPixelCount: maskResult.maskPixelCount,
      dilatedPixelCount: maskResult.dilatedPixelCount,
      blocks: maskResult.blocks?.length ?? 0,
    });
    pipeTrace.maskCreated = true;
  } catch (e) {
    err("Step 4/6 FAIL: mask 生成抛错", e);
    return null;
  }

  // ── Sprint 31.1: Local Background Reconstruction + Feather Mask ──
  // 5. 将 dup-text CSS bbox 转换为 zone-local canvas 坐标
  const maskBBoxesLocal = dupTextBboxes.map((bbox) => ({
    x: Math.round(bbox.x / cssScale) - zone.cx,
    y: Math.round(bbox.y / cssScale) - zone.cy,
    width: Math.round(bbox.width / cssScale),
    height: Math.round(bbox.height / cssScale),
  }));

  // 6. 为每个 dup-text bbox 独立估算局部背景色
  let background: LocalBackground;
  try {
    const bgEstimate = estimateBackgroundsForBboxes(imageData, maskBBoxesLocal);
    background = bgEstimate.background;
    pipeTrace.backgroundEstimated = true;
    log("Step 5/7 OK: 局部背景色估算完成", { background, confidence: bgEstimate.confidence });
  } catch (e) {
    err("Step 5/7 FAIL: 背景色估算抛错", e);
    return null;
  }

  // 7. 创建羽化 alpha mask（从二值 mask → 0~1 alpha）
  let alphaMask: Float32Array[];
  try {
    alphaMask = createFeatherMask(maskResult.mask);
    pipeTrace.featherMaskCreated = true;
    log("Step 6/7 OK: 羽化 mask 创建完成", {
      rows: alphaMask.length,
      rowLen: alphaMask[0]?.length ?? 0,
    });
  } catch (e) {
    err("Step 6/7 FAIL: 羽化 mask 创建抛错", e);
    return null;
  }

  // 8. Local inpaint: 用 alpha mask 将背景色混入原图
  let patchedData: Uint8ClampedArray;
  let blendedPixelCount = 0;
  try {
    patchedData = localInpaint(imageData, alphaMask, background);
    blendedPixelCount =
      (typeof window !== "undefined" ? (window as any).__sprint31_1_lastBlendCount : 0) || 0;
    log("Step 7/7 OK: local inpaint 完成", {
      bytes: patchedData.length,
      blendedPixels: blendedPixelCount,
      maskPixels: maskResult.maskPixelCount,
    });
  } catch (e) {
    err("Step 7/7 FAIL: local inpaint 抛错", e);
    return null;
  }

  // 9. dataURL → replacement → debug
  let patchDataURL: string;
  try {
    patchDataURL = imageDataToDataURL(patchedData, zone.cw, zone.ch);
    pipeTrace.reconstructionWritten = true;
    log("dataURL 生成完成", `${patchDataURL.length} chars`);
  } catch (e) {
    err("dataURL 转换抛错", e);
    return null;
  }

  const angle = composite.rotation.angle;
  const rotConf = composite.rotation.confidence;

  const replacement: SignatureReplacement = {
    id: composite.id,
    type: "signature-replacement",
    originalRegion: zone.bbox,
    backgroundPatch: patchDataURL,
    editableTextBlocks: composite.sourceBlocks.filter(
      (b) => composite.editableBlockIds.includes(b.id),
    ),
    rotationAngle: angle,
    rotationConfidence: rotConf,
    confidence: composite.confidence,
    reconstructionMethod: "local-background-feather",
  };

  const debug: BackgroundReconstructorDebug = {
    region: { x: zone.bbox.x, y: zone.bbox.y, w: zone.bbox.width, h: zone.bbox.height },
    zoneCanvasPx: { x: zone.cx, y: zone.cy, w: zone.cw, h: zone.ch },
    darkPixelCount: maskResult.maskPixelCount,
    textPixelCount: maskResult.maskPixelCount,
    linePixelCount: 0,
    backgroundRgb: [background.r, background.g, background.b],
    maskRectsEstimate: dupTextBboxes.length,
    rotationAngle: angle,
    rotationConfidence: rotConf,
    reconstructionMethod: "local-background-feather",
    patchPreviewDataURL: createThumbnail(patchedData, zone.cw, zone.ch, 200),
  };

  // Sprint 31.1 debug 输出
  if (typeof window !== "undefined") {
    (window as any).__sprint30_maskDebug.push({
      region: composite.id,
      blocks: maskResult.blocks ?? [],
      inpaint: { method: "local-background-feather" },
      before: beforeDataURL,
      after: patchDataURL,
      reconstructionMethod: "local-background-feather",
      sprint31_1: {
        duplicateTextBboxes: dupTextBboxes.length,
        signatureLines: lineBboxes.length,
        segmentSummary: segmentDebug.summary,
        background: { r: background.r, g: background.g, b: background.b },
        maskPixels: maskResult.maskPixelCount,
        blendedPixels: blendedPixelCount,
      },
    });
  }

  log("DONE: Local Background Feather 重建完成", {
    method: "local-background-feather",
    id: composite.id,
    dupPixels: maskResult.maskPixelCount,
    linesProtected: lineBboxes.length,
    background,
    blendedPixels: blendedPixelCount,
  });

  // Sprint 31.2: 存储 pipeline trace
  if (typeof window !== "undefined") {
    const traces = (window as any).__sprint31_pipelineTraces ?? [];
    traces.push({
      region: composite.id,
      steps: pipeTrace,
      background: { r: background.r, g: background.g, b: background.b },
      dupTextBboxes: dupTextBboxes.length,
      signatureLines: lineBboxes.length,
      maskPixels: maskResult.maskPixelCount,
      blendedPixels: blendedPixelCount,
      dataURLSize: patchDataURL.length,
      timestamp: Date.now(),
    });
    (window as any).__sprint31_pipelineTraces = traces;
  }

  return { replacement, debug };
}

/**
 * 从 OCR mask 创建 PixelClassification（兼容现有 inpaintTextPixels 接口）。
 * mask[r][c] === 1 → isDark + isText（需擦除）
 * mask[r][c] === 0 → 保留
 */
function createClassificationFromMask(
  imageData: ImageData,
  ocrMask: Uint8Array[],
): PixelClassification {
  const { width: w, height: h } = imageData;
  const isDark: Uint8Array[] = [];
  const isText: Uint8Array[] = [];
  const isLine: Uint8Array[] = [];
  let darkCount = 0;
  let textCount = 0;

  for (let r = 0; r < h; r++) {
    const darkRow = new Uint8Array(w);
    const textRow = new Uint8Array(w);
    const lineRow = new Uint8Array(w); // all zero (no lines to preserve)
    for (let c = 0; c < w; c++) {
      if (ocrMask[r][c] === 1) {
        darkRow[c] = 1;
        textRow[c] = 1;
        darkCount++;
        textCount++;
      }
    }
    isDark.push(darkRow);
    isText.push(textRow);
    isLine.push(lineRow);
  }

  return {
    w, h, isDark, isText, isLine,
    darkCount, textCount, lineCount: 0,
    textRunCount: darkCount > 0 ? 1 : 0,
  };
}

/**
 * 从 composite region 的 bbox 计算 canvas 裁剪区域。
 * 与旧版不同: 直接使用 composite.bbox（已含所有 source blocks）而非仅 suppressed blocks。
 */
function computeCompositeZone(
  composite: SignatureCompositeRegion,
  cssScale: number,
): SignatureZone | null {
  if (composite.duplicateBlockIds.length === 0) return null;

  const b = composite.bbox;
  const padH = 10;
  const padV = 8;

  const bbox: BBox = {
    x: Math.max(0, b.x - padH),
    y: Math.max(0, b.y - padV),
    width: b.width + padH * 2,
    height: b.height + padV * 2,
  };

  return {
    bbox,
    cx: Math.floor(bbox.x / cssScale),
    cy: Math.floor(bbox.y / cssScale),
    cw: Math.ceil(bbox.width / cssScale),
    ch: Math.ceil(bbox.height / cssScale),
  };
}

// ────────────────────────────────────────────────────────────
// 单个区域重建（旧版，保留向后兼容）
// ────────────────────────────────────────────────────────────

function reconstructOneRegion(
  region: SignatureRegion,
  canvas: HTMLCanvasElement,
  cssScale: number,
): { replacement: SignatureReplacement; debug: BackgroundReconstructorDebug } | null {
  const zone = computeSignatureZone(region, cssScale);
  if (!zone) return null;

  // 1. 从 canvas 裁剪像素数据
  let imageData: ImageData;
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    imageData = ctx.getImageData(zone.cx, zone.cy, zone.cw, zone.ch);
  } catch {
    return null;
  }

  // 2. 像素分类：text / line / background
  const classification = classifyPixels(imageData);

  // 3. 背景颜色估计
  const bgColor = estimateBackgroundColor(imageData, classification);

  // 4. 水平插值修复文字像素
  const patchedData = inpaintTextPixels(imageData, classification, bgColor);

  // 5. 转换为 data URL
  const patchDataURL = imageDataToDataURL(patchedData, zone.cw, zone.ch);

  // 6. 旋转检测
  const { angle, confidence: rotConf } = detectBaselineAngle(region);

  // 7. 构建 SignatureReplacement
  const replacement: SignatureReplacement = {
    id: region.id,
    type: "signature-replacement",
    originalRegion: zone.bbox,
    backgroundPatch: patchDataURL,
    editableTextBlocks: region.originalSourceBlocks.filter(
      (b) => !region.suppressedBlocks.some((s) => s.id === b.id),
    ),
    rotationAngle: angle,
    rotationConfidence: rotConf,
    confidence: region.confidence,
    reconstructionMethod: "inpainting",
  };

  // 8. Debug
  const debug: BackgroundReconstructorDebug = {
    region: { x: zone.bbox.x, y: zone.bbox.y, w: zone.bbox.width, h: zone.bbox.height },
    zoneCanvasPx: { x: zone.cx, y: zone.cy, w: zone.cw, h: zone.ch },
    darkPixelCount: classification.darkCount,
    textPixelCount: classification.textCount,
    linePixelCount: classification.lineCount,
    backgroundRgb: bgColor,
    maskRectsEstimate: classification.textRunCount,
    rotationAngle: angle,
    rotationConfidence: rotConf,
    reconstructionMethod: "inpainting",
    patchPreviewDataURL: createThumbnail(patchedData, zone.cw, zone.ch, 200),
  };

  return { replacement, debug };
}

// ────────────────────────────────────────────────────────────
// 签名区域 bbox 计算（含动态 padding）
// ────────────────────────────────────────────────────────────

export interface SignatureZone {
  /** CSS bbox */
  bbox: BBox;
  /** canvas 像素坐标 */
  cx: number;
  cy: number;
  cw: number;
  ch: number;
}

function computeSignatureZone(
  region: SignatureRegion,
  cssScale: number,
): SignatureZone | null {
  const suppressed = region.suppressedBlocks;
  if (suppressed.length === 0) return null;

  // 计算被抑制块的并集 bbox
  const union = unionBBox(suppressed.map((b) => b.bbox));

  // 动态 padding：基于 block bbox 高度（≈ 字号）估算
  let maxBlockHeight = 12;
  for (const block of suppressed) {
    const h = block.bbox.height / Math.max(block.lines.length, 1);
    if (h > maxBlockHeight) maxBlockHeight = h;
  }
  const padH = Math.max(maxBlockHeight * 0.5, 8);
  const padV = Math.max(maxBlockHeight * 0.4, 5);

  const bbox: BBox = {
    x: Math.max(0, union.x - padH),
    y: Math.max(0, union.y - padV),
    width: union.width + padH * 2,
    height: union.height + padV * 2,
  };

  return {
    bbox,
    cx: Math.floor(bbox.x / cssScale),
    cy: Math.floor(bbox.y / cssScale),
    cw: Math.ceil(bbox.width / cssScale),
    ch: Math.ceil(bbox.height / cssScale),
  };
}

// ────────────────────────────────────────────────────────────
// 像素分类
// ────────────────────────────────────────────────────────────

interface PixelClassification {
  /** width × height */
  w: number;
  h: number;
  /** isDark[row][col] */
  isDark: Uint8Array[];
  /** isText[row][col] — 需要擦除的文字像素 */
  isText: Uint8Array[];
  /** isLine[row][col] — 需要保留的横线像素 */
  isLine: Uint8Array[];
  darkCount: number;
  textCount: number;
  lineCount: number;
  /** 文字游程段总数（≈ Sprint 18 的 mask 矩形数） */
  textRunCount: number;
}

function classifyPixels(imageData: ImageData): PixelClassification {
  const { data, width, height } = imageData;

  // Allocate row arrays
  const isDark: Uint8Array[] = [];
  const isText: Uint8Array[] = [];
  const isLine: Uint8Array[] = [];
  for (let r = 0; r < height; r++) {
    isDark.push(new Uint8Array(width));
    isText.push(new Uint8Array(width));
    isLine.push(new Uint8Array(width));
  }

  let darkCount = 0;
  let textCount = 0;
  let lineCount = 0;
  let textRunCount = 0;

  // Pass 1: mark dark pixels
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const i = (r * width + c) * 4;
      const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      if (gray < DARK_THRESHOLD) {
        isDark[r][c] = 1;
        darkCount++;
      }
    }
  }

  // Pass 2: classify dark pixels by horizontal run-length
  for (let r = 0; r < height; r++) {
    let col = 0;
    while (col < width) {
      if (!isDark[r][col]) {
        col++;
        continue;
      }
      // Find end of dark run
      let end = col + 1;
      while (end < width && isDark[r][end]) end++;

      const runLen = end - col;
      if (runLen >= LINE_RUN_LENGTH) {
        // Long run → signature line, preserve
        for (let c = col; c < end; c++) {
          isLine[r][c] = 1;
          lineCount++;
        }
      } else {
        // Short run → text, erase
        for (let c = col; c < end; c++) {
          isText[r][c] = 1;
          textCount++;
        }
        textRunCount++;
      }

      col = end;
    }
  }

  return { w: width, h: height, isDark, isText, isLine, darkCount, textCount, lineCount, textRunCount };
}

// ────────────────────────────────────────────────────────────
// 背景颜色估计
// ────────────────────────────────────────────────────────────

function estimateBackgroundColor(
  imageData: ImageData,
  cls: PixelClassification,
): [number, number, number] {
  const { data, width, height } = imageData;
  const samples: Array<[number, number, number]> = [];

  // 从顶部和底部边缘采样非暗像素
  const edgeRows = 3;
  for (let r = 0; r < Math.min(edgeRows, height); r++) {
    for (let c = 0; c < width; c++) {
      if (!cls.isDark[r][c]) {
        const i = (r * width + c) * 4;
        samples.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
  }
  for (let r = Math.max(0, height - edgeRows); r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (!cls.isDark[r][c]) {
        const i = (r * width + c) * 4;
        samples.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
  }

  // 如果边缘样本不足，从整个区域采样非暗像素
  if (samples.length < 10) {
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        if (!cls.isDark[r][c]) {
          const i = (r * width + c) * 4;
          samples.push([data[i], data[i + 1], data[i + 2]]);
        }
      }
    }
  }

  if (samples.length === 0) return [255, 255, 255];

  // 取中位数
  samples.sort((a, b) => a[0] + a[1] + a[2] - b[0] - b[1] - b[2]);
  const mid = Math.floor(samples.length / 2);
  return samples[mid];
}

// ────────────────────────────────────────────────────────────
// 水平插值修复文字像素
// ────────────────────────────────────────────────────────────

function inpaintTextPixels(
  imageData: ImageData,
  cls: PixelClassification,
  bgColor: [number, number, number],
): Uint8ClampedArray {
  const { w: width, h: height } = cls;
  const src = imageData.data;
  const dst = new Uint8ClampedArray(src.length); // clone

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const i = (r * width + c) * 4;

      if (cls.isText[r][c]) {
        // 文字像素 → 水平插值修复
        const color = findBackgroundColorHorizontal(r, c, cls, src, bgColor);
        dst[i] = color[0];
        dst[i + 1] = color[1];
        dst[i + 2] = color[2];
        dst[i + 3] = 255;
      } else {
        // 非文字像素 → 原样保留
        dst[i] = src[i];
        dst[i + 1] = src[i + 1];
        dst[i + 2] = src[i + 2];
        dst[i + 3] = src[i + 3];
      }
    }
  }

  return dst;
}

/**
 * 从当前行左右两侧寻找非文字/非暗像素的背景色。
 * 如果左右都未找到，回退到全局估计的背景色。
 */
function findBackgroundColorHorizontal(
  row: number,
  col: number,
  cls: PixelClassification,
  data: Uint8ClampedArray,
  bgColor: [number, number, number],
): [number, number, number] {
  const { w: width } = cls;
  let leftColor: [number, number, number] | null = null;
  let rightColor: [number, number, number] | null = null;

  // 向左搜索
  for (let c = col - 1; c >= Math.max(0, col - MAX_NEARBY_SEARCH); c--) {
    if (!cls.isText[row][c] && !cls.isDark[row][c]) {
      const i = (row * width + c) * 4;
      leftColor = [data[i], data[i + 1], data[i + 2]];
      break;
    }
  }

  // 向右搜索
  for (let c = col + 1; c < Math.min(width, col + MAX_NEARBY_SEARCH); c++) {
    if (!cls.isText[row][c] && !cls.isDark[row][c]) {
      const i = (row * width + c) * 4;
      rightColor = [data[i], data[i + 1], data[i + 2]];
      break;
    }
  }

  // 插值
  if (leftColor && rightColor) {
    return [
      Math.round((leftColor[0] + rightColor[0]) / 2),
      Math.round((leftColor[1] + rightColor[1]) / 2),
      Math.round((leftColor[2] + rightColor[2]) / 2),
    ];
  }
  if (leftColor) return leftColor;
  if (rightColor) return rightColor;
  return bgColor;
}

// ────────────────────────────────────────────────────────────
// 旋转角度检测
// ────────────────────────────────────────────────────────────

/**
 * 从 suppressed handwritten block 的 glyph 位置检测基线旋转角度。
 * 使用线性回归：y = mx + b → angle = atan(m)
 */
function detectBaselineAngle(
  region: SignatureRegion,
): { angle: number; confidence: number } {
  const points: Array<{ x: number; y: number }> = [];

  for (const block of region.suppressedBlocks) {
    for (const line of block.lines) {
      for (const glyph of line.glyphs) {
        const bbox = glyph.originalBBox || glyph.bbox;
        // 使用 glyph 左下角作为点（基线位置）
        points.push({ x: bbox.x, y: bbox.y + bbox.height });
      }
    }
  }

  if (points.length < 3) return { angle: 0, confidence: 0 };

  // 线性回归：y = slope * x + intercept
  const n = points.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
  }

  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-10) return { angle: 0, confidence: 0 };

  const slope = (n * sumXY - sumX * sumY) / denom;

  // R²
  const meanY = sumY / n;
  let ssRes = 0, ssTot = 0;
  for (const p of points) {
    const predicted = slope * p.x + (sumY - slope * sumX) / n;
    ssRes += (p.y - predicted) ** 2;
    ssTot += (p.y - meanY) ** 2;
  }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  // angle = atan(slope) in degrees (clockwise positive)
  const angle = Math.atan(slope) * (180 / Math.PI);

  return { angle, confidence: r2 };
}

// ────────────────────────────────────────────────────────────
// 图像工具函数
// ────────────────────────────────────────────────────────────

function imageDataToDataURL(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const imageData = ctx.createImageData(width, height);
  imageData.data.set(data);
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

function createThumbnail(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  maxDim: number,
): string | null {
  try {
    const fullCanvas = document.createElement("canvas");
    fullCanvas.width = w;
    fullCanvas.height = h;
    const fullCtx = fullCanvas.getContext("2d");
    if (!fullCtx) return null;
    const imgData = fullCtx.createImageData(w, h);
    imgData.data.set(data);
    fullCtx.putImageData(imgData, 0, 0);

    const scale = Math.min(1, maxDim / Math.max(w, h));
    const thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = Math.round(w * scale);
    thumbCanvas.height = Math.round(h * scale);
    const thumbCtx = thumbCanvas.getContext("2d");
    if (!thumbCtx) return null;
    thumbCtx.drawImage(fullCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    return thumbCanvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// Sprint 30: Debug helpers
// ────────────────────────────────────────────────────────────

if (typeof window !== "undefined") {
  // 预初始化（避免 "not defined" 错误）
  if (!(window as any).__sprint30_maskDebug) {
    (window as any).__sprint30_maskDebug = [];
  }

  (window as any).__sprint30_checkFlag = () => {
    const lsVal = localStorage.getItem("__sprint30_useOCRMask");
    const winVal = (window as any).__sprint30_useOCRMask;
    return {
      localStorage: lsVal,
      window: winVal,
      effective: lsVal === "true" || winVal === true,
      hint: "Set in console: localStorage.setItem('__sprint30_useOCRMask', 'true') — then reload the document (not page)",
    };
  };

  (window as any).__sprint30_on = () => {
    localStorage.setItem("__sprint30_useOCRMask", "true");
    (window as any).__sprint30_useOCRMask = true;
    console.log("[Sprint30] OCR mask ENABLED. Reload the document (re-upload) to trigger.");
    return (window as any).__sprint30_checkFlag();
  };

  (window as any).__sprint30_off = () => {
    localStorage.removeItem("__sprint30_useOCRMask");
    delete (window as any).__sprint30_useOCRMask;
    console.log("[Sprint30] OCR mask DISABLED. Reload the document to use classifyPixels again.");
    return (window as any).__sprint30_checkFlag();
  };

  // Sprint30.1: A/B test helpers（持久化到 localStorage）
  (window as any).__sprint301_enhanced_on = () => {
    localStorage.setItem("__signatureUseEnhancedMask", "true");
    (window as any).__signatureUseEnhancedMask = true;
    console.log("[Sprint30.1] Enhanced mask (expand+dilate) ENABLED. Reload document to see effect.");
    return { enhanced: true, persisted: true, hint: "Re-upload document. Use __sprint301_enhanced_off() to revert." };
  };

  (window as any).__sprint301_enhanced_off = () => {
    localStorage.removeItem("__signatureUseEnhancedMask");
    (window as any).__signatureUseEnhancedMask = false;
    console.log("[Sprint30.1] Enhanced mask DISABLED — using original OCR bbox. Reload document.");
    return { enhanced: false };
  };

  (window as any).__sprint301_status = () => {
    return {
      ocrMaskOn: (window as any).__sprint30_useOCRMask === true || localStorage.getItem("__sprint30_useOCRMask") === "true",
      enhancedMask: (window as any).__signatureUseEnhancedMask === true || localStorage.getItem("__signatureUseEnhancedMask") === "true",
      sprint31: localStorage.getItem("__sprint31_enabled") === "true" || (window as any).__sprint31_enabled === true,
      maskDebugEntries: ((window as any).__sprint30_maskDebug ?? []).length,
      signatureSegments: (window as any).__sprint31_signatureSegments ?? null,
    };
  };

  // Sprint 31: 子区域分割开关
  (window as any).__sprint31_on = () => {
    localStorage.setItem("__sprint31_enabled", "true");
    (window as any).__sprint31_enabled = true;
    console.log(
      "[Sprint31] Sub-region segmentation ENABLED.\n",
      "  效果: 只 mask duplicate-text，保护 signature-line 和 editable-text\n",
      "  下一步: 重新上传/OCR 文档"
    );
    return (window as any).__sprint301_status();
  };

  (window as any).__sprint31_off = () => {
    localStorage.setItem("__sprint31_enabled", "false");
    (window as any).__sprint31_enabled = false;
    console.log("[Sprint31] Sub-region segmentation DISABLED. 重新 OCR 将使用旧方法。");
    return (window as any).__sprint301_status();
  };

  // Sprint 31.1: Local Background Reconstruction + Feather Mask debug
  (window as any).__sprint31_1_debug = () => {
    const maskDebugEntries = ((window as any).__sprint30_maskDebug ?? []) as any[];

    console.log("[Sprint31.1 Debug] __sprint30_maskDebug 总条目:", maskDebugEntries.length);

    if (maskDebugEntries.length === 0) {
      return {
        status: "no maskDebug entries at all",
        hint: "reconstructCompositeRegion 可能未被调用，或 composite region 未检测到。检查控制台是否有 [Sprint31.1] 入口日志。",
        sprint31Enabled: typeof window !== "undefined" ? !!(window as any).__sprint31_enabled : false,
        localStorageSprint31: typeof window !== "undefined" ? localStorage.getItem("__sprint31_enabled") : "n/a",
        sprint30UseOCRMask: typeof window !== "undefined" ? !!(window as any).__sprint30_useOCRMask : false,
      };
    }

    // 展示所有条目及其方法
    const allEntries = maskDebugEntries.map((entry: any) => ({
      region: entry.region,
      method: entry.reconstructionMethod ?? "unknown",
      sprint31_1: entry.sprint31_1 ?? null,
    }));

    const featherEntries = maskDebugEntries.filter(
      (e: any) => e.reconstructionMethod === "local-background-feather",
    );

    if (featherEntries.length === 0) {
      return {
        status: "entries exist but none use local-background-feather",
        hint: "所有条目走了旧方法。检查是否开启了 __sprint31_on()。",
        totalEntries: maskDebugEntries.length,
        allMethods: maskDebugEntries.map((e: any) => e.reconstructionMethod),
        allEntries,
      };
    }

    const details = featherEntries.map((entry: any) => ({
      region: entry.region,
      oldMethod: "white-fill",
      newMethod: "local-background-feather",
      maskPixels: entry.sprint31_1?.maskPixels ?? 0,
      blendedPixels: entry.sprint31_1?.blendedPixels ?? 0,
      background: entry.sprint31_1?.background ?? { r: 255, g: 255, b: 255 },
      protected: [
        ...(entry.sprint31_1?.signatureLines > 0 ? ["signatureLine"] : []),
        ...(entry.sprint31_1?.duplicateTextBboxes > 0 ? [] : []),
      ] as string[],
      duplicateTextBboxes: entry.sprint31_1?.duplicateTextBboxes ?? 0,
      signatureLines: entry.sprint31_1?.signatureLines ?? 0,
      segmentSummary: entry.sprint31_1?.segmentSummary ?? "n/a",
    }));

    return {
      status: "ok",
      count: details.length,
      summary: {
        totalEntries: maskDebugEntries.length,
        featherEntries: details.length,
        totalMaskPixels: details.reduce((s: number, d: any) => s + d.maskPixels, 0),
        totalBlendedPixels: details.reduce((s: number, d: any) => s + d.blendedPixels, 0),
        regions: details.map((d: any) => d.region),
        method: "local-background-feather",
      },
      details,
      allEntries,
    };
  };

  // Sprint 31.2: Pipeline trace debug
  (window as any).__sprint31_pipelineDebug = () => {
    const traces = ((window as any).__sprint31_pipelineTraces ?? []) as any[];

    // 检查渲染层（从 DOM）
    const wrapper = document.querySelector(".pdf-pages-wrapper, [data-pdf-wrapper]");
    let backgroundLayer = false;
    let glyphLayer = false;
    let pdfCanvas = false;
    if (wrapper) {
      pdfCanvas = !!wrapper.querySelector("canvas");
      backgroundLayer = !!wrapper.querySelector('[data-layer="background"] img, [data-bg-patch]');
      glyphLayer = !!wrapper.querySelector('[data-layer="background"] span[style*="position: absolute"]');
    }

    // 更新每个 trace 的渲染状态
    traces.forEach((t: any) => {
      if (backgroundLayer) {
        t.steps.patchInserted = true;
        t.steps.rendered = true;
      }
      t.layers = {
        backgroundPatch: backgroundLayer,
        glyphLayer,
        pdfCanvas,
      };
    });

    if (traces.length === 0) {
      return {
        status: "no pipeline traces",
        hint: "reconstructCompositeRegionWithSubRegions 未执行。检查控制台 [Sprint31] 日志。",
        sdkEnabled: isSprint31Enabled(),
        renderLayers: { backgroundPatch: backgroundLayer, glyphLayer, pdfCanvas },
      };
    }

    return {
      status: "ok",
      count: traces.length,
      renderLayers: { backgroundPatch: backgroundLayer, glyphLayer, pdfCanvas },
      regions: traces.map((t: any) => ({
        region: t.region,
        steps: t.steps,
        layers: { backgroundPatch: backgroundLayer, glyphLayer, pdfCanvas },
        background: t.background,
        dupTextBboxes: t.dupTextBboxes,
        signatureLines: t.signatureLines,
        maskPixels: t.maskPixels,
        blendedPixels: t.blendedPixels,
        dataURLSize: t.dataURLSize,
      })),
    };
  };
}
