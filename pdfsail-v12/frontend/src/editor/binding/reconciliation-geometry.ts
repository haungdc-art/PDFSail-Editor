/**
 * F3B-6.14-B — Reconciliation Geometry（共享几何算法）
 *
 * 目的：证明 6.14 改变的是 **geometry source**，而不是 **mask algorithm**。
 *
 * 本函数是 `PDFEditor.markLineEdited`（L823-898 + L1079-1088）内部几何算法的
 * **纯函数化复刻**，供两条路径共用：
 *
 *   Legacy source  → Legacy adapter      → calculateReconciliationGeometry()
 *   Core + Sidecar → Core/Binding adapter → calculateReconciliationGeometry()
 *
 * ⚠️ 本轮**不修改** `markLineEdited`（编辑态核心代码极脆弱，避免同一轮同时改
 *    source 与 algorithm）。legacy 路径继续使用它既有实现；两条实现的等价性由
 *    `reconciliation-production-switch.test.ts` 的 legacy-parity 测试锁定。
 */

import type { BBox } from "../../document-model/types";

/**
 * 方向性 mask 补偿（M7.7-054）：仅向下扩展，避免侵占上一行。
 * 必须与 `PDFEditor.markLineEdited` L1080 的常量保持一致 —— 由 source guard 测试锁定。
 */
export const MASK_INK_PADDING = { top: 0, bottom: 3, left: 1, right: 1 } as const;

export interface ReconciliationGeometryInput {
  /** 原始几何：Sidecar 的 `originalLineBBox` */
  originalLineBBox?: BBox;
  /**
   * 原始/当前几何：逐 glyph。
   *   · Core 路径：`sourceBBox`（Sidecar 原文）
   *   · Legacy 路径：`sourceBBox` = glyph.originalBBox、`currentBBox` = glyph.bbox
   * 两者共用**同一**并集实现。
   */
  originalGlyphs?: ReadonlyArray<{ sourceBBox?: BBox; currentBBox?: BBox }>;
  /** 当前几何：Core Layout */
  currentGeometry?: BBox;
  /** 额外墨迹盒（OCR canvas 扫描 / 被删 glyph 并集） */
  extraInkBox?: BBox | null;
}

function unionInto(
  acc: { minX: number; minY: number; maxX: number; maxY: number },
  box: BBox | undefined | null
): void {
  if (!box) return;
  acc.minX = Math.min(acc.minX, box.x);
  acc.minY = Math.min(acc.minY, box.y);
  acc.maxX = Math.max(acc.maxX, box.x + box.width);
  acc.maxY = Math.max(acc.maxY, box.y + box.height);
}

function toBox(acc: {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}): BBox | null {
  if (!Number.isFinite(acc.minX) || !Number.isFinite(acc.minY)) return null;
  return { x: acc.minX, y: acc.minY, width: acc.maxX - acc.minX, height: acc.maxY - acc.minY };
}

/**
 * 计算 reconciliation 几何（**未**加 padding）。
 *
 * 复刻 markLineEdited 的语义：
 *   1. currentBox = 受影响 glyph 的「原始位置 ∪ 当前位置」并集
 *   2. 与 originalLineBBox 做**纵向**并集（横向不并，避免 mask 横跨整行）
 *   3. 并入 extraInkBox
 */
export function calculateReconciliationGeometry(
  input: ReconciliationGeometryInput
): BBox | null {
  const { originalLineBBox, originalGlyphs, currentGeometry, extraInkBox } = input;

  // ① 原始 ∪ 当前
  const acc = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
  for (const glyph of originalGlyphs ?? []) {
    unionInto(acc, glyph.sourceBBox);
    unionInto(acc, glyph.currentBBox);
  }
  unionInto(acc, currentGeometry);
  let currentBox = toBox(acc);

  // ② 与 originalLineBBox 纵向并集（x / width 取自 currentBox）
  if (originalLineBBox) {
    if (currentBox) {
      const minY = Math.min(originalLineBBox.y, currentBox.y);
      const maxY = Math.max(
        originalLineBBox.y + originalLineBBox.height,
        currentBox.y + currentBox.height
      );
      currentBox = { x: currentBox.x, y: minY, width: currentBox.width, height: maxY - minY };
    } else {
      currentBox = { ...originalLineBBox };
    }
  }

  if (!currentBox) return null;

  // ③ 并入 extraInkBox
  if (extraInkBox) {
    const final = {
      minX: currentBox.x,
      minY: currentBox.y,
      maxX: currentBox.x + currentBox.width,
      maxY: currentBox.y + currentBox.height,
    };
    unionInto(final, extraInkBox);
    return toBox(final);
  }

  return currentBox;
}

/** M7.7-054 方向性 padding（仅向下扩展） */
export function applyMaskPadding(box: BBox): BBox {
  return {
    x: box.x - MASK_INK_PADDING.left,
    y: box.y - MASK_INK_PADDING.top,
    width: box.width + MASK_INK_PADDING.left + MASK_INK_PADDING.right,
    height: box.height + MASK_INK_PADDING.top + MASK_INK_PADDING.bottom,
  };
}

/** 便利函数：几何 + padding（等价于 markLineEdited 写入 `editedLineBoxes` 的盒） */
export function reconciliationRenderBox(input: ReconciliationGeometryInput): BBox | null {
  const box = calculateReconciliationGeometry(input);
  return box ? applyMaskPadding(box) : null;
}
