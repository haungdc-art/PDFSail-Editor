/**
 * editing-unit-surface.ts — F3B-6.27 · **P0-C · 只读 editing surface 桥**（纯函数）
 *
 * ── 为什么不是"再造一个 surface" ──────────────────────────────────────
 * Step 1 的 `core-editing-surface-geometry.ts` **已经**实现了跨 paragraph 的
 * 只读 surface 几何（union box / textIndent / requiredWidth / synthetic `\n`）。
 * 若 P0-C 再写一份几何，就制造了**第二套几何真值** —— 正是本项目反复踩过的坑。
 * 故 P0-C 的职责收窄为**桥**：
 *
 *   EditingUnit（身份 / ownership / unit 坐标 / 显式 separator）
 *        ⇅  必须逐字节对齐
 *   既有 Core surface（几何 / domToCore）
 *
 * ── 本桥证明的 mechanical claim（P0-C 的全部内容）────────────────────
 *   ① 既有几何对同一份真实数据的 `text` 与 `unit.text` **逐字节相同**
 *   ② 既有几何的每条 `domStart/domEnd` 与 `unit` 的 `startUtf16/endUtf16` **完全相等**
 *   ③ 一个 surface 可覆盖**多个 TextBox**（L5/L6 各自保留自己的 textBoxId）——
 *      这正是"不合并"的几何体现
 *   ④ offset → Core 的映射**只有一处真值**（`editing-unit.ts`），本模块只委托、不重写
 *
 * ── ★ 口径裁决（真实存在的差异，必须钉死）──────────────────────────
 *   `offset` 落在 **separator 起点**（= 前一行的 `endUtf16`，本例 32）时：
 *
 *     · EditingUnit（P0-A，真实浏览器踩坑后定案）⇒ 判为**该行末尾**（`kind:"line"`）
 *       理由：行内替换若被判成跨分隔，会连带把一次普通编辑误判为跨行编辑。
 *     · 既有 Step 1 surface ⇒ 判为 `paragraph-boundary`
 *       （半开区间 `[domStart, domEnd)` 把 `\n` 本身包住，见其源码注释）
 *
 *   ⇒ **P0-C 裁决：以 EditingUnit 为准**（③ 行末优先），本模块的映射一律**委托**
 *     `unitOffsetToParagraphOffset`，不复制 boundary 规则。
 *     既有 surface 的 `domToCore` 区间（几何/文本对齐用）仍被完整保留，
 *     但**不作为 offset 归属的权威**。两者的差异点在
 *     `SURFACE_BOUNDARY_DIVERGENCE` 中显式登记，供 P0-C 消费方查阅。
 *
 * ── 硬边界（P0-C 冻结）──────────────────────────────────────────────
 *   · 0 生产接线：不改 PDFEditor / EditableTextNode / PDFCanvas / Core
 *   · 0 mutation：不构造、不执行任何 Core Command；不碰 history
 *   · 0 DOM / React / 坐标测量：几何只来自调用方给的 Core layout 结果
 *   · 0 第二套几何：union / indent / requiredWidth 一律**委托**既有 Step 1 实现
 *   · 0 自动语义段落：surface 由**显式** EditingUnit 决定，不猜哪些行该合并
 */

import {
  createCoreEditingSurface,
  coreEditingSurfaceDomLength,
  type CoreEditingSurface,
  type SurfaceRect,
} from "./core-editing-surface-geometry";
import {
  unitOffsetToParagraphOffset,
  unitRangeOfLine,
  type EditingUnit,
} from "./editing-unit";

/** 每条 line 的真实 Core 几何（由调用方从 `layoutTextBox` 结果取出） */
export interface UnitLineGeometryInput {
  readonly lineId: string;
  /**
   * Core layout 的**行盒**（`ParagraphLayout.lines[i].box`）。
   *
   * ⚠️ 只接受行盒，不接受段落盒 —— visual-line 粒度下二者数值一致
   *   （实测 L5/L6 的 `line.box.x` 与 `paragraphBox.x` 相同），但行盒才是渲染真值；
   *   接受两种会让"缩进"出现两个口径。
   * ⚠️ 软折行（一个 paragraph 多行）**不属于本模块的域**：EditingUnit 的每条 line
   *   都对应独立的 paragraph / TextBox（见 editing-unit.ts 不变量 I2）。
   *   软折行是既有 Step 1 surface 的另一域，不要混用。
   */
  readonly box: SurfaceRect;
}

