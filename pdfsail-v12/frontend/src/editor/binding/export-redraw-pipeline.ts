/**
 * editor/binding/export-redraw-pipeline.ts — F3B-6.28 · D-3B-1
 *
 * **导出侧**重绘几何流水线：plan（事务身份）→ flow → scope → 投影 → 几何 → 诊断。
 *
 * ── 定位 ─────────────────────────────────────────────────────────────
 *   · 3B-1 **只接几何与诊断**：产出 `lineGeometryOf`（供 bridge 惰性挂载）与
 *     逐行诊断；**不产生任何写入决策**、不改写 `glyph.modified` / raw-CID 条件。
 *   · 3B-2（未授权）才允许消费几何做真实重绘。
 *
 * ── changedLineIds 纪律 ──────────────────────────────────────────────
 *   只接受**事务来源**的变更行声明（`changedSource: "transaction"`）；
 *   事务映射不唯一 / 计划失效 ⇒ 调用方必须传 `"unresolved"` ⇒ 本模块按保守模式
 *   （全部成员行硬断行）并在诊断中记录 `unresolved`，绝不反推、绝不沿用旧声明。
 */

import { computeAffectedScope } from "./affected-scope-contract";
import { buildEditingUnit, type EditingUnit } from "./editing-unit";
import { computeFlowLayout } from "./logical-paragraph-flow-layout";
import { computeExportFlowProjection, type ExportFlowProjection } from "./export-flow-projection";
import {
  computeExportRedrawGeometry,
  type ExportRedrawGeometry,
  type ExportRedrawGeometryOutcome,
  type SourceGlyphGeometry,
} from "./export-redraw-geometry";
import { buildExportRedrawDiagnostics, type ExportRedrawDiagnostics } from "./export-redraw-diagnostics";
import { createDiffedLineMetrics, diffedIdentityByCodepoint } from "./diffed-line-metrics";
import { layoutTextBox } from "../core/layout";
import { getParagraphText } from "../core/document/query";
import type { EditorDocument } from "../core/document/types";
import type { EditableDocument } from "../../document-model/types";
import type { BindingSidecar } from "./binding-sidecar";
import { lookupGlyphRange } from "./binding-sidecar";
import type { DisplacedClearTarget } from "./affected-source-projection";
import { classifyRedrawGlyph, type RedrawGlyphDisposition } from "./export-redraw-gate";

export interface ExportRedrawPipelineInput {
  /** 导出时的 Core 文档（after） */
  readonly document: EditorDocument;
  /** import-time legacy 文档（原始盒 / glyph / 度量的唯一事实来源） */
  readonly legacyDocument: EditableDocument;
  readonly sidecar: BindingSidecar;
  /** plan 登记的 unit 成员行（blockId + lineId + Core 身份） */
  readonly memberLines: readonly DisplacedClearTarget[];
  /** plan 登记的位移行 */
  readonly displacedLines: readonly DisplacedClearTarget[];
  readonly changedLineIds: readonly string[];
  readonly changedSource: "transaction" | "unresolved";
  readonly renderScale: number;
  readonly cssScale: number;
  /**
   * Y 翻转基准（PDF pt = **MediaBox.y1**）。
   *
   * ⚠️ 不等于 Sidecar 的 `originYPt`（那是 MediaBox.y0）；翻转基准 =
   *   `页面 PDF 高 + y0`（与 export-renderer 的 `pageFlipBase` 同口径）。
   *   传入错误（如直接把 originYPt 当基准）⇒ 几何投影 fail-closed。
   */
  readonly flipBasePtOf: (pageIndexOneBased: number) => number | undefined;
}

export interface ExportRedrawPipelineResult {
  readonly ok: boolean;
  readonly stage: "inputs" | "flow" | "scope" | "projection" | "geometry" | null;
  readonly reason: string | null;
  readonly detail: string | null;
  readonly geometry: ExportRedrawGeometry | null;
  readonly diagnostics: ExportRedrawDiagnostics;
}

