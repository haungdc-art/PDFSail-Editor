/**
 * editor/binding/export-redraw-geometry.ts — F3B-6.28 · D 第三步（**3A**）
 *
 * 重绘几何投影：flow 视觉行 → **导出几何**（PDF pt 域）。
 *
 * ── 定位（用户 2026-10-13 裁决：3A 只做契约 + 数值验证，不接生产）──────────
 *   本模块是第 3 步「bridge 重绘几何与原始 glyph provenance 保留」的**纯函数契约层**：
 *     · 消费 `computeExportFlowProjection`（flow 行 + 位移行 + delta，CSS 域）
 *     · 输出每条重绘行的：目标盒 / baseline / 逐字符几何（PDF pt 域）
 *     · 逐字符几何保留原 glyph 的**字体身份 / CID / pdfTransform**（不退化、不替换）
 *   **不接生产**：调用方（build-core-export-context → bridge）在 3B 接入。
 *
 * ── 坐标口径（两种显式命名契约；不新建第二套换算公式）────────────────────
 *   · baseline / 盒 y / 宽高：既有 `cssToPdf`（÷ totalScale，与导入侧
 *     CoordinateMapper 的 `×(viewportScale × cssScale)` 精确互逆）；
 *   · **盒 x / 逐字符 targetXPt：`cssToPdfXDocumentSpace`（document-space
 *     契约，÷ totalScale）**——F3B-6.28 · D-3B-4 P0 修复：此前误用
 *     `cssToPdfX`（legacy-overlay 契约，÷ renderScale，M7.8-048 历史行为），
 *     cssScale ≠ 1 时 X 与 y/几何链相差恒定因子 cssScale（gd-swim 实测
 *     −10.31% ⇒ 被编辑 unit 整体左偏约 4.4mm）。legacy overlay 路径
 *     （`cssToPdf` → `cssToPdfX`）**逐位不变**，差异在本模块显式声明；
 *   · CSS 空间 = 导入侧 CoordinateMapper 的产物 = `×(viewportScale × cssScale)`
 *     （`pdfYToCssY` / `pdfToCss` 均折叠 cssScale）⇒ ÷totalScale 是其精确逆；
 *   · 垂直位移只改 `pdfTransform[5]`：`f' = f − Δcss / totalScale`
 *     （`shiftPdfTransformY`，既有原语）⇒ CSS 下移 = PDF 上移（y 轴向上），
 *     `a b c d e` 一律不动 ⇒ 字宽 / 缩放 / 旋转 / x / 字符间相对间距全部保持。
 *
 * ── 失败纪律（用户明确要求）────────────────────────────────────────────
 *   · 无效几何 / 缺失来源 / 映射不唯一 ⇒ **fail-closed**：
 *     - 系统性（投影非 ok、totalScale / flipBase 非法、盒换算非有限、同一原 glyph
 *       被两个字符声称）⇒ 整体失败，不产出任何几何；
 *     - 行级（位移行缺原字形几何 / 成员行声称的原 glyph 不存在）⇒ 该行**不产出**，
 *       记入 `skipped`（可观测），绝不伪造 transform / CID / 字体。
 *   · `delta = 0` 时位移行的 transform 与原值**逐字节等价**（Undo/Redo 不累计）。
 */

import {
  cssToPdf,
  cssToPdfXDocumentSpace,
  type ExportContext,
} from "../../document-model/export-coordinate-space";
import type { GlyphFontIdentity, TransformMatrix } from "../../document-model/types";
import {
  shiftPdfTransformY,
  type ExportFlowProjection,
  type ExportFlowProjectionFailure,
} from "./export-flow-projection";

/** flow 投影的成功/失败联合（供诊断与流水线使用） */
export type ExportFlowProjectionOutcome = ExportFlowProjection | ExportFlowProjectionFailure;

// ─────────────────────────────────────────────────────────────────────
//  类型
// ─────────────────────────────────────────────────────────────────────

/** CSS 盒（y 向下；导入侧 CoordinateMapper 空间） */
export interface CssBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** PDF pt 盒（y 向上；y = 盒**底边**，与 `cssToPdf` 返回值同语义） */
export interface PdfBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 单个原 glyph 的导出几何事实（调用方从 Sidecar `OriginalGlyph` 投影）。
 *
 * ⚠️ `pdfTransform` 必须来自 `OriginalGlyph.metrics.pdfTransform`（PDF pt 域第一手）；
 *    **不得**使用 `OriginalGlyph.transform` —— 那是导入期 CSS 归一化矩阵
 *    （`pdfTransformToCssNormalized`，e/f 恒 0），拿来做重绘几何会整体错位。
 */