export interface CreateUnitSurfaceInput {
  readonly unit: EditingUnit;
  readonly geometries: readonly UnitLineGeometryInput[];
  /** Core document generation（陈旧 Core mutation 不得建面） */
  readonly generation: number;
  readonly currentGeneration: number;
}

export type UnitSurfaceFailure =
  | "stale-generation"
  | "no-unit"
  | "empty-unit"
  | "geometry-count-mismatch"
  | "unknown-line-geometry"
  | "duplicate-line-geometry"
  | "missing-line-geometry"
  | "line-order-mismatch"
  | "text-mismatch"
  | "offset-mismatch";

export type CreateUnitSurfaceOutcome =
  | { readonly ok: true; readonly surface: EditingUnitSurface; readonly divergence: BoundaryDivergence }
  | { readonly ok: false; readonly reason: UnitSurfaceFailure };

/** 一条 line 在 surface 中的 ownership（**不合并**：各行保留自己的 TextBox/paragraph） */
export interface UnitSurfaceOwnership {
  readonly lineId: string;
  readonly textBoxId: string;
  readonly paragraphId: string;
  readonly domStart: number;
  readonly domEnd: number;
  readonly box: SurfaceRect;
  /** 相对 surface 左边的缩进（供 DOM `text-indent` 逐行定位；仅首行由 CSS 表达） */
  readonly textIndent: number;
}

/**
 * 边界口径差异登记（**只读记录，不修**）。
 * 记录在哪个 offset 上、Step 1 surface 与 EditingUnit 会给出不同归属。
 */
export interface BoundaryDivergence {
  readonly kind: "paragraph-boundary";
  readonly domOffset: number;
  readonly step1Kind: "paragraph-boundary";
  readonly editingUnitKind: "line";
  /** 该 offset 归属的行（EditingUnit 口径） */
  readonly lineId: string;
  readonly paragraphId: string;
  /** true ⇒ P0-C 裁决生效：以 EditingUnit 为准 */
  readonly resolvedByEditingUnit: true;
}

export interface EditingUnitSurface {
  readonly unitId: string;
  readonly kind: EditingUnit["kind"];
  /** 与 `unit.text` 逐字节相同（本桥的核心不变量） */
  readonly text: string;
  readonly domLength: number;
  /** 行盒 union（委托既有 Step 1 几何，非本模块自算） */
  readonly box: SurfaceRect;
  /** 首行缩进（悬挂缩进；供 CSS `text-indent`） */
  readonly firstLineIndent: number;
  /** 编辑面最小宽度（≥ 每一行宽，防浏览器额外折行） */
  readonly requiredWidth: number;
  /** 逐行 ownership（每行各自的 textBoxId / paragraphId / 区间 / 缩进） */
  readonly ownership: readonly UnitSurfaceOwnership[];
  /** 本 surface 覆盖的 TextBox 集合（**多个** ⇒ 证明未合并） */
  readonly textBoxIds: readonly string[];
  /** 供 P0-D 使用的既有几何映射（区间口径，与 unit 对齐已验证） */
  readonly coreSurface: CoreEditingSurface;
  readonly generation: number;
}

/** 有效几何：Step 1 的 `isUsableRect` 口径在导出后不可复用，这里独立做**只读校验**
 *
 *  ★ R3：与 P0-C 的 `lineGeometryKind` **同口径**（否则外层会先于 P0-C 拒绝空行）——
 *    `width === 0 && height > 0` = **empty-line**（空 paragraph 的真实 Core layout 事实：
 *    零墨迹宽、垂直几何完整），**合法**；`height === 0` / 非有限 / 负宽仍 fail-closed。
 *    ⚠️ 语义与 P0-C 一致：empty-line 参与 union / coreBottom，不参与 requiredWidth。
 */
function usableRect(b: SurfaceRect | undefined | null): b is SurfaceRect {
  if (!b) return false;
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return false;
  if (!Number.isFinite(b.width) || !Number.isFinite(b.height)) return false;
  if (b.height <= 0) return false; // 无垂直几何 ⇒ 不可用
  return b.width >= 0; // width === 0 ⇒ empty-line（合法）
}

