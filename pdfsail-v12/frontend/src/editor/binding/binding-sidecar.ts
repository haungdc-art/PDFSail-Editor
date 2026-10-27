/**
 * F3B-6.12 — Binding Sidecar（immutable PDF fidelity snapshot）
 *
 * ── 语义（F3B-6.10 / 6.10A / 6.11 / 6.12A 冻结）───────────────────
 *   · **import-time**：只在真正 import 时构建一次
 *   · **immutable**：构建后 freeze，只读
 *   · **per-import**：随 document generation 生死，re-import 必换新实例
 *   · **PDF-fidelity only**：不承载 editable / history / render / Core 语义
 *
 * 明确**不**包含（前序审计已排除）：
 *   current bbox · modified · editedLineBoxes · selection/caret
 *   · Core paragraph/run text · generated glyph · History state · glyph ID
 *
 * 本模块**不**依赖 `EditableDocument` —— Sidecar 是 snapshot，不是 document model。
 */

import type {
  BBox,
  GlyphFontIdentity,
  GlyphMetrics,
  TransformMatrix,
} from "../../document-model/types";

/** 行级渲染源（与 EditableLine.source 同枚举） */
export type SidecarRenderSource = "vector" | "image" | "image-ocr";

/** 该 Sidecar 由哪个 capture entry point 产出（6.12A：两个入口、同一类型） */
export type SidecarOrigin = "pdf-native" | "ocr";

/**
 * 原文 glyph 的 immutable 记录。
 *
 * `sourceBBox` = **import-time `glyph.bbox`**（正式语义名）。
 * 不使用 legacy `originalBBox` 名称 —— 该字段在 import-time 并不存在（6.9/6.12A）。
 */
export interface OriginalGlyph {
  /** import-time 行内下标（glyph position；非 glyph ID） */
  index: number;
  /** import-time glyph.bbox（pdf-native = 真实；OCR = Layout 估算） */
  sourceBBox: BBox;
  /** OCR / 布局估算几何 → true（不得当真实原文几何使用） */
  geometryEstimated?: boolean;

  originalChar?: string;

  operatorId?: string;
  operatorCharIndex?: number;
  /** operator provenance 不可用（UNKNOWN）⇒ 导出绝不能删除对应原算子 */
  provenanceUnknown?: boolean;

  metrics?: GlyphMetrics;
  pdfCharCode?: number;
  fontIdentity?: GlyphFontIdentity;
  transform?: TransformMatrix;
  baseline?: number;
}

/** inclusive glyph 区间 */
export type GlyphRange = [start: number, end: number];

export interface LineBinding {
  blockId: string;
  lineId: string;
  /** import-time 行序（T2 邻行保护需要 prev/next） */
  lineIdx: number;
  renderSource: SidecarRenderSource;
  /** renderSource 为推导值而非 detector 检测值（OCR ⇒ image-ocr，6.12A） */
  renderSourceDerived?: boolean;
  /** import-time line.bbox */
  originalLineBBox?: BBox;
  /** 原文 glyph 序列（按 import-time 下标有序，immutable） */
  originalGlyphs: OriginalGlyph[];
  /** split 派生的别名（不复制原文序列） */
  aliasOf?: { blockId: string; lineId: string; range: GlyphRange };
}

export interface BlockBinding {
  blockId: string;
  /**
   * 原文遮盖区域（OCR = 真实检测框；pdf-native = import-time `block.originalBounds`）。
   *
   * ⚠️ 该字段可能承载**非检测值**（builder 在 `originalBounds` 缺失时会记录 `block.bbox`）。
   * 因此**消费方必须同时检查 `blockOriginalBoundsDetected`**，不得直接当作真实 PDF 检测框使用。
   */
  blockOriginalBounds?: BBox;
  /**
   * F3B-6.17 3B'-B：`blockOriginalBounds` 是否为**真实检测**值（**required**，3B'-B.2 冻结）。
   *
   * - `true`  → import-time 确实存在 `block.originalBounds`（真实 PDF 检测框）
   * - `false` → import-time 确实不存在；`blockOriginalBounds` 只是 `block.bbox` 回退值
   *
   * 这是 eligibility 的**事实字段**，不是兼容字段：
   * Sidecar 在 import lifecycle 内生成、构建后即 immutable，因此「字段缺失」不构成合法状态。
   * 导出侧一律以 `detected !== true` fail-closed，**绝不把 bbox 冒充 originalBounds**。
   */
  blockOriginalBoundsDetected: boolean;
}