export interface SourceGlyphGeometry {
  readonly originalChar?: string;
  readonly pdfCharCode?: number;
  readonly fontIdentity?: GlyphFontIdentity;
  readonly pdfTransform?: TransformMatrix;
}

/** 逐字符重绘几何 */
export interface ExportRedrawGlyphGeometry {
  readonly char: string;
  readonly sourceLineId: string;
  /** 原 glyph 序号（glyph position；`null` = 新增字符，原 PDF 中无对应字形） */
  readonly sourceGlyphIndex: number | null;
  /** 原 glyph 的字体身份（有完整来源时非 null；新增/缺失 ⇒ null，绝不伪造） */
  readonly fontIdentity: GlyphFontIdentity | null;
  /** 原 glyph 真实 CID（同上） */
  readonly pdfCharCode: number | null;
  /**
   * 重绘 Tm（PDF pt 域，`[a, b, c, d, e, f]`）。
   *   · 成员行：`a..d` 取原字形（字宽/缩放/旋转保持），`e/f` = 目标位置；
   *   · 位移行：原 transform 垂直平移（`a..e` 与原值逐位相等）；
   *   · `null` = 该字符无可用原 transform（新增字符或来源缺 transform）⇒ 渲染层走既有 fallback。
   */
  readonly pdfTransform: TransformMatrix | null;
  /** 目标 x（PDF pt；与 `pdfTransform.e` 同口径，由 document-space 契约换算） */
  readonly targetXPt: number;
  /** 目标 baseline（PDF pt） */
  readonly targetBaselinePt: number;
  /** 该字符经历的垂直位移（CSS px，向下为正；由原 transform 推导，非输入） */
  readonly deltaCss: number;
}

/** 一条重绘行的几何 */
export interface ExportRedrawLineGeometry {
  readonly role: "flow-member" | "displaced-successor";
  /** flow 成员行的 flow 行序（位移行无 flow 行序 ⇒ undefined） */
  readonly flowIndex?: number;
  readonly sourceLineIds: readonly string[];
  readonly text: string;
  /** 目标盒（PDF pt；既有 `cssToPdf` 换算） */
  readonly box: PdfBox;
  /** 目标 baseline（PDF pt） */
  readonly baselinePt: number;
  /**
   * F3B-6.28 · D-3B-4：**原始 baseline**（PDF pt；未位移前的第一个原字形 Tm.f）。
   * renderer 据此在重绘落笔前核验「原算子已完整剥离」。
   * 全新增行（无任何原字形）为 null ⇒ 无从核验（该行本来也没有原算子）。
   */
  readonly originalBaselinePt: number | null;
  readonly glyphs: readonly ExportRedrawGlyphGeometry[];
  /** 该行整体垂直位移（CSS px，向下为正） */
  readonly deltaCss: number;
}

export interface ExportRedrawGeometry {
  readonly ok: true;
  readonly lines: readonly ExportRedrawLineGeometry[];
  /** 全量垂直位移（CSS px；来自 flow 投影） */
  readonly deltaCss: number;
  readonly totalScale: number;
  readonly warnings: readonly string[];
  /** 被跳过的行（缺原字形几何等）——必须可观测，不得静默 */
  readonly skipped: readonly string[];
}

export type ExportRedrawGeometryFailure =
  | "projection-not-ok"
  | "invalid-total-scale"
  | "invalid-flip-base"
  | "invalid-box"
  | "non-unique-glyph-mapping"
  | "invalid-glyph-geometry";

export type ExportRedrawGeometryOutcome =
  | ExportRedrawGeometry
  | { readonly ok: false; readonly reason: ExportRedrawGeometryFailure; readonly detail: string };

export interface ExportRedrawGeometryInput {
  /** 3A 前置契约（flow 行 + 位移行 + delta；非 ok ⇒ 整体 fail-closed） */
  readonly projection: ExportFlowProjectionOutcome;
  /**
   * 行 → 原 glyph 几何序列（Sidecar `lookupGlyphRange` 的投影；缺 ⇒ 该行跳过）。
   * 成员行只按 flow 的 `sourceGlyphIndex` 取用；位移行取**全序列**。
   */
  readonly sourceGlyphsOf: (lineId: string) => readonly SourceGlyphGeometry[] | null;
  /** 位移行的**原始** CSS 盒（`AffectedScopeItem.originalRect`；缺 ⇒ 该行跳过） */
  readonly displacedBoxOf: (lineId: string) => CssBox | null;
  /** 导出坐标上下文（既有 `cssToPdf` 入参；`pageTopPt` 必填，缺失 ⇒ fail-closed） */
  readonly exportContext: ExportContext;
}