/**
 * 把 EditingUnit 接到既有只读 surface 几何上。**fail-closed**：
 * 任何与既有几何不一致的输入都拒绝建面（错的换行几何比没有编辑面更糟）。
 */
export function createEditingUnitSurface(input: CreateUnitSurfaceInput): CreateUnitSurfaceOutcome {
  if (input.generation !== input.currentGeneration) return { ok: false, reason: "stale-generation" };
  const unit = input.unit;
  if (!unit) return { ok: false, reason: "no-unit" };
  if (unit.lines.length === 0) return { ok: false, reason: "empty-unit" };

  const geos = input.geometries ?? [];
  if (geos.length !== unit.lines.length) {
    return { ok: false, reason: "geometry-count-mismatch" };
  }
  const byLine = new Map<string, UnitLineGeometryInput>();
  for (const g of geos) {
    if (byLine.has(g.lineId)) return { ok: false, reason: "duplicate-line-geometry" };
    byLine.set(g.lineId, g);
  }
  for (const l of unit.lines) {
    if (!byLine.has(l.lineId)) return { ok: false, reason: "missing-line-geometry" };
  }
  // 顺序必须与 unit.lines 一致（几何错位会让渲染与映射指向别的行）
  for (let i = 0; i < unit.lines.length; i++) {
    if (geos[i]!.lineId !== unit.lines[i]!.lineId) return { ok: false, reason: "line-order-mismatch" };
    const g = geos[i]!;
    if (!usableRect(g.box)) {
      return { ok: false, reason: "unknown-line-geometry" };
    }
  }

  // ── 委托既有 Step 1 几何（本模块不复制 union / indent / requiredWidth 算法）──
  const step1 = createCoreEditingSurface({
    lines: unit.lines.map((l, i) => ({
      paragraphId: l.paragraphId,
      text: l.text,
      box: geos[i]!.box,
    })),
    // surface 跨多个 TextBox ⇒ 传单元级标识（不冒充任何单行 TextBox）
    textBoxId: unit.unitId,
    generation: input.generation,
    currentGeneration: input.currentGeneration,
  });
  if (!step1.ok) return { ok: false, reason: "unknown-line-geometry" };
  const coreSurface = step1.surface;

  // ── 不变量 ①：文本逐字节相同（两套口径若漂移 ⇒ 立刻拒绝，不选边）──
  if (coreSurface.text !== unit.text) return { ok: false, reason: "text-mismatch" };
  if (coreEditingSurfaceDomLength(coreSurface) !== unit.lengthUtf16) {
    return { ok: false, reason: "text-mismatch" };
  }

  // ── 不变量 ②：每条 line 的 DOM 区间 ≡ unit 区间（首尾相接、铺满）──
  const ownership: UnitSurfaceOwnership[] = [];
  for (let i = 0; i < unit.lines.length; i++) {
    const l = unit.lines[i]!;
    const g = geos[i]!;
    const step1Line = coreSurface.geometry.lines.find((x) => x.paragraphId === l.paragraphId);
    if (!step1Line) return { ok: false, reason: "offset-mismatch" };
    if (step1Line.domStart !== l.startUtf16 || step1Line.domEnd !== l.endUtf16) {
      return { ok: false, reason: "offset-mismatch" };
    }
    ownership.push({
      lineId: l.lineId,
      textBoxId: l.textBoxId,
      paragraphId: l.paragraphId,
      domStart: l.startUtf16,
      domEnd: l.endUtf16,
      box: g.box,
      // ★ 直接复用既有 Step 1 已归一的 textIndent（本地不再实现第二个 round2/缩进口径）
      textIndent: step1Line.textIndent,
    });
  }
  // unit 区间必须恰好铺满 [0, lengthUtf16)
  // ⚠️ 相邻两条 line 的区间**不是首尾相接**：中间正好是 separator 占位
  //   （L5 domEnd=32 → separator[32,33) → L6 domStart=33）。
  //   故校验口径 = 「起点 0 + 终点 lengthUtf16 + 每段间隔恰等于其 separator 跨度 + 单调」。
  if (ownership.length > 0) {
    if (ownership[0]!.domStart !== 0) return { ok: false, reason: "offset-mismatch" };
    for (let i = 1; i < ownership.length; i++) {
      const prev = ownership[i - 1]!;
      const cur = ownership[i]!;
      if (cur.domStart < prev.domEnd) return { ok: false, reason: "offset-mismatch" };
      const gap = cur.domStart - prev.domEnd;
      const expectedGap = unit.separators
        .filter((sp) => sp.afterLineId === prev.lineId)
        .reduce((n, sp) => n + (sp.endUtf16 - sp.startUtf16), 0);
      if (gap !== expectedGap) return { ok: false, reason: "offset-mismatch" };
    }
    if (ownership[ownership.length - 1]!.domEnd !== unit.lengthUtf16) {
      return { ok: false, reason: "offset-mismatch" };
    }
  }

  // ── 不变量 ③：surface 覆盖多个 TextBox（未合并的直接证据）──
  const textBoxIds: string[] = [];
  for (const l of unit.lines) if (!textBoxIds.includes(l.textBoxId)) textBoxIds.push(l.textBoxId);

  // ── 口径差异登记（不静默、不修）──
  const divergence = describeDivergence(unit);

  return {
    ok: true,
    divergence,
    surface: {
      unitId: unit.unitId,
      kind: unit.kind,
      text: unit.text,
      domLength: unit.lengthUtf16,
      box: coreSurface.geometry.box,
      firstLineIndent: coreSurface.geometry.firstLineIndent,
      requiredWidth: coreSurface.geometry.requiredWidth,
      ownership,
      textBoxIds,
      coreSurface,
      generation: input.generation,
    },
  };
}