export interface BindingSidecar {
  /** document generation identity（与 Core document 世代一致） */
  generation: number;
  /** 产出入口（两个 builder 共用本类型，不建立第二套模型） */
  origin: SidecarOrigin;
  /**
   * F3B-6.17 3B'-A：page-level PDF MediaBox Y-origin（import 时捕获，immutable）。
   * 语义 = `page.view?.[1]`，**不是**页面布局计算值，也不由 Core Layout 推导。
   * 不可得时该页 `originYPt === undefined` → Core export 对该页 fail closed。
   */
  pages?: Readonly<Record<number, { originYPt?: number }>>;
  /** key = `${blockId}|${lineId}` —— 主 key 只到 (blockId, lineId)；range 是查询参数 */
  lines: Readonly<Record<string, LineBinding>>;
  blocks: Readonly<Record<string, BlockBinding>>;
  /** freeze 标记 */
  frozen: boolean;
}

// ─────────────────────────────────────────────────────────────────────
//  Key
// ─────────────────────────────────────────────────────────────────────

/** 主 key：`(blockId, lineId)`。range **不是** key 的一部分（6.10A 冻结）。 */
export function sidecarLineKey(blockId: string, lineId: string): string {
  return `${blockId}|${lineId}`;
}

// ─────────────────────────────────────────────────────────────────────
//  Freeze（build → freeze → read only）
// ─────────────────────────────────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/**
 * 冻结 Sidecar（幂等）。
 *
 * 冻结后：对象 / 数组 / 记录均不可写（ESM 为严格模式，写入抛 TypeError）。
 */
export function freezeSidecar(sidecar: BindingSidecar): BindingSidecar {
  if (sidecar.frozen) return sidecar;
  return deepFreeze({ ...sidecar, frozen: true });
}

// ─────────────────────────────────────────────────────────────────────
//  Lookup（read-only 查询语义；range 为查询参数）
// ─────────────────────────────────────────────────────────────────────

/** 取行绑定；未命中返回 undefined（fail-closed，由调用方退化到 block 级） */
export function lookupLineBinding(
  sidecar: BindingSidecar,
  blockId: string,
  lineId: string
): LineBinding | undefined {
  return sidecar.lines[sidecarLineKey(blockId, lineId)];
}

export function lookupBlockBinding(
  sidecar: BindingSidecar,
  blockId: string
): BlockBinding | undefined {
  return sidecar.blocks[blockId];
}

/**
 * 解析 split 别名链（6.10A Case C：`(B,L2) → aliasOf (B,L1, range)`）。
 * 返回最终承载原文序列的条目 + 该条目的有效区间。
 */
function resolveAlias(
  sidecar: BindingSidecar,
  binding: LineBinding,
  depth = 0
): { binding: LineBinding; range?: GlyphRange } | undefined {
  if (depth > 8) return undefined; // 防环
  if (!binding.aliasOf) return { binding };
  const origin = lookupLineBinding(sidecar, binding.aliasOf.blockId, binding.aliasOf.lineId);
  if (!origin) return undefined;
  return resolveAlias(sidecar, origin, depth + 1) ?? undefined;
}

/**
 * 查询原文 glyph 区间（inclusive）。
 *
 * - 不给 range → 返回该行**完整**原始序列（Core split 场景的正确语义，6.10A）
 * - 给 range   → 与别名区间求交后返回子集
 */
export function lookupGlyphRange(
  sidecar: BindingSidecar,
  blockId: string,
  lineId: string,
  range?: GlyphRange
): OriginalGlyph[] {
  const direct = lookupLineBinding(sidecar, blockId, lineId);
  if (!direct) return [];

  let target = direct;
  let aliasRange: GlyphRange | undefined;
  if (direct.aliasOf) {
    const resolved = resolveAlias(sidecar, direct);
    if (!resolved) return [];
    target = resolved.binding;
    aliasRange = direct.aliasOf.range;
  }

  const glyphs = target.originalGlyphs;
  let start = 0;
  let end = glyphs.length - 1;
  if (aliasRange) {
    start = Math.max(0, aliasRange[0]);
    end = Math.min(glyphs.length - 1, aliasRange[1]);
  }
  if (range) {
    start = Math.max(start, Math.max(0, range[0]));
    end = Math.min(end, Math.min(glyphs.length - 1, range[1]));
  }
  if (end < start) return [];
  return glyphs.slice(start, end + 1);
}