// ─────────────────────────────────────────────────────────────────────
//  实现
// ─────────────────────────────────────────────────────────────────────

const isFiniteNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** 逐字段有限性校验（TransformMatrix 的 6 个分量） */
function finiteTransform(t: readonly number[] | undefined): t is TransformMatrix {
  return (
    Array.isArray(t) &&
    t.length >= 6 &&
    t.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

export function computeExportRedrawGeometry(
  input: ExportRedrawGeometryInput
): ExportRedrawGeometryOutcome {
  const { projection } = input;
  if (!projection.ok) {
    return {
      ok: false,
      reason: "projection-not-ok",
      detail: `flow 投影未成功：${projection.reason}${projection.detail ? `（${projection.detail}）` : ""}`,
    };
  }

  const ctx = input.exportContext;
  const totalScale = ctx.renderScale * ctx.cssScale;
  if (!isFiniteNum(totalScale) || totalScale <= 0) {
    return {
      ok: false,
      reason: "invalid-total-scale",
      detail: `totalScale=${totalScale}（renderScale=${ctx.renderScale} × cssScale=${ctx.cssScale}）`,
    };
  }
  // Y 翻转基准必须显式（= MediaBox.y1）。缺省时 cssToPdf 回退 pageHeightPt，
  // 但 MediaBox.y0 ≠ 0 的 PDF 会整体偏移 y0 ⇒ 几何投影显式要求，不悄悄回退。
  const flipBase = ctx.pageTopPt;
  if (!isFiniteNum(flipBase) || flipBase <= 0) {
    return {
      ok: false,
      reason: "invalid-flip-base",
      detail: `pageTopPt=${String(flipBase)}（必须为有限正数 = MediaBox.y1）`,
    };
  }

  const warnings: string[] = [];
  const skipped: string[] = [];
  const lines: ExportRedrawLineGeometry[] = [];
  /** 原 glyph 唯一性账本：同一 (lineId, glyphIndex) 不得被两个字符声称 */
  const claimed = new Set<string>();

  const fail = (reason: ExportRedrawGeometryFailure, detail: string): ExportRedrawGeometryOutcome =>
    ({ ok: false, reason, detail });

  /** CSS 盒 → PDF pt 盒（y/宽高走既有 cssToPdf；x 走 document-space 契约） */
  const toPdfBox = (box: CssBox): PdfBox | null => {
    const pt = cssToPdf(box, ctx);
    const ptX = cssToPdfXDocumentSpace(box.x, ctx);
    if (![ptX, pt.y, pt.width, pt.height].every(isFiniteNum)) return null;
    return { x: ptX, y: pt.y, width: pt.width, height: pt.height };
  };

  /** CSS baseline → PDF pt baseline（复用 cssToPdf：零高盒的底边 = flipBase − y/totalScale） */
  const toPdfBaseline = (cssBaseline: number): number | null => {
    if (!isFiniteNum(cssBaseline)) return null;
    const pt = cssToPdf({ x: 0, y: cssBaseline, width: 0, height: 0 }, ctx).y;
    return isFiniteNum(pt) ? pt : null;
  };

  // ── ① flow 成员行（unit 文本被流重新折行后的视觉行）──────────────────
  for (const flowLine of projection.redrawLines) {
    const box = toPdfBox(flowLine.cssBox);
    if (!box) return fail("invalid-box", `flow 行 ${flowLine.index} 的盒换算非有限：${JSON.stringify(flowLine.cssBox)}`);
    const baselinePt = toPdfBaseline(flowLine.baselineCssY);
    if (baselinePt === null) {
      return fail("invalid-box", `flow 行 ${flowLine.index} 的 baseline 非有限：${flowLine.baselineCssY}`);
    }

    const glyphs: ExportRedrawGlyphGeometry[] = [];
    let lineSkipped: string | null = null;
    let firstDelta: number | null = null;
    /** D-3B-4：本 flow 行的原始 baseline（第一个原字形 Tm.f；全新增行 ⇒ null） */
    let firstOriginalBaseline: number | null = null;

    for (const g of flowLine.glyphs) {
      const targetXPt = cssToPdfXDocumentSpace(g.cssX, ctx);
      if (!isFiniteNum(targetXPt)) {
        return fail("invalid-box", `flow 行 ${flowLine.index} 字符 ${JSON.stringify(g.char)} 的 x 非有限：${g.cssX}`);
      }
      if (g.sourceGlyphIndex === null) {
        // 新增字符：原 PDF 无对应字形 ⇒ 不伪造字体/CID/transform；
        // 目标位置仍由 flow 逐字符 advance 给出（渲染层走既有 fallback）。
        glyphs.push({
          char: g.char,
          sourceLineId: g.sourceLineId,
          sourceGlyphIndex: null,
          fontIdentity: null,
          pdfCharCode: null,
          pdfTransform: null,
          targetXPt,
          targetBaselinePt: baselinePt,
          deltaCss: 0,
        });
        continue;
      }
      const key = `${g.sourceLineId}#${g.sourceGlyphIndex}`;
      if (claimed.has(key)) {
        return fail(
          "non-unique-glyph-mapping",
          `原 glyph ${key} 被 flow 行 ${flowLine.index} 的多个字符声称（映射不唯一）`,
        );
      }
      claimed.add(key);
      const seq = input.sourceGlyphsOf(g.sourceLineId);
      const src = seq?.[g.sourceGlyphIndex];
      if (!src) {
        // flow 承诺了「该字符来自原 glyph #k」，但来源序列没有它 ⇒ 承诺被破坏
        // ⇒ 该行 fail-closed（不凭 lineIndex 猜测），记入 skipped。
        lineSkipped = `${g.sourceLineId}#${g.sourceGlyphIndex}: 来源序列缺该原 glyph（行 ${flowLine.index}）`;
        break;
      }
      const fontIdentity = src.fontIdentity ?? null;
      const pdfCharCode = isFiniteNum(src.pdfCharCode) ? src.pdfCharCode : null;
      let pdfTransform: TransformMatrix | null = null;
      if (src.pdfTransform !== undefined) {
        if (!finiteTransform(src.pdfTransform)) {
          return fail(
            "invalid-glyph-geometry",
            `原 glyph ${key} 的 pdfTransform 非有限：${JSON.stringify(src.pdfTransform)}`,
          );
        }
        // a..d 保留原字形（字宽/缩放/旋转）；e/f = 目标位置
        pdfTransform = [
          src.pdfTransform[0]!,
          src.pdfTransform[1]!,
          src.pdfTransform[2]!,
          src.pdfTransform[3]!,
          targetXPt,
          baselinePt,
        ];
      }
      if (firstDelta === null && src.pdfTransform !== undefined && finiteTransform(src.pdfTransform)) {
        firstDelta = (src.pdfTransform[5]! - baselinePt) * totalScale;
      }
      // D-3B-4：原始 baseline = 第一个带原 transform 的字形 Tm.f（未平移前）
      if (firstOriginalBaseline === null && src.pdfTransform !== undefined && finiteTransform(src.pdfTransform)) {
        firstOriginalBaseline = src.pdfTransform[5]!;
      }
      glyphs.push({
        char: g.char,
        sourceLineId: g.sourceLineId,
        sourceGlyphIndex: g.sourceGlyphIndex,
        fontIdentity,
        pdfCharCode,
        pdfTransform,
        targetXPt,
        targetBaselinePt: baselinePt,
        deltaCss: src.pdfTransform !== undefined && finiteTransform(src.pdfTransform)
          ? (src.pdfTransform[5]! - baselinePt) * totalScale
          : 0,
      });
    }
    if (lineSkipped) {
      skipped.push(lineSkipped);
      continue;
    }
    lines.push({
      role: "flow-member",
      flowIndex: flowLine.index,
      sourceLineIds: [...flowLine.sourceLineIds],
      text: flowLine.text,
      box,
      baselinePt,
      originalBaselinePt: firstOriginalBaseline,
      glyphs,
      deltaCss: firstDelta ?? 0,
    });
  }

  // ── ② 位移行（原算子已剥离；重绘 = 原几何整体垂直平移）────────────────
  const deltaCss = projection.deltaCss;
  if (!isFiniteNum(deltaCss)) {
    return fail("invalid-box", `flow 投影的 deltaCss 非有限：${deltaCss}`);
  }
  for (const lineId of projection.displacedLineIds) {
    const originalBox = input.displacedBoxOf(lineId);
    if (!originalBox) {
      skipped.push(`${lineId}: 缺原始 CSS 盒（scope originalRect）⇒ 不重绘该位移行`);
      continue;
    }
    const seq = input.sourceGlyphsOf(lineId);
    if (!seq || seq.length === 0) {
      skipped.push(`${lineId}: 缺原 glyph 序列（Sidecar）⇒ 不重绘该位移行`);
      continue;
    }
    // 目标盒 = 原盒 + delta（CSS 域平移后再走既有 cssToPdf —— 不新建换算）
    const box = toPdfBox({ ...originalBox, y: originalBox.y + deltaCss });
    if (!box) return fail("invalid-box", `位移行 ${lineId} 的盒换算非有限：${JSON.stringify(originalBox)}`);

    const glyphs: ExportRedrawGlyphGeometry[] = [];
    let lineSkipped: string | null = null;
    const fValues: number[] = [];
    /** D-3B-4：该位移行的原始 baseline（第一个原字形 Tm.f） */
    let originalBaselinePt: number | null = null;
    for (let i = 0; i < seq.length; i += 1) {
      const src = seq[i]!;
      if (originalBaselinePt === null && finiteTransform(src.pdfTransform)) {
        originalBaselinePt = src.pdfTransform![5]!;
      }
      const key = `${lineId}#${i}`;
      if (claimed.has(key)) {
        return fail("non-unique-glyph-mapping", `原 glyph ${key} 被重复声称（映射不唯一）`);
      }
      claimed.add(key);
      // 位移行重绘的硬前提：字体身份 + 原 transform 齐备（raw-CID 重放的几何/字体事实来源；
      // 缺一即不重绘该行，绝不以 Standard-14/Noto 退化替换）。
      // CID 允许缺失（pdf.js 合成空格等无墨迹字符原 PDF 中本无字形/CID）⇒ pdfCharCode=null
      // 且告警；raw-CID 重放会跳过它（无墨迹），后续字符凭绝对 Tm 保持位置完整性。
      if (!src.fontIdentity || src.pdfTransform === undefined) {
        lineSkipped = `${key}: 缺原字形几何（fontIdentity/pdfTransform 不齐）⇒ 不重绘`;
        break;
      }
      if (!finiteTransform(src.pdfTransform)) {
        return fail(
          "invalid-glyph-geometry",
          `位移行 ${lineId} 的 glyph #${i} pdfTransform 非有限：${JSON.stringify(src.pdfTransform)}`,
        );
      }
      const shifted = shiftPdfTransformY(src.pdfTransform, deltaCss, totalScale);
      if (!shifted.ok) {
        return fail("invalid-glyph-geometry", `位移行 ${lineId} 的 glyph #${i} 平移失败：${shifted.reason}`);
      }
      const hasCid = isFiniteNum(src.pdfCharCode);
      if (!hasCid) {
        warnings.push(`${key}: 无 CID（合成空格等无墨迹字符）⇒ raw-CID 重放跳过该字符（无墨迹，位置由相邻字符绝对 Tm 保持）`);
      }
      fValues.push(shifted.transform[5]!);
      glyphs.push({
        char: src.originalChar ?? "",
        sourceLineId: lineId,
        sourceGlyphIndex: i,
        fontIdentity: src.fontIdentity,
        pdfCharCode: hasCid ? src.pdfCharCode! : null,
        pdfTransform: shifted.transform,
        targetXPt: shifted.transform[4]!,
        targetBaselinePt: shifted.transform[5]!,
        deltaCss,
      });
    }
    if (lineSkipped) {
      skipped.push(lineSkipped);
      continue;
    }
    // 同一 visual line 的 glyph 原则上同 baseline；出现多个取值只告警（多文本块行），
    // 行的参考 baseline 取首 glyph（与 raw-CID 重放的逐字符 Tm 无耦合）。
    const distinctF = [...new Set(fValues.map((f) => Math.round(f * 100) / 100))];
    if (distinctF.length > 1) {
      warnings.push(`${lineId}: 行内 ${distinctF.length} 个不同 baseline（${distinctF.join("/")}）——已按首 glyph 记录行 baseline`);
    }
    lines.push({
      role: "displaced-successor",
      sourceLineIds: [lineId],
      text: glyphs.map((g) => g.char).join(""),
      box,
      baselinePt: fValues[0] ?? box.y,
      originalBaselinePt,
      glyphs,
      deltaCss,
    });
  }

  return {
    ok: true,
    lines,
    deltaCss,
    totalScale,
    warnings,
    skipped,
  };
}
