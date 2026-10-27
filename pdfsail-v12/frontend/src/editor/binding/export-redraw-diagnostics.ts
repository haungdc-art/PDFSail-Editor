/**
 * editor/binding/export-redraw-diagnostics.ts — F3B-6.28 · D-3B-1
 *
 * 重绘几何的**逐行诊断**（只读观测；不改任何写入资格）。
 *
 * ── 本模块的唯一职责 ─────────────────────────────────────────────────
 *   把 flow 布局 / flow 投影 / 重绘几何的中间结果摊平成**逐行**可核对的事实，
 *   供 3B-1 阶段在不开放重绘的前提下验证几何是否正确。
 *
 * ── ★ 红线（用户 2026-10-13）─────────────────────────────────────────
 *   · 诊断结果为 `ok` **不等于**可以重绘；本模块不产出任何写入决策；
 *   · 不消费/不改写 `glyph.modified`、raw-CID 写入条件；
 *   · `changedLineIds` 只记录其**来源**（transaction / unresolved），不参与反推。
 */

import type { ExportFlowProjection } from "./export-flow-projection";
import type { ExportRedrawGeometry, ExportRedrawGeometryOutcome, PdfBox } from "./export-redraw-geometry";

// ─────────────────────────────────────────────────────────────────────
//  类型
// ─────────────────────────────────────────────────────────────────────

export type RedrawLineDiagnosticRole = "flow-member" | "displaced-successor" | "unit-member-unprojected";

/** 原始断行保真结果（与 flow 模块的告警一一对应） */
export type BreakFidelity = "ok" | "overflow" | "broken" | "unresolved" | "unknown";

export interface GlyphSourceCoverage {
  /** 该行的目标字符数 */
  readonly total: number;
  /** 能映射到原 glyph（有 sourceGlyphIndex）的字符数 */
  readonly withSource: number;
  /** 有完整来源（字体身份 + CID + 原 transform）的字符数 —— raw-CID 重绘的真子集 */
  readonly withFullProvenance: number;
}

export interface ExportRedrawLineDiagnostic {
  readonly lineId: string;
  readonly role: RedrawLineDiagnosticRole;
  /** flow 行序（成员行）；位移行无 ⇒ null */
  readonly flowIndex: number | null;
  /** 原始文本长度（Sidecar/legacy 第一手；不可得 ⇒ null） */
  readonly originalTextLength: number | null;
  /** 目标文本长度（投影/几何产出；不可得 ⇒ null） */
  readonly targetTextLength: number | null;
  /** 原始盒（CSS px） */
  readonly originalBox: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
  /** 目标盒（PDF pt） */
  readonly targetBox: PdfBox | null;
  /** 原始 baseline（PDF pt，Sidecar 第一手） */
  readonly originalBaselinePt: number | null;
  /** 预测 baseline（PDF pt） */
  readonly predictedBaselinePt: number | null;
  /** 预测 − 原始（PDF pt；y 向上 ⇒ 内容下移为负） */
  readonly deltaPt: number | null;
  /** 该行的垂直位移（CSS px，向下为正） */
  readonly deltaCss: number | null;
  readonly breakFidelity: BreakFidelity;
  readonly coverage: GlyphSourceCoverage | null;
  readonly status: "projected" | "skipped" | "failed";
  readonly reason: string | null;
}

