/**
 * Sprint 31 / 31.3: Signature Region Segmenter
 *
 * 将 SignatureCompositeRegion 拆分为精细子区域：
 *   1. duplicate-text: 从 composite.duplicateBlockIds 直接映射
 *   2. editable-text:  从 composite.editableBlockIds 直接映射
 *   3. signature-line:  在 ImageData 中检测横向黑线
 *
 * Sprint 31.3 新增语义分类 pipeline（当前 debug-only）：
 *   4 条规则将 segment 分为 printed_text / stamp_text / signature_text / signature_line / artifact
 */

import type { SignatureCompositeRegion } from "./signature-composite-region";
import type { EditableDocument, EditableBlock, BBox } from "./types";
import {
  type SignatureSubRegion,
  type SignatureSubRegionType,
  type SignatureRegionSegmentDebug,
  type SegmentClassification,
  type SignatureClassificationDebug,
  type SignatureSegmentType,
} from "./signature-sub-region";

/** Zone 参数（避免循环依赖 signature-background-reconstructor） */
export interface ZoneParams {
  bbox: BBox;
  cx: number;
  cy: number;
  cw: number;
  ch: number;
}

// ── 配置 ──

/** 灰度阈值：低于此值视为暗像素 */
const DARK_THRESHOLD = 140;

/** 横向黑线最小长度（canvas 像素） */
const LINE_MIN_LENGTH = 100;

/** 横向黑线最大高度（canvas 像素） */
const LINE_MAX_HEIGHT = 3;

/**
 * Sprint 31.2: 默认启用子区域分割。
 * 只有显式设置 __sprint31_enabled=false 或 localStorage.__sprint31_enabled="false" 才会禁用。
 */
export function isSprint31Enabled(): boolean {
  if (typeof window === "undefined") return true;
  // 显式禁用检查（优先）
  if ((window as any).__sprint31_enabled === false) return false;
  if (localStorage.getItem("__sprint31_enabled") === "false") return false;
  // 默认启用
  return true;
}

// ────────────────────────────────────────────────────────────
// 公共 API
// ────────────────────────────────────────────────────────────

/**
 * 将 SignatureCompositeRegion 分割为子区域。
 *
 * @param composite      - 复合签名区域
 * @param imageData      - zone-cropped ImageData（zone.cw × zone.ch）
 * @param cssScale       - canvas.clientWidth / canvas.width
 * @param zone           - 签名区域 zone（含 cx/cy canvas 偏移）
 * @param editableDoc    - 可编辑文档（用于获取 block 文本）
 * @returns SignatureSubRegion[] + debug
 */
export function segmentSignatureRegion(
  composite: SignatureCompositeRegion,
  imageData: ImageData,
  cssScale: number,
  zone: ZoneParams,
  editableDoc?: EditableDocument,
): { subRegions: SignatureSubRegion[]; debug: SignatureRegionSegmentDebug } {
  const subRegions: SignatureSubRegion[] = [];

  const dupBlockIds = new Set(composite.duplicateBlockIds);
  const editableBlockIds = new Set(composite.editableBlockIds);
  const blockMap = new Map<string, EditableBlock>();
  for (const b of composite.sourceBlocks) {
    blockMap.set(b.id, b);
  }

  // ── Rule 1: Duplicate Text ──
  for (const blockId of composite.duplicateBlockIds) {
    const block = blockMap.get(blockId);
    if (!block) continue;

    const text = block.lines?.[0]?.glyphs?.[0]?.text
      ?? block.lines?.[0]?.text
      ?? `dup-${blockId.slice(0, 8)}`;

    subRegions.push({
      id: `sub_dup_${blockId}`,
      type: "duplicate-text",
      bbox: { ...block.bbox },
      sourceBlockIds: [blockId],
      text,
      confidence: 1.0,
    });
  }

  // ── Rule 2: Editable Text ──
  for (const blockId of composite.editableBlockIds) {
    if (dupBlockIds.has(blockId)) continue; // 避免重复（不太可能但防御一下）

    const block = blockMap.get(blockId);
    if (!block) continue;

    const text = block.lines?.[0]?.glyphs?.[0]?.text
      ?? block.lines?.[0]?.text
      ?? `edit-${blockId.slice(0, 8)}`;

    subRegions.push({
      id: `sub_edit_${blockId}`,
      type: "editable-text",
      bbox: { ...block.bbox },
      sourceBlockIds: [blockId],
      text,
      confidence: 1.0,
    });
  }

  // ── Rule 3: Signature Line Detection ──
  const lineRegions = detectHorizontalLines(imageData, zone.cx, zone.cy, cssScale, composite.id);
  for (const lr of lineRegions) {
    subRegions.push(lr);
  }

  // ── Summary ──
  const editableTextCount = subRegions.filter((s) => s.type === "editable-text").length;
  const duplicateTextCount = subRegions.filter((s) => s.type === "duplicate-text").length;
  const signatureLineCount = subRegions.filter((s) => s.type === "signature-line").length;
  const backgroundCount = subRegions.filter((s) => s.type === "background").length;

  const protectedBboxes = subRegions
    .filter((s) => s.type !== "duplicate-text")
    .map((s) => s.bbox);

  const maskBboxes = subRegions
    .filter((s) => s.type === "duplicate-text")
    .map((s) => s.bbox);

  const debug: SignatureRegionSegmentDebug = {
    region: composite.id,
    segments: subRegions,
    summary: {
      editableText: editableTextCount,
      duplicateText: duplicateTextCount,
      signatureLine: signatureLineCount,
      background: backgroundCount,
    },
    protectedBboxes,
    maskBboxes,
  };

  if (isSprint31Enabled()) {
    console.log(
      `[Sprint31] Signature segmentation complete for ${composite.id}`,
      debug.summary,
    );
  }

  return { subRegions, debug };
}