/** 与 document-model 无依赖的载荷形状（避免 binding → document-model 反向依赖） */
export interface LineRedrawPayload {
  readonly role: "flow-member" | "displaced-successor";
  readonly flowIndex: number | null;
  readonly sourceLineIds: readonly string[];
  readonly text: string;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly baselinePt: number;
  /**
   * F3B-6.28 · D-3B-4：该行的**原始 baseline**（PDF pt；位移行为原位置、成员行为首行原位）。
   * renderer 在重绘落笔前据此核验「原算子已完整剥离」（决策三：mask 不是清除证明）。
   */
  readonly originalBaselinePt: number | null;
  readonly deltaCss: number;
  readonly glyphs: readonly {
    readonly char: string;
    readonly sourceLineId: string;
    readonly sourceGlyphIndex: number | null;
    readonly pdfCharCode: number | null;
    readonly fontRef: string | null;
    readonly pdfTransform: readonly number[] | null;
    readonly targetXPt: number;
    readonly targetBaselinePt: number;
    /**
     * F3B-6.28 · D-3B-4（决策一）：无 provenance 字符的处置。
     *   raw=原字符有完整来源；skip=可证明的合成空白（不画）；
     *   fallback=新增字符（回退字体）；fail=原字符缺来源且非空白 ⇒ 拒绝导出。
     */
    readonly disposition: RedrawGlyphDisposition;
  }[];
}

function toPayload(line: ExportRedrawGeometry["lines"][number]): LineRedrawPayload {
  const isFinite6 = (t: readonly number[] | null | undefined): boolean =>
    !!t && t.length === 6 && t.every((v) => Number.isFinite(v));
  return {
    role: line.role,
    flowIndex: line.flowIndex ?? null,
    sourceLineIds: [...line.sourceLineIds],
    text: line.text,
    box: { x: line.box.x, y: line.box.y, width: line.box.width, height: line.box.height },
    baselinePt: line.baselinePt,
    originalBaselinePt: line.originalBaselinePt ?? null,
    deltaCss: line.deltaCss,
    glyphs: line.glyphs.map((g) => {
      const hasRaw = typeof g.pdfCharCode === "number" && isFinite6(g.pdfTransform);
      const isOriginal = g.sourceGlyphIndex !== null;
      return {
        char: g.char,
        sourceLineId: g.sourceLineId,
        sourceGlyphIndex: g.sourceGlyphIndex,
        pdfCharCode: g.pdfCharCode,
        fontRef: g.fontIdentity?.fontRef ?? null,
        pdfTransform: g.pdfTransform ? [...g.pdfTransform] : null,
        targetXPt: g.targetXPt,
        targetBaselinePt: g.targetBaselinePt,
        // 决策一（第 4 步）：无 provenance 字符的处置由**绑定侧**判定一次，
        // renderer 只执行（不在渲染层重写策略）。
        disposition: classifyRedrawGlyph({
          hasRawProvenance: hasRaw,
          isOriginalChar: isOriginal,
          char: g.char,
        }),
      };
    }),
  };
}

