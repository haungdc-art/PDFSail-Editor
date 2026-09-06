/**
 * anchor.ts — DOM Anchor / Region 类型（Sprint-120 · Phase 1）
 *
 * ADR-045：Header/Footer 不是对象类型，是位置（Position）。
 * 真正决定对象归属的是 `editable`，而不是它出现在页面的哪个区域。
 * 因此 Anchor 只描述"对象落在页面的哪个位置/区域"，与对象的可编辑性完全解耦。
 *
 * 本文件是 Document Object Model（DOM）的一部分，**不 import EditableDocument**。
 * 纯类型 + 纯函数（ADR-005），Node 可测。
 */

/** 页面位置锚点（相对页边） */
export type Anchor =
  | "TOP"
  | "BOTTOM"
  | "LEFT"
  | "RIGHT"
  | "TOP_LEFT"
  | "TOP_RIGHT"
  | "BOTTOM_LEFT"
  | "BOTTOM_RIGHT"
  | "CENTER"
  | "NONE";

/** 页面语义区域（面向用户的版面区域） */
export type Region =
  | "HEADER"
  | "BODY"
  | "FOOTER"
  | "LEFT_MARGIN"
  | "RIGHT_MARGIN"
  | "FULL_PAGE"
  | "UNKNOWN";

/** Anchor 全集（用于校验合法值） */
export const ANCHOR_VALUES: readonly Anchor[] = [
  "TOP", "BOTTOM", "LEFT", "RIGHT",
  "TOP_LEFT", "TOP_RIGHT", "BOTTOM_LEFT", "BOTTOM_RIGHT",
  "CENTER", "NONE",
];

/** Region 全集 */
export const REGION_VALUES: readonly Region[] = [
  "HEADER", "BODY", "FOOTER", "LEFT_MARGIN", "RIGHT_MARGIN", "FULL_PAGE", "UNKNOWN",
];

/** 是否为合法 Anchor */
export function isAnchor(v: unknown): v is Anchor {
  return typeof v === "string" && (ANCHOR_VALUES as readonly string[]).includes(v);
}

/** 是否为合法 Region */
export function isRegion(v: unknown): v is Region {
  return typeof v === "string" && (REGION_VALUES as readonly string[]).includes(v);
}

/** 根据 bbox 与页面尺寸推断 Anchor（几何启发，第一版） */
export function inferAnchorFromBBox(
  bbox: { x: number; y: number; width: number; height: number },
  page: { width: number; height: number },
): Anchor {
  const { x, y, width, height } = bbox;
  const cx = x + width / 2;
  const cy = y + height / 2;
  const left = cx < page.width * 0.3;
  const right = cx > page.width * 0.7;
  const top = cy < page.height * 0.3;
  const bottom = cy > page.height * 0.7;

  if (top && left) return "TOP_LEFT";
  if (top && right) return "TOP_RIGHT";
  if (bottom && left) return "BOTTOM_LEFT";
  if (bottom && right) return "BOTTOM_RIGHT";
  if (top) return "TOP";
  if (bottom) return "BOTTOM";
  if (left) return "LEFT";
  if (right) return "RIGHT";
  return "CENTER";
}