export interface ExportRedrawDiagnostics {
  /** 整条链路是否产出可用几何（false ⇒ 逐行 status 说明原因） */
  readonly ok: boolean;
  /** 失败阶段（ok=false 时） */
  readonly stage: "flow" | "scope" | "projection" | "geometry" | null;
  /** changedLineIds 的**来源**（真实事务 / unresolved 保守模式） */
  readonly changedSource: "transaction" | "unresolved";
  readonly changedLineIds: readonly string[];
  readonly lines: readonly ExportRedrawLineDiagnostic[];
  readonly flowMetrics: {
    readonly newLineCount: number | null;
    readonly originalLineCount: number | null;
    readonly usedLineGap: number | null;
    readonly delta: number | null;
  };
  readonly warnings: readonly string[];
  readonly skipped: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────
//  实现
// ─────────────────────────────────────────────────────────────────────

export interface ExportRedrawDiagnosticsInput {
  /** flow 布局结果（ok/fail 皆可；fail ⇒ 诊断记录阶段与原因） */
  readonly flow:
    | {
        readonly ok: true;
        readonly lines: readonly { readonly index: number; readonly text: string }[];
        readonly warnings: readonly string[];
        readonly metrics: {
          readonly newLineCount: number;
          readonly originalLineCount: number;
          readonly usedLineGap: number;
          readonly delta: number;
        };
      }
    | { readonly ok: false; readonly reason: string; readonly detail: string };
  /** flow 投影（ok/fail 皆可） */
  readonly projection: ExportFlowProjection | { readonly ok: false; readonly reason: string; readonly detail: string };
  /** 重绘几何（ok/fail 皆可） */
  readonly geometry: ExportRedrawGeometryOutcome | null;
  /** unit 成员行（含未进入投影的成员行 —— 也要出现在诊断里） */
  readonly memberLineIds: readonly string[];
  /** 位移行（来自 scope/plan） */
  readonly displacedLineIds: readonly string[];
  /** 原始文本长度（Sidecar；缺 ⇒ null） */
  readonly originalTextLengthOf: (lineId: string) => number | null;
  /** 原始 baseline（PDF pt，Sidecar 第一手；缺 ⇒ null） */
  readonly originalBaselinePtOf: (lineId: string) => number | null;
  /** 原始 CSS 盒（缺 ⇒ null） */
  readonly originalBoxOf: (lineId: string) => { x: number; y: number; width: number; height: number } | null;
  readonly changedLineIds: readonly string[];
  readonly changedSource: "transaction" | "unresolved";
}

/** 从 flow 告警解析逐行的原始断行保真结果 */
function fidelityFor(
  flow: ExportRedrawDiagnosticsInput["flow"],
  lineId: string,
  changedOk: boolean,
): BreakFidelity {
  if (!flow.ok) return "unknown";
  const broken = flow.warnings.find((w) => w.includes("original-break-broken") && w.includes(lineId));
  if (broken) return "broken";
  const overflow = flow.warnings.find((w) => w.includes("original-break-overflow") && w.includes(lineId));
  if (overflow) return "overflow";
  if (!changedOk) return "unresolved";
  return "ok";
}

export function buildExportRedrawDiagnostics(
  input: ExportRedrawDiagnosticsInput,
): ExportRedrawDiagnostics {
  const { flow, projection, geometry } = input;
  const warnings: string[] = [];
  const stageOf = (): ExportRedrawDiagnostics["stage"] => {
    if (!flow.ok) return "flow";
    if (!projection.ok) return "projection";
    if (geometry === null) return "geometry";
    if (!geometry.ok) return "geometry";
    return null;
  };
  const ok = flow.ok && projection.ok && geometry !== null && geometry.ok;

  const lines: ExportRedrawLineDiagnostic[] = [];
  const skipped: string[] = [...(geometry?.ok ? geometry.skipped : [])];
  const geoLines = geometry?.ok ? geometry.lines : [];
  const changedOk = input.changedSource === "transaction";

  // ① 已进入几何的 flow 成员行
  if (geometry?.ok) {
    for (const line of geoLines) {
      if (line.role !== "flow-member") continue;
      const srcLineId = line.sourceLineIds[0] ?? null;
      const origBase = srcLineId ? input.originalBaselinePtOf(srcLineId) : null;
      const withSource = line.glyphs.filter((g) => g.sourceGlyphIndex !== null).length;
      const full = line.glyphs.filter(
        (g) => g.sourceGlyphIndex !== null && g.fontIdentity && g.pdfCharCode !== null && g.pdfTransform !== null,
      ).length;
      lines.push({
        lineId: srcLineId ?? `flow#${line.flowIndex ?? "?"}`,
        role: "flow-member",
        flowIndex: line.flowIndex ?? null,
        originalTextLength: srcLineId ? input.originalTextLengthOf(srcLineId) : null,
        targetTextLength: line.text.length,
        originalBox: srcLineId ? input.originalBoxOf(srcLineId) : null,
        targetBox: line.box,
        originalBaselinePt: origBase,
        predictedBaselinePt: line.baselinePt,
        deltaPt: origBase === null ? null : line.baselinePt - origBase,
        deltaCss: line.deltaCss,
        breakFidelity: srcLineId ? fidelityFor(flow, srcLineId, changedOk) : "unknown",
        coverage: { total: line.glyphs.length, withSource, withFullProvenance: full },
        status: "projected",
        reason: null,
      });
    }
    // ② 已进入几何的位移行
    for (const line of geoLines) {
      if (line.role !== "displaced-successor") continue;
      const srcLineId = line.sourceLineIds[0]!;
      const origBase = input.originalBaselinePtOf(srcLineId);
      const withSource = line.glyphs.filter((g) => g.sourceGlyphIndex !== null).length;
      const full = line.glyphs.filter(
        (g) => g.sourceGlyphIndex !== null && g.fontIdentity && g.pdfCharCode !== null && g.pdfTransform !== null,
      ).length;
      lines.push({
        lineId: srcLineId,
        role: "displaced-successor",
        flowIndex: null,
        originalTextLength: input.originalTextLengthOf(srcLineId),
        targetTextLength: line.text.length,
        originalBox: input.originalBoxOf(srcLineId),
        targetBox: line.box,
        originalBaselinePt: origBase,
        predictedBaselinePt: line.baselinePt,
        deltaPt: origBase === null ? null : line.baselinePt - origBase,
        deltaCss: line.deltaCss,
        breakFidelity: fidelityFor(flow, srcLineId, changedOk),
        coverage: { total: line.glyphs.length, withSource, withFullProvenance: full },
        status: "projected",
        reason: null,
      });
    }
  }

  // ③ 未进入几何的行（成员行 / 位移行）—— 必须逐行给出原因（fail-closed 可观测）
  const covered = new Set(lines.map((l) => l.lineId));
  const failReason =
    !flow.ok
      ? `flow: ${(flow as { reason: string }).reason} — ${(flow as { detail: string }).detail}`
      : !projection.ok
        ? `projection: ${(projection as { reason: string }).reason} — ${(projection as { detail: string }).detail}`
        : geometry && !geometry.ok
          ? `geometry: ${geometry.reason} — ${geometry.detail}`
          : null;
  for (const lineId of [...input.memberLineIds, ...input.displacedLineIds]) {
    if (covered.has(lineId)) continue;
    const skip = skipped.find((s) => s.startsWith(lineId));
    lines.push({
      lineId,
      role: input.memberLineIds.includes(lineId) ? "unit-member-unprojected" : "displaced-successor",
      flowIndex: null,
      originalTextLength: input.originalTextLengthOf(lineId),
      targetTextLength: null,
      originalBox: input.originalBoxOf(lineId),
      targetBox: null,
      originalBaselinePt: input.originalBaselinePtOf(lineId),
      predictedBaselinePt: null,
      deltaPt: null,
      deltaCss: null,
      breakFidelity: input.memberLineIds.includes(lineId)
        ? fidelityFor(flow, lineId, changedOk)
        : "unknown",
      coverage: null,
      status: skip ? "skipped" : "failed",
      reason: skip ?? failReason ?? "未进入几何投影（原因未记录 ⇒ 须人工复核）",
    });
  }

  if (flow.ok) warnings.push(...flow.warnings);
  if (projection.ok) warnings.push(...projection.warnings);
  if (geometry?.ok) warnings.push(...geometry.warnings);

  return {
    ok,
    stage: stageOf(),
    changedSource: input.changedSource,
    changedLineIds: [...input.changedLineIds],
    lines,
    flowMetrics: flow.ok
      ? {
          newLineCount: (flow as { metrics: { newLineCount: number } }).metrics.newLineCount,
          originalLineCount: (flow as { metrics: { originalLineCount: number } }).metrics.originalLineCount,
          usedLineGap: (flow as { metrics: { usedLineGap: number } }).metrics.usedLineGap,
          delta: (flow as { metrics: { delta: number } }).metrics.delta,
        }
      : { newLineCount: null, originalLineCount: null, usedLineGap: null, delta: null },
    warnings,
    skipped,
  };
}