export interface ExportRedrawPipelineWithLookup extends ExportRedrawPipelineResult {
  /**
   * bridge 侧惰性查询：**按 legacy lineId** 取几何载荷（首条）。
   *
   * 3B-1：只挂载到 EditableLine（`redrawGeometry` 字段），**不消费于任何写入决策**；
   * 3B-2 才允许真重绘时消费它。
   */
  readonly payloadOfLineId: (lineId: string) => LineRedrawPayload | null;
  /**
   * F3B-6.28 · D-3B-2：bridge 侧惰性查询 —— 按 legacy lineId 取**全部**目标行。
   *
   * 一条 legacy 成员行被 flow 重排后可能对应多条视觉行（原文一行 + 追加内容溢出行），
   * 只取首条会漏画 ⇒ 3B-2 必须用本接口。
   */
  readonly payloadsOfLineId: (lineId: string) => readonly LineRedrawPayload[];
  /** 认领式取全部目标行（每条目标行只会被返回一次 ⇒ 不会重复绘制） */
  readonly claimPayloadsOfLineId: (lineId: string) => readonly LineRedrawPayload[];
  /** 从未被认领的目标行（调用方必须在挂载完成后检查并告警） */
  readonly unclaimedPayloads: () => readonly string[];
  /**
   * F3B-6.28 · D-3B-2：**重绘是否被授权消费**。
   *
   * 严格判据（任一项不满足 ⇒ false ⇒ 调用方不得把几何交给渲染器）：
   *   ① 整条链路 ok（flow / projection / geometry 全成功）；
   *   ② **每一条**成员行与位移行都真的进入了几何（status === "projected"）。
   *
   * ②的意义：原算子已被 drop 投影剥离的行，若重绘侧拿不到几何就会**静默缺行**。
   *   宁可整体拒绝重绘（回到 3B-2 之前的既有行为 + 显式告警），也绝不允许
   *   「清除了一部分、重绘了另一部分」的半成品 PDF。
   */
  readonly redrawEligible: boolean;
  /** redrawEligible=false 时的人可读原因（可观测，不静默） */
  readonly redrawRejectReason: string | null;
}