// ────────────────────────────────────────────────────────────
// Sprint 31.3 / 31.3.1: 语义分类 Pipeline（当前 debug-only）
// ────────────────────────────────────────────────────────────

/**
 * 将 SignatureSubRegion[] 升级为 SegmentClassification[]。
 *
 * 两阶段：
 *   Pass 1 — 逐 segment 计算 oldStampScore（位置/旋转/对比度/墨迹）
 *   Pass 2 — 跨 segment 计算 duplicateTextScore（语义重复证据）+ 最终决策
 *
 * 注意：当前版本仅输出分类结果到 debug，不改变 mask 行为。
 */
export function classifySegments(
  subRegions: SignatureSubRegion[],
  composite: SignatureCompositeRegion,
  imageData: ImageData,
  cssScale: number,
  zoneCx: number,
  zoneCy: number,
): SegmentClassification[] {
  const { rotation } = composite;
  const dupBlockIds = new Set(composite.duplicateBlockIds);

  // 找出签名横线的 y 坐标
  const lineYs = subRegions
    .filter((s) => s.type === "signature-line")
    .map((s) => s.bbox.y + s.bbox.height / 2);

  // ── 构建 editable text 的规范化索引（用于 duplicateTextScore） ──
  const editableSegments = subRegions.filter(
    (s) => s.type === "editable-text" || (!dupBlockIds.has(s.sourceBlockIds[0] ?? "") && s.text),
  );
  const editableNormTexts: { norm: string; crms: string[] }[] = editableSegments.map((s) => ({
    norm: normalizeStampText(s.text ?? ""),
    crms: extractCRMNums(s.text ?? ""),
  }));

  // ── Pass 1: 逐 segment 计算 oldStampScore ──
  const perSegmentScores = subRegions.map((seg) => {
    const reasons: string[] = [];

    // Rule 1: 位置
    let positionScore = 0.5;
    const aboveLine = lineYs.length > 0
      ? seg.bbox.y < lineYs[0]
      : seg.bbox.y < composite.bbox.y + composite.bbox.height * 0.5;
    if (aboveLine) {
      positionScore = 0.8;
      reasons.push("above_signature_line");
    } else if (lineYs.length > 0) {
      positionScore = 0.2;
      reasons.push("below_signature_line");
    }

    // Rule 2: 旋转（尊重 rotation.confidence）
    let rotationScore = 0.5;
    if (
      rotation.angle !== undefined &&
      Math.abs(rotation.angle) > 0.5 &&
      (rotation.confidence ?? 0) >= 0.5
    ) {
      rotationScore = 0.7;
      reasons.push(`rotated_${rotation.angle.toFixed(1)}deg_conf_${rotation.confidence.toFixed(2)}`);
    } else if (rotation.angle !== undefined && (rotation.confidence ?? 0) < 0.5) {
      reasons.push(`rotation_ignored_low_conf_${rotation.confidence.toFixed(2)}`);
    }

    // Rule 3: 颜色对比度
    const contrastScore = pixelContrastScore(seg.bbox, imageData, cssScale, zoneCx, zoneCy);
    reasons.push(`contrast_${contrastScore.toFixed(2)}`);

    // Rule 4: 墨水重叠
    const inkOverlap = imageInkOverlapRatio(seg.bbox, imageData, cssScale, zoneCx, zoneCy);
    if (inkOverlap > 0.5) {
      reasons.push(`inkOverlap_${inkOverlap.toFixed(2)}`);
    }

    const oldStampScore =
      (1 - positionScore) * 0.35 +
      rotationScore * 0.25 +
      (1 - contrastScore) * 0.25 +
      inkOverlap * 0.15;

    const oldPrintedScore =
      positionScore * 0.35 +
      (1 - rotationScore) * 0.25 +
      contrastScore * 0.25 +
      (1 - inkOverlap) * 0.15;

    return { seg, reasons, oldStampScore, oldPrintedScore };
  });

  // ── Pass 2: 跨 segment 语义重复 + 最终决策 ──
  return perSegmentScores.map(({ seg, reasons, oldStampScore, oldPrintedScore }) => {
    const isDup = dupBlockIds.has(seg.sourceBlockIds[0] ?? "");

    // 签名横线直接判定
    if (seg.type === "signature-line") {
      reasons.push(`oldStamp_${oldStampScore.toFixed(3)}`);
      return {
        id: seg.id,
        type: "signature_line" as SignatureSegmentType,
        confidence: 0.9,
        bbox: { ...seg.bbox },
        sourceBlockIds: [...seg.sourceBlockIds],
        text: seg.text,
        action: "keep" as const,
        reasons: [...reasons, "final=line"],
      };
    }

    // ── duplicateTextScore：语义重复证据 ──
    const dupNormText = normalizeStampText(seg.text ?? "");
    const dupCRMs = extractCRMNums(seg.text ?? "");
    let bestNameSim = 0;
    let bestCSim = 0;
    for (const ref of editableNormTexts) {
      if (!ref.norm) continue;
      const nameSim = textSimilarity(dupNormText, ref.norm);
      let crmSim = 0;
      for (const dc of dupCRMs) {
        for (const rc of ref.crms) {
          if (dc === rc) crmSim = Math.max(crmSim, 1.0);
          else if (dc.includes(rc) || rc.includes(dc)) crmSim = Math.max(crmSim, 0.85);
        }
      }
      bestNameSim = Math.max(bestNameSim, nameSim);
      bestCSim = Math.max(bestCSim, crmSim);
    }
    // 综合语义相似度：姓名 0.7 + CRM 0.3
    const duplicateTextScore =
      bestNameSim > 0 ? bestNameSim * 0.7 + bestCSim * 0.3 : 0;
    if (duplicateTextScore > 0.5) {
      reasons.push(`dupText_${duplicateTextScore.toFixed(3)}`);
    } else {
      reasons.push(`dupText_0`);  // 无参照物
    }

    // ── belowLineScore：空间位置 ──
    let belowLineScore = 0;
    if (lineYs.length > 0) {
      const lowestLine = Math.max(...lineYs);
      const segCenterY = seg.bbox.y + seg.bbox.height / 2;
      if (segCenterY > lowestLine) {
        belowLineScore = 1.0;
        reasons.push("below_line");
      }
    }

    // ── finalStampScore：加权融合 ──
    const finalStampScore =
      oldStampScore * 0.4 +
      duplicateTextScore * 0.4 +
      belowLineScore * 0.2;

    reasons.push(`oldStamp_${oldStampScore.toFixed(3)}`);
    reasons.push(`finalStamp_${finalStampScore.toFixed(3)}`);

    // ── 决策（Sprint 31.3.1 高阈值） ──
    let type: SignatureSegmentType;
    let confidence: number;
    let action: "keep" | "mask";

    if (!isDup && !seg.text) {
      type = "artifact";
      confidence = 0.4;
      action = "mask";
    } else if (finalStampScore > 0.85) {
      type = "stamp_text";
      confidence = finalStampScore;
      action = "mask";
    } else if (finalStampScore > 0.65) {
      // review 区间：有重复证据 → 仍判 stamp_text 但置信度打问号
      type = "stamp_text";
      confidence = finalStampScore;
      action = "mask";
      reasons.push("review_zone");
    } else {
      type = "printed_text";
      confidence = 1 - finalStampScore;
      action = "keep";
    }

    return {
      id: seg.id,
      type,
      confidence,
      bbox: { ...seg.bbox },
      sourceBlockIds: [...seg.sourceBlockIds],
      text: seg.text,
      action,
      reasons,
    };
  });
}