/**
 * 找出 Step 1 surface 与 EditingUnit 口径不一致的 offset（当前设计下唯一一处：
 * 每个 separator 的**起点** = 前一行的 `endUtf16`）。
 *
 * ★ 这里只**登记**差异，不修改任何一方的行为。P0-C 裁决：offset 归属以 EditingUnit 为准
 *   （`unitOffsetToParagraphOffset` 是唯一真值）。
 */
function describeDivergence(unit: EditingUnit): BoundaryDivergence {
  for (let i = 0; i < unit.separators.length; i++) {
    const sp = unit.separators[i]!;
    const before = unit.lines.find((l) => l.lineId === sp.afterLineId);
    if (!before) continue;
    const at = unitOffsetToParagraphOffset(unit, sp.startUtf16);
    if (at.ok) {
      return {
        kind: "paragraph-boundary",
        domOffset: sp.startUtf16,
        step1Kind: "paragraph-boundary",
        editingUnitKind: "line",
        lineId: before.lineId,
        paragraphId: before.paragraphId,
        resolvedByEditingUnit: true,
      };
    }
    if (i > 0) break;
  }
  // 无 separator（或全不可达）⇒ 空差异
  return {
    kind: "paragraph-boundary",
    domOffset: -1,
    step1Kind: "paragraph-boundary",
    editingUnitKind: "line",
    lineId: unit.lines[unit.lines.length - 1]!.lineId,
    paragraphId: unit.lines[unit.lines.length - 1]!.paragraphId,
    resolvedByEditingUnit: true,
  };
}

/**
 * surface offset → Core 落点。**唯一实现就是 `unitOffsetToParagraphOffset`** ——
 * 本函数只做转发（存在的意义是让 P0-D / 未来接线只认 surface 一个入口，
 * 从而杜绝"第二套 boundary 规则"）。
 */
export function unitSurfaceOffsetToParagraph(
  surface: EditingUnitSurface,
  unit: EditingUnit,
  domOffset: number
): { ok: true; paragraphId: string; localOffset: number; lineId: string } | { ok: false; reason: string } {
  const r = unitOffsetToParagraphOffset(unit, domOffset);
  if (!r.ok) return r;
  const line = unit.lines.find((l) => l.paragraphId === r.paragraphId);
  if (!line) return { ok: false, reason: "unknown-line" };
  return { ok: true, paragraphId: r.paragraphId, localOffset: r.localOffset, lineId: line.lineId };
}

/** 反向：某行的段落内偏移 → surface offset（转发，规则同样只有一处） */
export function unitSurfaceParagraphOffsetToUnit(
  unit: EditingUnit,
  lineId: string,
  localOffset: number
): { ok: true; domOffset: number } | { ok: false; reason: string } {
  const r = unitRangeOfLine(unit, lineId);
  if (!r) return { ok: false, reason: "unknown-line" };
  return { ok: true, domOffset: r.startUtf16 + localOffset };
}