export function runExportRedrawPipeline(
  input: ExportRedrawPipelineInput,
): ExportRedrawPipelineWithLookup {
  const legacyLines = new Map<string, any>();
  let legacyPageIndex = 0;
  /**
   * ★ 2026-10-22（用户缺陷「cell 修改提交后没有填写到表格里」）：1-based **PDF 页号**
   *   （契约 = `EditablePage.index`，与 Sidecar/`flipBasePtOf` 同口径）。
   *   ⚠️ 不能用 `pages` **数组下标** +1：editableDocument 是**懒加载**的
   *   （初始第 1 页 + 用户访问页；实测 pages = [第1页, 第11页]，下标 1 = 第 11 页）
   *   ⇒ 下标+1 = 2 ⇒ Sidecar 查「页 2」miss ⇒ invalid-flip-base ⇒ 重绘资格被拒
   *   ⇒ D-3B-4/5 抛错 ⇒ 导出整体失败。缺 index 时退回下标+1（fail-open 兜底）。
   */
  let legacyPageOneBased = 1;
  const pageOneBasedOf = (page: any, arrayIndex: number): number =>
    typeof page?.index === "number" && Number.isFinite(page.index) && page.index >= 1
      ? page.index
      : arrayIndex + 1;
  (input.legacyDocument.pages ?? []).forEach((page: any, pi: number) => {
    for (const block of page.blocks ?? []) {
      for (const line of block.lines ?? []) {
        legacyLines.set(line.id, line);
        if (input.memberLines.some((m) => m.lineId === line.id)) {
          legacyPageIndex = pi;
          legacyPageOneBased = pageOneBasedOf(page, pi);
        }
      }
    }
  });

  const originalTextLengthOf = (lineId: string): number | null => {
    const ll = legacyLines.get(lineId);
    return ll ? (ll.glyphs ?? []).length : null;
  };
  const originalBoxOf = (
    lineId: string,
  ): { x: number; y: number; width: number; height: number } | null => {
    const ll = legacyLines.get(lineId);
    return ll?.bbox ? { x: ll.bbox.x, y: ll.bbox.y, width: ll.bbox.width, height: ll.bbox.height } : null;
  };
  const originalBaselinePtOf = (lineId: string): number | null => {
    const binding = input.memberLines.find((m) => m.lineId === lineId);
    const blockId = binding?.blockId ?? input.memberLines[0]?.blockId ?? "";
    const seq = lookupGlyphRange(input.sidecar, blockId, lineId);
    const f = seq[0]?.metrics?.pdfTransform?.[5];
    return typeof f === "number" && Number.isFinite(f) ? f : null;
  };
  const sourceGlyphsOf = (lineId: string): readonly SourceGlyphGeometry[] | null => {
    const blockId = input.memberLines.find((m) => m.lineId === lineId)?.blockId ?? input.memberLines[0]?.blockId ?? "";
    const seq = lookupGlyphRange(input.sidecar, blockId, lineId);
    if (seq.length === 0) return null;
    return seq.map((g) => ({
      originalChar: g.originalChar,
      pdfCharCode: g.pdfCharCode ?? g.metrics?.pdfCharCode,
      fontIdentity: g.fontIdentity ?? g.metrics?.fontIdentity,
      pdfTransform: g.metrics?.pdfTransform,
    }));
  };

  const emptyDiagnostics = (
    stage: ExportRedrawPipelineResult["stage"],
    reason: string,
    detail: string,
  ): ExportRedrawPipelineWithLookup => {
    const diagnostics = buildExportRedrawDiagnostics({
      flow: { ok: false, reason, detail },
      projection: { ok: false, reason, detail },
      geometry: null,
      memberLineIds: input.memberLines.map((m) => m.lineId),
      displacedLineIds: input.displacedLines.map((d) => d.lineId),
      originalTextLengthOf,
      originalBaselinePtOf,
      originalBoxOf,
      changedLineIds: input.changedLineIds,
      changedSource: input.changedSource,
    });
    return {
      ok: false,
      stage,
      reason,
      detail,
      geometry: null,
      diagnostics,
      payloadOfLineId: () => null,
      payloadsOfLineId: () => [],
      claimPayloadsOfLineId: () => [],
      unclaimedPayloads: () => [],
      redrawEligible: false,
      redrawRejectReason: `${stage}: ${reason} — ${detail}`,
    };
  };

  if (input.memberLines.length === 0) {
    return emptyDiagnostics("inputs", "no-member-lines", "plan 未登记任何 unit 成员行");
  }

  // ── ① flow 输入（与生产 C3 同款：真实度量管道 + legacy 原始盒）──────────
  const unitLines: { lineId: string; textBoxId: string; paragraphId: string; text: string }[] = [];
  /**
   * D-3B-6：成员行 → **字符身份映射**（新文本码点 → 原文本码点；null = 新增字符）。
   * 与 flow 输入同源构建（同一对 `ll` / `currentText`），供投影判定 glyph 身份；
   * 对齐不可用的行**不进表** ⇒ 投影对该行 fail-closed（`missing-source-identity`）。
   */
  const identityByLineId = new Map<string, readonly (number | null)[]>();
  const flowLines: {
    lineId: string;
    textBoxId: string;
    paragraphId: string;
    text: string;
    advances: number[];
    x: number;
    top: number;
    height: number;
    width: number;
  }[] = [];
  let constraintWidth = 0;
  for (const m of input.memberLines) {
    const ll = legacyLines.get(m.lineId);
    if (!ll) {
      return emptyDiagnostics("inputs", "legacy-line-missing", `成员行 ${m.lineId} 在 legacy 文档中不存在`);
    }
    // 当前文本优先按**登记的 Core 身份**取（与提交时同源）
    let currentText: string | null = null;
    let textBoxId = "";
    let paragraphId = "";
    if (m.coreIdentity) {
      currentText = currentParagraphTextOf(input.document, m.coreIdentity.textBoxId, m.coreIdentity.paragraphId);
      textBoxId = m.coreIdentity.textBoxId;
      paragraphId = m.coreIdentity.paragraphId;
    }
    if (currentText === null) {
      const fallback = findParagraphByLineId(input.document, m.lineId);
      if (!fallback) {
        return emptyDiagnostics("inputs", "core-identity-missing", `成员行 ${m.lineId} 无 Core 段落身份，无法取当前文本`);
      }
      currentText = fallback.text;
      textBoxId = fallback.textBoxId;
      paragraphId = fallback.paragraphId;
    }
    const diffed = createDiffedLineMetrics(ll, currentText);
    // D-3B-6：身份事实与度量同源构建（同一对 ll/currentText）；不可用则不登记（fail-closed）
    const identity = diffedIdentityByCodepoint(ll, currentText);
    if (identity) identityByLineId.set(m.lineId, identity);
    const laid: any = layoutTextBox(input.document, textBoxId, diffed.metrics);
    const paraLayout = laid?.layout?.paragraphs?.[0];
    const advances: number[] = new Array([...currentText].length).fill(Number.NaN);
    for (const ln of paraLayout?.lines ?? [])
      for (const run of ln.runs ?? [])
        for (const gl of run.glyphs ?? [])
          for (let k = 0; k < gl.length; k += 1) advances[gl.textIndex + k] = gl.advance;
    const cw: number = laid?.layout?.constraintBox?.width ?? 0;
    if (cw > 0) constraintWidth = Math.max(constraintWidth, cw);
    flowLines.push({
      lineId: m.lineId,
      textBoxId,
      paragraphId,
      text: currentText,
      advances,
      x: ll.bbox?.x ?? 0,
      top: ll.bbox?.y ?? 0,
      height: ll.bbox?.height ?? 21.46,
      width: cw || ll.bbox?.width || 0,
    });
    unitLines.push({ lineId: m.lineId, textBoxId, paragraphId, text: currentText });
  }

  // ── ② successors（**仅成员所在页**、同 block、位于 unit 之后的 legacy 行）───
  //   F3B-6.28 · D-3B-5：跨页推挤未授权 ⇒ successors 只从成员页收集（与 PDFEditor
  //   C3 的页面口径一致）。此前遍历全部页：第 2+ 页的行会按页内 y 混入流布局，
  //   却用成员页的 flipBase 计算几何 ⇒ 错位而非缺行（最危险的形态）。
  //   成员页不可判定 ⇒ 不收集（fail-closed；redrawEligible 会因必需行未投影而拒绝）。
  const legacyPagesAll = input.legacyDocument.pages ?? [];
  let memberPageIndex: number | null = null;
  for (let pi = 0; pi < legacyPagesAll.length; pi += 1) {
    for (const block of (legacyPagesAll[pi] as { blocks?: Array<{ id?: string }> }).blocks ?? []) {
      if (input.memberLines.some((m) => m.blockId === block.id)) {
        memberPageIndex = pi;
        break;
      }
    }
    if (memberPageIndex !== null) break;
  }
  if (memberPageIndex !== null) {
    legacyPageIndex = memberPageIndex;
    legacyPageOneBased = pageOneBasedOf(legacyPagesAll[memberPageIndex], memberPageIndex);
  }
  const lastMemberTop = Math.max(...input.memberLines.map((m) => legacyLines.get(m.lineId)?.bbox?.y ?? 0));
  const successors: { textBoxId: string; paragraphId: string; text: string; x: number; width: number; top: number; height: number }[] = [];
  const successorPage =
    memberPageIndex === null ? undefined : legacyPagesAll[memberPageIndex];
  const successorBlocks: Array<{ id?: string; lines?: never[] }> =
    (successorPage as { blocks?: Array<{ id?: string; lines?: never[] }> } | undefined)?.blocks ?? [];
  for (const block of successorBlocks) {
    if (input.memberLines.some((m) => m.blockId === block.id) === false) continue;
    for (const l of block.lines ?? []) {
      const bb = (l as { bbox?: { y?: number; x?: number; width?: number; height?: number } }).bbox;
      if ((bb?.y ?? 0) <= lastMemberTop) continue;
      if (input.memberLines.some((m) => m.lineId === (l as { id: string }).id)) continue;
      successors.push({
        textBoxId: (l as { id: string }).id,
        paragraphId: (l as { id: string }).id,
        text: ((l as { glyphs?: Array<{ char?: string }> }).glyphs ?? []).map((g) => g.char ?? "").join(""),
        x: bb?.x ?? 0,
        width: bb?.width ?? 0,
        top: bb?.y ?? 0,
        height: bb?.height ?? 21.46,
      });
    }
  }

  // ★ 行距（originalLineGap）——与 PDFEditor C3 显示层**同口径**（2026-10-22 缺陷修复）：
  //   · 多行组 ⇒ 相邻行 y 差（既有冻结语义，flow 自算校验）；
  //   · **单行组**（cell 面恒单成员行）⇒ 原实现 gap=0 ⇒ originalLineGap=undefined ⇒
  //     computeFlowLayout `missing-line-gap` fail-closed ⇒ 重绘资格被拒 ⇒
  //     D-3B-4/5 不变式抛错 ⇒ 整个导出 bridge-error ⇒ E-01 ⇒ 用户「修改提交后
  //     没有填写到表格里」（保存/导出直接失败，无 PDF 产出）。
  //   单行组的行距证据 = **同块相邻行** y 差（flow 契约：reflow 后行距必须 = 原始
  //   PDF 行距）：优先后继行（与 successors 同源），无后继（块末行）⇒ 前导行；
  //   皆无 ⇒ 0 ⇒ 调用方 fail-closed（块内唯一行的罕见形态不建重绘，不猜行距）。
  const singleMemberGap = ((): number => {
    if (flowLines.length !== 1) return 0;
    const top = flowLines[0]!.top;
    let nextTop: number | null = null;
    for (const s of successors) {
      if (s.top > top && (nextTop == null || s.top < nextTop)) nextTop = s.top;
    }
    if (nextTop != null) return nextTop - top;
    let prevTop: number | null = null;
    for (const block of successorBlocks) {
      if (input.memberLines.some((m) => m.blockId === block.id) === false) continue;
      for (const l of block.lines ?? []) {
        const y = (l as { bbox?: { y?: number } }).bbox?.y;
        if (typeof y !== "number" || y >= top) continue;
        if (input.memberLines.some((m) => m.lineId === (l as { id: string }).id)) continue;
        if (prevTop == null || y > prevTop) prevTop = y;
      }
    }
    return prevTop != null ? top - prevTop : 0;
  })();
  const gap = flowLines.length > 1 ? flowLines[1]!.top - flowLines[0]!.top : singleMemberGap;
  const flow = computeFlowLayout({
    lines: flowLines,
    constraintWidth,
    originalLineGap: gap > 0 ? gap : undefined,
    successors,
    // ★ unresolved ⇒ 不传 ⇒ 保守模式（全部成员行硬断行 + flow 记录 unresolved）
    changedLineIds: input.changedSource === "transaction" ? input.changedLineIds : undefined,
  });
  if (!flow.ok) {
    return emptyDiagnostics("flow", flow.reason, flow.detail);
  }

  // ── ③ scope ────────────────────────────────────────────────────────
  const unitBuilt = buildEditingUnit({
    unitId: "export-redraw",
    blockId: input.memberLines[0]!.blockId,
    kind: "explicit-multi-line",
    lines: unitLines.map((l) => ({
      lineId: l.lineId,
      textBoxId: l.textBoxId,
      paragraphId: l.paragraphId,
      text: l.text,
    })),
  } as never);
  if (!unitBuilt.ok) {
    return emptyDiagnostics("scope", "unit-build-failed", "导出侧无法由成员行重建 editing unit");
  }
  const unit = (unitBuilt as { ok: true; unit: EditingUnit }).unit;
  const scope = computeAffectedScope(unit, flow, originalBoxOf as never);
  if (!scope.ok) {
    return emptyDiagnostics("scope", scope.reason, scope.detail ?? "");
  }

  // ── ④ 投影 + ⑤ 几何 ────────────────────────────────────────────────
  const sourceGlyphLengthsOf = (lineId: string): number[] | null => {
    const ll = legacyLines.get(lineId);
    return ll ? (ll.glyphs ?? []).map((g: any) => [...(g.char ?? "")].length) : null;
  };
  const sourceBaselineOf = (lineId: string): number | null => {
    const g = legacyLines.get(lineId)?.glyphs?.[0];
    return typeof g?.baseline === "number" ? g.baseline : null;
  };
  const sourceAdvancesOf = (lineId: string): number[] | null => {
    const f = flowLines.find((l) => l.lineId === lineId);
    return f ? [...f.advances] : null;
  };
  // D-3B-6：glyph 身份的唯一来源（LCS 对齐事实）；缺 ⇒ 投影 fail-closed
  const sourceIdentityOf = (lineId: string): readonly (number | null)[] | null =>
    identityByLineId.get(lineId) ?? null;
  const totalScale = input.renderScale * input.cssScale;
  const projection = computeExportFlowProjection({
    flow,
    scope,
    sourceIdentityOf,
    sourceGlyphLengthsOf,
    sourceBaselineOf,
    sourceAdvancesOf,
    totalScale,
  });

  let geometry: ExportRedrawGeometryOutcome | null = null;
  if (projection.ok) {
    const pageTopPt = input.flipBasePtOf(legacyPageOneBased);
    geometry =
      pageTopPt === undefined
        ? {
            ok: false,
            reason: "invalid-flip-base",
            detail: `页 ${legacyPageOneBased} 无 pageTopPt（Sidecar 未提供 originYPt）`,
          }
        : computeExportRedrawGeometry({
            projection,
            sourceGlyphsOf,
            displacedBoxOf: (lineId) => {
              const item = (scope as unknown as { items: readonly { role: string; sourceLineId: string; originalRect?: { x: number; y: number; width: number; height: number } | null }[] }).items.find(
                (i) => i.role === "displaced-successor" && i.sourceLineId === lineId,
              );
              return item?.originalRect ?? null;
            },
            exportContext: {
              renderScale: input.renderScale,
              cssScale: input.cssScale,
              pageHeightPt: pageTopPt,
              pageTopPt,
            },
          });
  }

  const diagnostics = buildExportRedrawDiagnostics({
    flow,
    projection: projection as ExportFlowProjection,
    geometry,
    memberLineIds: input.memberLines.map((m) => m.lineId),
    displacedLineIds: input.displacedLines.map((d) => d.lineId),
    originalTextLengthOf,
    originalBaselinePtOf,
    originalBoxOf,
    changedLineIds: input.changedLineIds,
    changedSource: input.changedSource,
  });

  const geo = geometry && geometry.ok ? geometry : null;
  /** 按 legacy lineId 取几何载荷（bridge 侧由 Core 身份 / 结构位置回查 lineId 后调用） */
  const payloadOfLineId: (lineId: string) => LineRedrawPayload | null = (lineId) => {
    if (!geo) return null;
    const hit = geo.lines.find((l) => l.sourceLineIds.includes(lineId));
    return hit ? toPayload(hit) : null;
  };
  /** 与 payloadOfLineId 同源，但取**全部**目标行（3B-2 真重绘用） */
  const payloadsOfLineId: (lineId: string) => readonly LineRedrawPayload[] = (lineId) => {
    if (!geo) return [];
    return geo.lines.filter((l) => l.sourceLineIds.includes(lineId)).map(toPayload);
  };
  /**
   * 3B-2：**认领式**取全部目标行。
   *
   * 一条目标行可能同时被多个 legacy 行命中（成员行与其合成行共享同一段落），
   * 若各行都拿到它 ⇒ 同一行文字被画两遍（实测重复）。故用「先到先认领」保证
   * **每条目标行只挂到一条 legacy 行上**。
   */
  const claimed = new Set<number>();
  const claimPayloadsOfLineId: (lineId: string) => readonly LineRedrawPayload[] = (lineId) => {
    if (!geo) return [];
    const out: LineRedrawPayload[] = [];
    geo.lines.forEach((l, i) => {
      if (claimed.has(i)) return;
      if (!l.sourceLineIds.includes(lineId)) return;
      claimed.add(i);
      out.push(toPayload(l));
    });
    return out;
  };
  /** 未被任何 legacy 行认领的目标行（>0 ⇒ 该行不会被重绘，必须显式告警） */
  const unclaimedPayloads: () => readonly string[] = () => {
    if (!geo) return [];
    return geo.lines.filter((_, i) => !claimed.has(i)).map((l) => `${l.role}#${l.flowIndex ?? "-"}:${l.sourceLineIds.join("+")}`);
  };

  // ── 3B-2 重绘资格（严格：缺一不可，拒绝而非半量重绘）───────────────────
  const requiredLineIds = [
    ...input.memberLines.map((m) => m.lineId),
    ...input.displacedLines.map((d) => d.lineId),
  ];
  // ★★ 2026-10-19（用户缺陷「download fail」最后一层）：projected 集合改用
  //   **几何行的来源并集**（geo.lines[].sourceLineIds）。旧实现按**诊断条目的
  //   lineId**（= 首来源）记账 ⇒ 段内连续重排产生的「多来源合并行」
  //   （如 l6 尾 + l7 同排一行，sourceLineIds=[l6,l7]）只记到 l6 名下 ⇒
  //   l7 被误判「未进入几何」⇒ redrawEligible=false ⇒ E-01 拒绝导出。
  //   语义修正：**l7 的字符确实已被该几何行重绘**（payload 覆盖 l7 全部字符）
  //   ⇒ 资格成立。诊断条目仍按首来源记账（兼容既有消费方）。
  const projected = new Set<string>(
    (geo && geo.ok ? geo.lines : []).flatMap((l) => l.sourceLineIds),
  );
  const missing = requiredLineIds.filter((id) => !projected.has(id));
  const redrawEligible = diagnostics.ok && missing.length === 0;
  const redrawRejectReason =
    redrawEligible
      ? null
      : !diagnostics.ok
        ? `链路未成功（stage=${diagnostics.stage}）⇒ 拒绝重绘`
        : `以下行未进入几何 ⇒ 拒绝重绘（避免清除后缺行）: ${missing.slice(0, 6).join(", ")}${
            missing.length > 6 ? ` …(+${missing.length - 6})` : ""
          }`;

  return {
    ok: diagnostics.ok,
    stage: diagnostics.stage,
    reason:
      geometry && !geometry.ok ? geometry.reason : !projection.ok ? projection.reason : null,
    detail: geometry && !geometry.ok ? geometry.detail : !projection.ok ? projection.detail : null,
    geometry: geo,
    diagnostics,
    payloadOfLineId,
    payloadsOfLineId,
    claimPayloadsOfLineId,
    unclaimedPayloads,
    redrawEligible,
    redrawRejectReason,
  };
}

function currentParagraphTextOf(
  document: EditorDocument,
  textBoxId: string,
  paragraphId: string,
): string | null {
  for (const page of document.pages ?? []) {
    for (const obj of (page as any).objects ?? []) {
      if (obj.type !== "text" || obj.id !== textBoxId) continue;
      for (const para of obj.paragraphs ?? []) {
        if (para.id === paragraphId) return getParagraphText(para);
      }
    }
  }
  return null;
}

function findParagraphByLineId(
  document: EditorDocument,
  lineId: string,
): { text: string; textBoxId: string; paragraphId: string } | null {
  for (const page of document.pages ?? []) {
    for (const obj of (page as any).objects ?? []) {
      if (obj.type !== "text") continue;
      for (const para of obj.paragraphs ?? []) {
        if ((para.runs ?? []).some((r: any) => r.source?.lineId === lineId)) {
          return { text: getParagraphText(para), textBoxId: obj.id, paragraphId: para.id };
        }
      }
    }
  }
  return null;
}