// ────────────────────────────────────────────────────────────
// Sprint 31.3.1: 文本规范化 + 语义相似度工具
// ────────────────────────────────────────────────────────────

/**
 * 规范化签章文本用于对比。
 * 去掉称呼、CRM 标签、标点、空格、重音 → 小写纯字母数字串。
 *
 *   "Dr. Jefferson Aguiar Maciel" → "jeffersonaguiarmaciel"
 *   "JEFERSON AGUIAR MACIEL"     → "jeffersonaguiarmaciel"
 *   "CRM-SP 269473"              → "sp269473"
 */
export function normalizeStampText(text: string): string {
  if (!text) return "";
  return text
    .replace(/\b(Dr|Dra)(\.)?\b/gi, "")
    .replace(/\bcrm[:\-\s]*/gi, "")
    .replace(/[:.\-\(\)\/\\,]/g, " ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "");
}

/**
 * 从文本中提取所有 4 位以上连续数字（CRM 号等）。
 */
export function extractCRMNums(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/\d{4,}/g);
  return matches ?? [];
}

/**
 * 字符级 trigram Jaccard 相似度。
 * 完全匹配 → 1.0，子串包含 → 0.9。
 */
export function textSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1.0;
  if (a.length < 3 || b.length < 3) {
    return a.includes(b) || b.includes(a) ? 0.9 : 0;
  }
  if (a.includes(b) || b.includes(a)) return 0.9;

  const tA = new Set<string>();
  const tB = new Set<string>();
  for (let i = 0; i + 2 < a.length; i++) tA.add(a.slice(i, i + 3));
  for (let i = 0; i + 2 < b.length; i++) tB.add(b.slice(i, i + 3));

  const intersection = new Set([...tA].filter((x) => tB.has(x)));
  const union = new Set([...tA, ...tB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

/**
 * 规则 3: 像素对比度评分
 *
 * 在 bbox 区域内采样像素亮度，计算对比度。
 * 高对比度（黑白分明） → 1.0（printed text）
 * 低对比度（灰色模糊）→ 0.0（stamp text）
 */
export function pixelContrastScore(
  bbox: BBox,
  imageData: ImageData,
  cssScale: number,
  zoneCx: number,
  zoneCy: number,
): number {
  const { data, width: iw, height: ih } = imageData;

  // CSS → zone-local canvas
  const x1 = Math.max(0, Math.round(bbox.x / cssScale) - zoneCx);
  const y1 = Math.max(0, Math.round(bbox.y / cssScale) - zoneCy);
  const x2 = Math.min(iw, Math.round((bbox.x + bbox.width) / cssScale) - zoneCx);
  const y2 = Math.min(ih, Math.round((bbox.y + bbox.height) / cssScale) - zoneCy);

  if (x2 <= x1 || y2 <= y1) return 0.5;

  const grays: number[] = [];
  for (let row = y1; row < y2; row++) {
    for (let col = x1; col < x2; col++) {
      const idx = (row * iw + col) * 4;
      const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      grays.push(gray);
    }
  }

  if (grays.length === 0) return 0.5;

  // 计算对比度: (max - min) / 255
  let minG = 255;
  let maxG = 0;
  for (const g of grays) {
    if (g < minG) minG = g;
    if (g > maxG) maxG = g;
  }

  const contrast = (maxG - minG) / 255;
  // 对比度 ≥ 0.55 → 接近 1.0（printed）；< 0.25 → 接近 0.0（stamp）
  return Math.min(1, Math.max(0, (contrast - 0.25) / 0.3));
}

/**
 * 规则 4: 图片墨水重叠比例
 *
 * 判断 bbox 内非背景像素（灰度 < 200 或不是纯白）的比例。
 * 高 overlap → 图片中该区域有较多墨迹 → stamp/signature
 */
export function imageInkOverlapRatio(
  bbox: BBox,
  imageData: ImageData,
  cssScale: number,
  zoneCx: number,
  zoneCy: number,
): number {
  const { data, width: iw, height: ih } = imageData;

  const x1 = Math.max(0, Math.round(bbox.x / cssScale) - zoneCx);
  const y1 = Math.max(0, Math.round(bbox.y / cssScale) - zoneCy);
  const x2 = Math.min(iw, Math.round((bbox.x + bbox.width) / cssScale) - zoneCx);
  const y2 = Math.min(ih, Math.round((bbox.y + bbox.height) / cssScale) - zoneCy);

  if (x2 <= x1 || y2 <= y1) return 0;

  const totalPixels = (y2 - y1) * (x2 - x1);
  if (totalPixels === 0) return 0;

  let inkPixels = 0;
  for (let row = y1; row < y2; row++) {
    for (let col = x1; col < x2; col++) {
      const idx = (row * iw + col) * 4;
      const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      if (gray < 200) inkPixels++;
    }
  }

  return inkPixels / totalPixels;
}

// ────────────────────────────────────────────────────────────
// 横向黑线检测
// ────────────────────────────────────────────────────────────

interface DetectedLineRegion {
  /** zone 内 canvas y 起始 */
  startRow: number;
  /** zone 内 canvas y 结束（不含） */
  endRow: number;
  /** zone 内 canvas x 起始 */
  startCol: number;
  /** zone 内 canvas x 结束（不含） */
  endCol: number;
}

/**
 * 在 ImageData 中检测横向黑线。
 *
 * 算法：
 *   - 按行扫描，寻找连续暗像素段
 *   - 暗像素段长度 > LINE_MIN_LENGTH → 该行有一个"线段"
 *   - 将连续行中位置相近的线段合并为一个区域
 *   - 区域高度 ≤ LINE_MAX_HEIGHT → 确认为横线
 *
 * 返回 CSS 坐标下的 SignatureSubRegion[]。
 */
function detectHorizontalLines(
  imageData: ImageData,
  zoneCx: number,
  zoneCy: number,
  cssScale: number,
  parentId: string,
): SignatureSubRegion[] {
  const { data, width, height } = imageData;

  // Step 1: 按行检测暗像素段
  const rowSegments: Array<{ row: number; startCol: number; endCol: number }> = [];

  for (let r = 0; r < height; r++) {
    let inRun = false;
    let runStart = 0;

    for (let c = 0; c < width; c++) {
      const idx = (r * width + c) * 4;
      const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      const isDark = gray < DARK_THRESHOLD;

      if (isDark && !inRun) {
        inRun = true;
        runStart = c;
      } else if (!isDark && inRun) {
        inRun = false;
        const runLen = c - runStart;
        if (runLen >= LINE_MIN_LENGTH) {
          rowSegments.push({ row: r, startCol: runStart, endCol: c });
        }
      }
    }

    // 行尾 run
    if (inRun) {
      const runLen = width - runStart;
      if (runLen >= LINE_MIN_LENGTH) {
        rowSegments.push({ row: r, startCol: runStart, endCol: width });
      }
    }
  }

  if (rowSegments.length === 0) return [];

  // Step 2: 将相邻行重叠的线段合并为区域
  const regions: DetectedLineRegion[] = [];
  let currentSegments = [rowSegments[0]];

  for (let i = 1; i < rowSegments.length; i++) {
    const prev = rowSegments[i - 1];
    const curr = rowSegments[i];

    // 检查是否相邻行且水平重叠
    if (curr.row === prev.row + 1 && segmentsOverlap(prev, curr)) {
      currentSegments.push(curr);
    } else {
      // 结束当前区域
      if (currentSegments.length <= LINE_MAX_HEIGHT) {
        const region = mergeSegments(currentSegments);
        regions.push(region);
      }
      currentSegments = [curr];
    }
  }

  // 最后一个区域
  if (currentSegments.length <= LINE_MAX_HEIGHT) {
    const region = mergeSegments(currentSegments);
    regions.push(region);
  }

  // Step 3: 转换为 SignatureSubRegion（CSS 坐标）
  return regions.map((r, idx) => {
    // zone-local canvas coords → canvas global coords → CSS coords
    const cssX = (r.startCol + zoneCx) * cssScale;
    const cssY = (r.startRow + zoneCy) * cssScale;
    const cssW = (r.endCol - r.startCol) * cssScale;
    const cssH = (r.endRow - r.startRow) * cssScale;

    return {
      id: `sub_line_${parentId}_${idx}`,
      type: "signature-line" as SignatureSubRegionType,
      bbox: {
        x: cssX,
        y: cssY,
        width: Math.max(1, cssW),
        height: Math.max(1, cssH),
      },
      sourceBlockIds: [],
      text: `line_${idx}`,
      confidence: 0.8,
    };
  });
}

/** 两个相邻行线段是否水平重叠 */
function segmentsOverlap(
  a: { startCol: number; endCol: number },
  b: { startCol: number; endCol: number },
): boolean {
  return a.startCol < b.endCol && b.startCol < a.endCol;
}

/** 合并多行线段为一个区域 */
function mergeSegments(
  segments: Array<{ row: number; startCol: number; endCol: number }>,
): DetectedLineRegion {
  let minCol = Infinity;
  let maxCol = -Infinity;
  let minRow = Infinity;
  let maxRow = -Infinity;

  for (const seg of segments) {
    if (seg.row < minRow) minRow = seg.row;
    if (seg.row > maxRow) maxRow = seg.row;
    if (seg.startCol < minCol) minCol = seg.startCol;
    if (seg.endCol > maxCol) maxCol = seg.endCol;
  }

  return {
    startRow: minRow,
    endRow: maxRow + 1,
    startCol: minCol,
    endCol: maxCol,
  };
}
