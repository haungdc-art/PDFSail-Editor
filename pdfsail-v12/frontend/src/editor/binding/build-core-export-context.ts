/**
 * build-core-export-context.ts — EDITOR-CORE-012-F2
 *
 * Core Export Shadow Path 的 production-facing context builder。
 *
 * 职责：把真实生产里的
 *   - Core `EditorDocument`（来自 `coreInputSessionRef` 或 legacy 引导一次）
 *   - 真实 `runtime`（renderScale / cssScale / pageMetrics）
 *   - 生产 Core 布局（buildCoreRenderSourceFromDocument → layoutTextBox，fallback metrics）
 *   - 真实 PDF source geometry（**BindingSidecar**：`blockOriginalBounds` / `pages[].originYPt`）
 * 组装成 `buildEditableDocument` 所需的注入项，产出可被现有 `exportEditableDocument` 消费的
 * `EditableDocument`。
 *
 * 设计红线（同 012-F forbidden）：
 *   - 不重新 layout / 不 measureText / 不碰 canvas（布局复用生产引擎）
 *   - 不伪造 originalBounds（只复用 Sidecar 真实 PDF 检测框；`detected !== true` → fail-closed）
 *   - 不伪造 PDF provenance（provenance 来自 `TextRun.source`，桥接原样派生）
 *   - 不引入第二套坐标系 / 不引入 PDF pt 到 Core
 *   - 不使用 1/1 runtime fallback 进入 production shadow：runtime 缺失 → 返回 null（abort）
 *   - 不改 `useExport` 默认下载、不删 `applySegmentEditsToDocument`、不删 legacy export
 *
 * 它仍然是 **Shadow Path**：`runCoreShadowExport` 的产物只做诊断，绝不下载 / 替换用户结果。
 * `CORE_EXPORT_PRODUCTION_WIRED` 仍为 false（F2 不接 production）。
 */

import type { EditorDocument, TextRun, TextSourceBinding } from "../core/document/types";
import { allTextBoxes } from "../core/document";
import type { CoreInputSession } from "./core-input-source";
import { createCoreInputSession, documentOf } from "./core-input-source";
import { buildCoreRenderSourceFromDocument, buildMetricsByTextBoxFromLegacy } from "./core-render-source";
import { isExportMetricsAlignEnabled } from "./export-metrics-align";
import type { TextLayout } from "../core/layout/types";
import type { FontMetricsProvider } from "../core/layout";
import { createFontMetricsProvider } from "../core/layout";
import { characterAwareFallbackAdvance } from "../core/layout/fallback-advance";
import type { BBox, EditableDocument, EditableDocumentRuntime } from "../../document-model/types";
import type { exportEditableDocument as _exportEditableDocument } from "../../document-model";
import { buildEditableDocument } from "./pdf-export-bridge";
import type { BindingSidecar } from "./binding-sidecar";
import { createCoreExportBoundsProvider } from "./core-export-bounds-provider";
// F3B-6.17-3C-6A.1-CB2：Core→Legacy bridge 的 operator provenance provider（Sidecar 唯一来源）
import {
  createSidecarGlyphMetricsProvider,
  createSidecarGlyphRawProvenanceProvider,
  createSidecarGlyphProvenanceProvider,
  createSidecarLineFontIdentityProvider,
} from "./export-glyph-provenance";
// F3B-6.17-3C-6B1.1：Core 编辑 → 原 PDF operator 的 export drop 投影（纯 Binding 层）
// F3B-6.28 · D 第一阶段：同模块新增 `DisplacedLineTarget`（位移行清除投影的输入类型）
import {
  computeAffectedSourceProjection,
  projectExportDrop,
  type DisplacedClearTarget,
} from "./affected-source-projection";
// F3B-6.28 · D-3B-1：重绘几何流水线（诊断 + 惰性挂载）
import { runExportRedrawPipeline, type LineRedrawPayload } from "./export-redraw-pipeline";
// F3B-6.28 · D-3B-4：显式重绘写入资格门（D-3B-5 起缺省 ON，显式 false 回滚）
import { decideExportRedrawGate, readExportRedrawFlag } from "./export-redraw-gate";
// F3B-6.28 · D-3B-5 / D-3B-6：场景授权集合（D1 段落末尾追加 + D2 段落内部插入；其余不参与）
//   ★ 与 PDFEditor 侧**共用同一授权集合**：两侧必须同时放行才会执行清除+重绘，
//     否则会出现「入口已放行、导出侧不放行」的授权链路不一致（D-3B-6 步骤 4 实测）。
import { EXPORT_REDRAW_AUTHORIZED_SCENARIOS } from "./export-redraw-scenario";
import type { ExportRedrawScenario } from "./export-redraw-scenario";
import type { ExportRedrawDiagnostics } from "./export-redraw-diagnostics";
import { isModifiedRun, provenanceOfBinding } from "./provenance";
import { editableDocumentToEditorDocument } from "../legacy";
// B3-C-5-B：ImportResult.assets 进入运行时 registry（Core ↔ Binding 资源生命周期接缝）
import { ImageAssetRegistry, imageAssetRegistry } from "./image-asset-registry";

/** 与现有 `exportEditableDocument` 完全一致的签名（避免 strictFunctionTypes 下的参数协变问题） */
type ExportEditableDocumentFn = typeof _exportEditableDocument;

/** 诊断 shadow 开关（与 012-A 的 `__coreRender` 同风格，默认关） */
export const CORE_EXPORT_SHADOW_FLAG = "__coreExportShadow";

export interface CoreExportContextInput {
  /** 真实生产 Core EditorDocument（调用方从 `coreInputSessionRef` 或 legacy 引导取得） */
  document: EditorDocument;
  /**
   * ⚠️ F3B-6.17 3B'-B.2：**Core export 的 fidelity bounds 已不再读取本字段**。
   *
   * 保留仅为兼容既有调用方（Legacy export 路径尚未迁移），**不是** bounds source。
   * 参数清理留待后续；Core bounds 只认 `sidecar`。
   */
  legacyDocument?: EditableDocument | null;
  /** 真实生产 runtime。缺失则 shadow 必须 abort（F2-C，禁止 1/1 fallback） */
  runtime?: EditableDocumentRuntime;
  /** 可选覆盖：每页 originYPt（默认取 `sidecar.pages[pageIndex].originYPt`） */
  pageTopPt?: (pageIndex: number) => number | undefined;
  /**
   * F3B-6.17 3B'-B：BindingSidecar（immutable import-time PDF fidelity artifact）。
   *
   * Core export bounds 的**唯一**来源。缺失 ⇒ provider 全部 fail-closed（undefined），
   * ⇒ eligibility / orchestration 回退 legacy，**绝不**回读 `legacyDocument`。
   */
  sidecar?: BindingSidecar | null;
  /**
   * F3B-6.17-3C-6B1.1：**编辑前**的 Core 文档（= import-time / 最近一次 rehydrate 快照）。
   *
   * 与 `document`（当前 Core）构成 `before/after`，供 `computeAffectedSourceProjection`
   * 判定「哪些语义行被编辑过」，从而把 Sidecar 里的**原算子**投影为导出需要的
   * `droppedOperatorIds` / `editedOriginalBounds`。
   *
   * · 缺省 ⇒ `before === after` ⇒ 无受影响行 ⇒ 不产生任何 drop（fail-soft，绝不猜）。
   * · 该快照**不随编辑变化**（PDFEditor 仅在 import/rehydrate 时写 `coreDocumentRef`），
   *   因此它天然覆盖「多次编辑累积」。
   */
  beforeDocument?: EditorDocument | null;
  /**
   * F3B-6.28 · D 第一阶段：被段落重排**位移**的原始行（文本未变，旧位置原算子必须剥离）。
   *
   * 这些行 before/after 文本与段落归属都未变 ⇒ diff 发现不了，只能由受控 unit 编辑
   * （`__unitEditing`）的流布局在提交时显式声明，经 `useExport` 传到这里。
   * 缺省 ⇒ 不产生位移清除（行为与本阶段之前逐字段一致）。
   */
  displacedLines?: readonly DisplacedClearTarget[] | null;
  /** F3B-6.28 · D 第二步（决策二）：unit 全部成员行（原算子必须剥离） */
  unitMemberLines?: readonly DisplacedClearTarget[] | null;
  /**
   * F3B-6.28 · D-3B-1：本次事务**实际改动**的成员行（原始断行保真的授权来源）。
   *
   * 必须与 `displacedLines`/`unitMemberLines` 来自**同一条已校验通过**的计划：
   * 计划失效（Undo/Redo/事务被取代/文档切换）⇒ 调用方**不得**传（传 null）。
   * 传 `null` ⇒ 保守模式（全部成员行硬断行 + `original-break-unresolved`）。
   */
  changedLineIds?: readonly string[] | null;
  /**
   * F3B-6.28 · D-3B-5：计划的**场景授权**（`DisplacedClearPlan.scenario`）。
   *
   * 用户 2026-10-14 裁决：生产 gate 已开启；2026-10-15 冻结契约（D-3B-6）
   * 把授权集合扩为 D1 段落末尾追加 **+ D2 段落内部插入**
   * （`EXPORT_REDRAW_AUTHORIZED_SCENARIOS`，导出侧与 PDFEditor 侧共用）。
   * 其它场景（替换/删除/合并/多段落流动/跨页推挤）⇒ 本字段非授权值 ⇒
   * unit 计划输入整体失效（清除与重绘都不做）⇒ 导出走既有路径。
   *
   * ⚠️ 必须与上面三者同源同计划：计划失效 ⇒ 传 null（不猜场景）。
   */
  unitRedrawScenario?: ExportRedrawScenario | null;
}

export interface CoreExportContext {
  readonly document: EditorDocument;
  readonly runtime: EditableDocumentRuntime;
  readonly layoutOf: (textBoxId: string) => TextLayout | null;
  readonly originalBoundsOf: (blockId: string) => BBox | undefined;
  readonly pageTopPt: (pageIndex: number) => number | undefined;
  /** 组装成 EditableDocument（供 exportEditableDocument 消费） */
  toEditableDocument(): { document: EditableDocument; warnings: readonly string[] };
  /**
   * F3B-6.28 · D-3B-1：重绘几何逐行诊断（**只读**）。
   *
   * ⚠️ 诊断 `ok === true` **不授权**重绘；3B-2 未授权前本字段只用于验收取证。
   */
  redrawDiagnostics: () => ExportRedrawDiagnostics | null;
}

export type CoreExportShadowResult =
  | { ok: true; bytes: Uint8Array; warnings: readonly string[] }
  | { ok: false; error: unknown };

/**
 * 组装 Core → Export Binding Context。
 *
 * @returns null 表示 runtime 不完整（F2-C），调用方应 warning + 继续 legacy export，
 *          绝不可用 1/1 runtime 顶替。
 */
export function buildCoreExportContext(input: CoreExportContextInput): CoreExportContext | null {
  const { document } = input;
  const runtime = input.runtime;

  // F2-C：renderScale / cssScale / pageMetrics 任一缺失 → abort（不允许 fallback 进 production shadow）
  if (!runtime || runtime.renderScale == null || runtime.cssScale == null || !runtime.pageMetrics) {
    return null;
  }

  // F2-D：layoutOf 复用生产 Core 布局引擎。buildCoreRenderSourceFromDocument 内部调用
  // layoutTextBox（fallback metrics = 生产 render source 几何），不重新 layout / 不 measureText / 不碰 canvas。
  // SCALE-MISMATCH-01（EXPORT-SPACE-02）S2：EXPORT_METRICS_ALIGN_FLAG 启用时注入与
  // 屏幕同款的 metrics builder（buildMetricsByTextBoxFromLegacy），使导出 relayout 的
  // advance/换行依据与屏幕一致；默认关闭 = 现状（空 provider 兜底）逐位不变。
  let metricsByTextBox: Map<string, FontMetricsProvider> | undefined;
  let metricsFallbackProvider: FontMetricsProvider | undefined;
  if (isExportMetricsAlignEnabled() && input.legacyDocument) {
    const injected = buildMetricsByTextBoxFromLegacy(input.legacyDocument, document);
    metricsByTextBox = injected;
    // 覆盖缺口必须明确记录（不静默声称已与屏幕对齐）：缺 entry ⇒ injected=false ⇒ 兜底。
    const textBoxIds = (document.pages ?? []).flatMap((p: any) =>
      (p.objects ?? []).filter((o: any) => o?.type === "text").map((o: any) => o.id),
    );
    const missing = textBoxIds.filter((id: string) => !injected.has(id));
    if (missing.length > 0) {
      console.warn(
        `[EXPORT-METRICS-ALIGN] ${missing.length} textBox 无 legacy metrics 覆盖（将走 fallback 兜底）: ` +
          missing.slice(0, 8).join(", ") + (missing.length > 8 ? " …" : ""),
      );
    }
    // A1-α（SCALE-MISMATCH-01 · EXPORT-SPACE-02）：仅对 metricsByTextBox 缺口的 TextBox
    // 提供导出专用 character-aware 兜底（CJK 1.0em / 其余 0.5em，复用 metrics.ts 既有
    // policy 形状适配）；有真实 metrics 的 TextBox 不受影响。flag 关 = 本分支不执行 = 现状。
    metricsFallbackProvider = createFontMetricsProvider({
      fallbackAdvance: (q: { char: string; style: { fontSize: number } }) =>
        characterAwareFallbackAdvance({ char: q.char, fontSize: q.style.fontSize }),
    });
  }
  const layoutOutcome = buildCoreRenderSourceFromDocument(
    document,
    metricsByTextBox ? { metricsByTextBox, metricsFallbackProvider } : {},
  );
  const layoutMap = new Map<string, TextLayout>();
  if (layoutOutcome.ok) {
    for (const layout of layoutOutcome.layouts) {
      layoutMap.set(layout.textBoxId, layout);
    }
  }
  const layoutOf = (textBoxId: string): TextLayout | null => layoutMap.get(textBoxId) ?? null;

  // ── F3B-6.17 3B'-B.2：bounds 唯一来源 = BindingSidecar ────────────────
  // Core export 的 PDF fidelity bounds（originalBounds / page originYPt）**只**来自
  // BindingSidecar（import-time immutable artifact）。`legacyDocument` **不再参与**
  // Core bounds，且**不保留任何 fallback**：
  //     ❌ sidecar miss → legacyDocument
  //     ❌ originalBounds miss → legacy block
  //     ❌ pageTopPt miss → legacy originYPt
  // sidecar 缺失 ⇒ provider 全部 fail-closed（undefined）⇒ eligibility / orchestration 回退。
  const boundsProvider = createCoreExportBoundsProvider(input.sidecar);

  // F2-E 语义保持：绝不捏造 originalBounds，也绝不退回 TextBox bbox / RenderFrame bbox
  //（二者语义不同，F1 已确认）；未检测（detected !== true）一律 fail-closed。
  const originalBoundsOf = (blockId: string): BBox | undefined =>
    boundsProvider.originalBoundsOf(blockId);

  // pageIndex 契约 = `EditablePage.index`（**1-based**，与 pdf-export-bridge 的
  // `options.pageTopPt?.(page.index)` 调用约定一致），不是 pages 数组下标。
  const pageTopPt =
    input.pageTopPt ?? ((pageIndex: number) => boundsProvider.pageTopPt(pageIndex));

  // F3B-6.28 · D-3B-1：重绘诊断容器（在 `toEditableDocument()` 内填充，供上层只读取证）
  let ctxRedrawDiagnostics: ExportRedrawDiagnostics | null = null;

  return {
    document,
    runtime,
    layoutOf,
    originalBoundsOf,
    pageTopPt,
    toEditableDocument() {
      // ── F3B-6.28 · D-3B-4 → D-3B-5：显式重写资格门 + 场景授权 ──────────
      //   门关闭 **或** 场景未授权 ⇒ **清除与重绘都不做**（而不是「只清不画」
      //   ——那会产出缺行 PDF）。即：unit 计划的成员行/位移行输入整体失效
      //   ⇒ 导出回到既有路径（与 3B-4 之前逐字节一致）。
      //   · D-3B-5（用户 2026-10-14 裁决）：门缺省 ON，但只授权 D1 段落末尾追加；
      //   · D-3B-6（2026-10-15 冻结契约 + 2026-10-16 用户批准）：授权集合扩为
      //     D1 + D2 段落内部插入；本处（导出侧**第二跳**）与 PDFEditor 侧必须同集合。
      //   · SSR / Node（无 window）⇒ readExportRedrawFlag() 保守关闭 ⇒ 测试环境不变。
      const redrawGateOpen = readExportRedrawFlag();
      const redrawScenario = input.unitRedrawScenario ?? null;
      // D-3B-6：判等改为「授权集合」成员判定（null 不在集合内 ⇒ 语义与旧判等一致）。
      const redrawScenarioAuthorized =
        redrawScenario !== null && EXPORT_REDRAW_AUTHORIZED_SCENARIOS.includes(redrawScenario);
      const redrawAuthorized = redrawGateOpen && redrawScenarioAuthorized;
      const effUnitMemberLines = redrawAuthorized ? input.unitMemberLines ?? null : null;
      const effDisplacedLines = redrawAuthorized ? input.displacedLines ?? null : null;
      const hasPlanInput =
        (input.unitMemberLines ?? []).length > 0 || (input.displacedLines ?? []).length > 0;
      if (!redrawAuthorized && hasPlanInput) {
        // 拒绝原因可观测：门关闭优先归因 gate-closed；否则是场景未授权。
        const rejectReason = !redrawGateOpen ? "gate-closed" : "scenario-not-authorized";
        try {
          (globalThis as unknown as Record<string, unknown>).__d3b2GateReject = rejectReason;
        } catch {
          /* ignore */
        }
        if (typeof console !== "undefined") {
          console.warn(
            `[F3B-6.28][3B4-REDRAW-REJECT] 重写资格未取得（${rejectReason}` +
              `${rejectReason === "scenario-not-authorized" ? `, scenario=${redrawScenario ?? "null"}` : ""}）⇒ ` +
              "本导出不做 unit 清除/重绘，走既有路径",
          );
        }
      }
      // ── F3B-6.17-3C-6B1.1：Core 编辑 → Sidecar 原算子（Binding 侧 export drop 投影）──
      //   ① before/after + Sidecar ⇒ 受影响原行（哪些原 PDF glyph/operator 被覆盖）
      //   ② 投影为 export 需要的 droppedOperatorIds / editedOriginalBounds
      //   ③ 经 bridge 的 `lineDropOf` overlay 写入 EditableDocument（**不改 Core，不改 Sidecar**）
      //   · coverage=UNKNOWN ⇒ drop.lines 为空 ⇒ 什么都不写（fail-closed）
      //   · coverage=PARTIAL ⇒ 只写**已知**算子（failClosed=true 由投影标注；导出侧既有的
      //     「缺 operatorId 的可见 glyph ⇒ 不视为完全剥离」逻辑继续保证不误解锁 mask）
      const sourceProjection = computeAffectedSourceProjection({
        before: input.beforeDocument ?? document,
        after: document,
        sidecar: input.sidecar,
        // F3B-6.28 · D 第一阶段：位移行（旧位置必须清除，但 diff 发现不了）
        displacedLines: effDisplacedLines,
        // F3B-6.28 · D 第二步（决策二）：unit 全部成员行（都会被 flow 重绘 ⇒ 原算子必须剥离）
        unitMemberLines: effUnitMemberLines,
      });
      const dropProjection = projectExportDrop(sourceProjection, { redrawGranularity: "line" });
      // F3B-6.28 · D-3B-2：清除集合规模（可观测；「清除了却没重绘」= 缺行 PDF，必须能一眼看出）
      if (typeof console !== "undefined") {
        console.log(
          `[F3B-6.28][3B2-DROP] members=${(effUnitMemberLines ?? []).length} ` +
            `displaced=${(effDisplacedLines ?? []).length} dropLines=${dropProjection.lines.length} ` +
            `coverage=${sourceProjection.coverage}`,
        );
      }
      /**
       * 两张索引：
       *   ① Core id（`textBoxId|paragraphId`）—— id 空间一致时命中；
       *   ② **结构位置**（`pageIndex:textBoxIndex:paragraphIndex`）—— id 空间不一致
       *      （Core session 由 legacy 引导的第二次 adapter 调用创建）时的稳定回退。
       */
      const dropByCoreIdentity = new Map<string, (typeof dropProjection.lines)[number]>();
      const dropByPosition = new Map<string, (typeof dropProjection.lines)[number]>();
      /**
       * D-3B-1：匹配键 → **legacy lineId**（重绘几何 overlay 用）。
       *   与 dropBy* 同源同构（一次遍历产出两张索引，避免第二套匹配口径）。
       */
      const dropLineIdByIdentity = new Map<string, string>();
      const dropLineIdByPosition = new Map<string, string>();
      for (const line of dropProjection.lines) {
        // F3B-6.28 · D 身份修复：有提交时登记的 Core 段落身份时，**只**登记该权威对
        //   （与 after 文档同源 ⇒ bridge 查询必中）；避免把 before/after 两个 id 空间的
        //   textBoxId 与 paragraphId 交叉配对产生永不可命中的混合键。
        //   无登记身份（位移行 / legacy mutateLineText 路径）维持原快照口径。
        const ci = line.coreIdentity;
        if (ci.registered) {
          dropByCoreIdentity.set(`${ci.registered.textBoxId}|${ci.registered.paragraphId}`, line);
        } else {
          for (const paragraphId of ci.paragraphIds) {
            dropByCoreIdentity.set(`${ci.textBoxId}|${paragraphId}`, line);
          }
        }
        for (const position of ci.positions) {
          dropByPosition.set(position, line);
        }
        // D-3B-1：同一循环产出 lineId 索引（与 dropBy* 完全同源）
        for (const pid of ci.paragraphIds) {
          dropLineIdByIdentity.set(`${ci.textBoxId}|${pid}`, line.lineId);
        }
        if (ci.registered) {
          dropLineIdByIdentity.set(`${ci.registered.textBoxId}|${ci.registered.paragraphId}`, line.lineId);
        }
        for (const position of ci.positions) {
          dropLineIdByPosition.set(position, line.lineId);
        }
      }

      // ── Step 5B：import-time 快照的行来源索引（整行 replace 的行身份回溯）──────
      //   key ① `paragraphId`（replace 前后稳定）
      //   key ② 结构位置 `pageIndex:textBoxIndex:paragraphIndex`（id 空间不一致时）
      //   缺 `beforeDocument` ⇒ 空表 ⇒ 行为与未注入时逐字段一致。
      const beforeLineSources = new Map<string, TextSourceBinding>();
      {
        const before = input.beforeDocument;
        for (let pi = 0; before && pi < before.pages.length; pi++) {
          // ★ 2026-10-22：posKey 页号 = **page.index - 1**（0-based PDF 页号，与
          //   bridge 查询键同口径；懒加载子文档的下标 ≠ 页号-1，见 pdf-export-bridge）。
          const beforePage = before.pages[pi] as { index?: unknown; objects?: unknown[] };
          const beforePageNo =
            typeof beforePage?.index === "number" && Number.isFinite(beforePage.index) && beforePage.index >= 1
              ? beforePage.index - 1
              : pi;
          const objects = (beforePage.objects ?? []) as Array<Record<string, unknown>>;
          for (let ti = 0; ti < objects.length; ti++) {
            const obj = objects[ti] as { type?: string; paragraphs?: Array<Record<string, unknown>> };
            if (obj.type !== "text") continue;
            const paragraphs = obj.paragraphs ?? [];
            for (let pii = 0; pii < paragraphs.length; pii++) {
              const para = paragraphs[pii] as {
                id?: string;
                runs?: Array<{ source?: TextSourceBinding }>;
              };
              const source = para.runs?.find((r) => r.source?.lineId)?.source;
              if (!source?.lineId || !para.id) continue;
              if (!beforeLineSources.has(para.id)) beforeLineSources.set(para.id, source);
              const posKey = `${beforePageNo}:${ti}:${pii}`;
              if (!beforeLineSources.has(posKey)) beforeLineSources.set(posKey, source);
            }
          }
        }
      }

      // ── F3B-6.28 · D-3B-1/3B-2/3B-4：重绘几何流水线（几何惰性挂载 + 逐行诊断）──
      //   ⚠️ 红线：本段**不参与任何既有写入资格判定**：
      //      · 不写 droppedOperatorIds（那是上面 drop 投影的职责，未改动）；
      //      · 不改 glyph.modified / raw-CID 条件；
      //      · 重绘的**唯一**开关 = 第 4 步显式门 + 严格资格判据。
      //   计划未登记成员行 / Sidecar 缺失 ⇒ 不计算（诊断 null，行为逐字段不变）。
      let redrawPayloadOf: ((lineId: string) => LineRedrawPayload | null) | null = null;
      let redrawPayloadsOf: ((lineId: string) => readonly LineRedrawPayload[]) | null = null;
      /** 认领状态查询（挂载结束后核对「有没有目标行没人认领」） */
      let unclaimedRedrawsOf: (() => readonly string[]) | null = null;
      /** 本次挂载实际落到哪些 legacy 行上（可观测：挂载数 vs 命令数不一致 ⇒ 渲染层丢命令） */
      let redrawMounted: string[] = [];
      // ★ F3B-6.28 · D-3B-4 → D-3B-5：显式重绘门（`__exportRedraw` 缺省 ON，
      //   显式 `false` 回滚）+ 场景授权（仅 D1 段落末尾追加）。门/场景任一不满足
      //   ⇒ `effUnitMemberLines` 为 null ⇒ 本段整体不执行
      //   ⇒ 导出逐字节走既有路径（与 3B-4 之前一致）。
      //   计划在效性：useExport 只在计划通过事务水位 / 事务 id / sidecar 代次校验时才传
      //   `unitMemberLines` / `displacedLines`（非 null）⇒ 非 null 即「计划当前」。
      const redrawPlanCurrent =
        input.unitMemberLines != null && input.displacedLines != null;
      /**
       * D-3B-5 不变式：**计划一旦被授权清除（eff* 非空 ⇒ drop 投影会剥离原算子），
       * 就必须成功挂载重绘**；否则「清除了却没重绘」= 缺行 PDF ⇒ **整体拒绝导出**
       * （抛错 ⇒ runCoreProductionExport 判 bridge-error ⇒ E-01 安全门 ⇒ 无 PDF，
       * 绝不静默回退 Legacy）。
       */
      const redrawPlanAuthorized = redrawAuthorized && hasPlanInput;
      /** 资格未取得的可观测原因（授权计划最终没挂上重绘时据此抛错） */
      let redrawGateRejection: string | null = null;
      const redrawLineIdOf = (effUnitMemberLines ?? []).length > 0;
      if (redrawPlanAuthorized && input.sidecar && input.legacyDocument) {
        try {
          // ★★ 2026-10-19（多计划）：**按 unit 计划分组跑管线**。flow 模型要求成员行
          //   top 严格单调（一个 unit 的连续行）；多计划合并后的成员行跨 unit 交错
          //   （实测 p1 的 l5/l6 与 l9/l10 交错）⇒ 单次管线 fail-closed 拒绝。
          //   ⇒ 每计划独立跑 pipeline（成员行连续 ✓），payload 查找跨计划依次认领
          //     （行只属于一个 plan ⇒ 无冲突），资格判定 = 全计划合并。
          const plans: { memberLines: typeof effUnitMemberLines; displacedLines: typeof effDisplacedLines; changedLineIds: readonly string[] }[] =
            input.unitRedrawPlans && input.unitRedrawPlans.length > 0
              ? input.unitRedrawPlans
              : effUnitMemberLines
                ? [
                    {
                      memberLines: effUnitMemberLines,
                      displacedLines: effDisplacedLines ?? [],
                      changedLineIds: input.changedLineIds ?? [],
                    },
                  ]
                : [];
          const planApis = plans.map((plan) =>
            runExportRedrawPipeline({
              document,
              legacyDocument: input.legacyDocument,
              sidecar: input.sidecar,
              memberLines: plan.memberLines ?? [],
              displacedLines: plan.displacedLines ?? [],
              changedLineIds: plan.changedLineIds ?? [],
              // 缺声明 ⇒ 保守模式（unresolved）：全部成员行硬断行，不授权跨行重排
              changedSource:
                plan.changedLineIds && plan.changedLineIds.length > 0 ? "transaction" : "unresolved",
              renderScale: runtime.renderScale,
              cssScale: runtime.cssScale,
              // ★ 翻转基准 = 页面 PDF 高 + Sidecar originYPt(y0)（与 export-renderer 的
              //   pageFlipBase 同口径）。**不能**直接用 boundsProvider.pageTopPt（那是 y0）。
              //   缺任一 ⇒ undefined ⇒ 几何投影 fail-closed（不猜基准）。
              flipBasePtOf: (pageIndexOneBased: number) => {
                const originYPt = boundsProvider.pageTopPt(pageIndexOneBased);
                if (originYPt === undefined) return undefined;
                // ★ 2026-10-22（用户缺陷「cell 修改提交后没有填写到表格里」）：页对象按
                //   **page.index** 查找（契约 1-based，与 Sidecar 同口径），**不是**
                //   `pages[pageIndexOneBased - 1]` 数组下标——editableDocument 是懒加载的
                //   （实测 pages=[第1页, 第11页]，下标 1 = 第 11 页）⇒ 下标 10 = undefined
                //   ⇒ h 缺失 ⇒ invalid-flip-base ⇒ 重绘资格被拒 ⇒ D-3B-4/5 抛错 ⇒ 导出失败。
                const page = (input.legacyDocument as unknown as { pages?: Array<{ index?: number; height?: number }> }).pages?.find(
                  (p) => p?.index === pageIndexOneBased,
                );
                const h = page?.height;
                const total = runtime.renderScale * runtime.cssScale;
                if (typeof h !== "number" || !Number.isFinite(h) || !(total > 0)) return undefined;
                return h / total + originYPt;
              },
            }),
          );
          // 合并诊断与资格（全部计划必须同时 ok/eligible）
          const mergedDiagLines = planApis.flatMap((p) => p.diagnostics.lines as unknown as ExportRedrawDiagnostics["lines"]);
          const mergedWarnings = planApis.flatMap((p) => p.diagnostics.warnings);
          const allOk = planApis.length > 0 && planApis.every((p) => p.ok && p.diagnostics.ok);
          const mergedDiagnostics: ExportRedrawDiagnostics = {
            ok: allOk,
            stage: allOk ? null : (planApis.find((p) => !p.diagnostics.ok)?.diagnostics.stage ?? "flow"),
            changedSource: input.changedLineIds && input.changedLineIds.length > 0 ? "transaction" : "unresolved",
            changedLineIds: [...(input.changedLineIds ?? [])],
            lines: mergedDiagLines,
            warnings: mergedWarnings,
          } as unknown as ExportRedrawDiagnostics;
          const pipeline = {
            ok: allOk,
            reason: allOk ? null : (planApis.find((p) => !p.ok)?.reason ?? null),
            detail: allOk ? null : (planApis.find((p) => !p.ok)?.detail ?? null),
            diagnostics: mergedDiagnostics,
            redrawEligible: allOk && planApis.every((p) => p.redrawEligible),
            redrawRejectReason: allOk
              ? null
              : (planApis.find((p) => !p.redrawEligible)?.redrawRejectReason ?? null),
            claimPayloadsOfLineId: (lineId: string) => {
              for (const api of planApis) {
                const out = api.claimPayloadsOfLineId(lineId);
                if (out.length > 0) return out;
              }
              return [];
            },
            unclaimedPayloads: () =>
              planApis.flatMap((api) => api.unclaimedPayloads()),
          };
          ctxRedrawDiagnostics = pipeline.diagnostics;
          redrawPayloadOf = pipeline.payloadOfLineId;
          // ★ 3B-4：显式门 + 场景授权 + 严格资格。任一不满足 ⇒ **不挂载几何**
          //   （绝不半量重绘：被剥离的行若拿不到几何就会静默缺行）。
          const gate = decideExportRedrawGate({
            gateOpen: redrawGateOpen,
            planCurrent: redrawPlanCurrent,
            scenarioAuthorized: redrawScenarioAuthorized,
            redrawEligible: pipeline.redrawEligible,
            // 未认领目标行只能在挂载**之后**知道（bridge 逐行调用 lineRedrawOf）⇒
            // 这里传 0；真正的强制在下方 `buildEditableDocument` 之后（抛错 ⇒ 不产出 PDF）。
            unclaimedLineCount: 0,
          });
          if (gate.allowed) {
            const claim = pipeline.claimPayloadsOfLineId;
            redrawMounted = [];
            redrawPayloadsOf = (lineId: string) => {
              const out = claim(lineId);
              if (out.length > 0) redrawMounted.push(`${lineId.slice(-8)}#${out.length}`);
              return out;
            };
            unclaimedRedrawsOf = pipeline.unclaimedPayloads;
          } else {
            redrawGateRejection =
              gate.reason === "pipeline-ineligible"
                ? `${gate.reason}: ${pipeline.redrawRejectReason ?? "?"}`
                : String(gate.reason);
            try {
              (globalThis as unknown as Record<string, unknown>).__d3b2GateReject = gate.reason;
            } catch {
              /* ignore */
            }
            console.warn(
              "[F3B-6.28][3B4-REDRAW-REJECT] 重写资格未取得（授权计划将被整体拒绝）：",
              redrawGateRejection,
            );
          }
        } catch (e) {
          // 授权计划下，流水线异常同样意味着「清了却没重绘」⇒ 记录并整体拒绝
          // （门/场景未授权时本段不执行，走此分支无损既有行为）。
          redrawGateRejection = `pipeline-error: ${String(e)}`;
          console.warn("[F3B-6.28][D3B-1] 重绘几何流水线异常（授权计划 ⇒ 整体拒绝导出）：", e);
        }
      }
      // ★ D-3B-5 不变式执行点：授权清除但重绘未挂载 ⇒ 拒绝导出（不产出缺行 PDF）。
      if (redrawPlanAuthorized && !redrawPayloadsOf) {
        throw new Error(
          `F3B-6.28 · D-3B-4/D-3B-5：unit 计划已授权原算子清除，但重绘资格未取得` +
            `（${redrawGateRejection ?? "未挂载"}）⇒ 清除后缺行 ⇒ 拒绝导出（不产出 PDF）。`,
        );
      }

      const result = buildEditableDocument(document, {
        runtime: { renderScale: runtime.renderScale, cssScale: runtime.cssScale },
        layoutOf,
        originalBoundsOf,
        // provenance 来自 run.source；PDF lineId 原样用作 legacy lineId（不伪造）
        legacyLineId: ({ provenance }) => provenance?.lineId ?? undefined,
        pageTopPt,
        // ★ F3B-6.17-3C-6A.1-CB2：把 Sidecar 的 operator provenance 经 Binding provider
        //   回灌到 bridge 产物（`EditableGlyph.operatorId`），恢复
        //   `stripReplacedTextOperators` 的 provenance 通道。
        //   Sidecar 是**唯一**来源（bridge 不接触 Sidecar 内部结构）；sidecar 缺失 ⇒
        //   provider 全部 fail-closed（UNKNOWN）⇒ 导出保持既有「文本匹配兜底」行为。
        glyphProvenanceOf: createSidecarGlyphProvenanceProvider(input.sidecar),
        // ★ Step 5A：同样经 Sidecar 回灌**字符级 PDF 度量**（含 fontIdentity），
        //   让 exporter 能知道该行原本用哪个内嵌字体。sidecar 缺失 ⇒ fail-closed。
        glyphMetricsOf: createSidecarGlyphMetricsProvider(input.sidecar),
        // ★★ P0-1：glyph 级 raw-CID provenance（独立通道，不碰 glyph.metrics）。
        //   Sidecar 行 originalGlyphs 携带 pdfCharCode/pdfTransform（builder:177/176），
        //   经 fail-closed 单调贪心对齐回灌未变更原字符；缺失/新增字符 ⇒ undefined ⇒ fallback。
        glyphRawProvenanceOf: createSidecarGlyphRawProvenanceProvider(input.sidecar),
        // ★ Step 5B：行级原字体身份（**行级** export provenance）。
        //   与上面 glyphMetricsOf 互补而非替代：编辑行的 glyph 级 metrics 必然为空
        //   （Core stripGlyphRange 清掉 glyph 索引），但 blockId/lineId 保留，
        //   所以「这一行原本用哪个内嵌字体」在行级仍可确定回答 → exporter 的
        //   CID 路径据此优先复用原字体，而不是无条件落到 Noto。
        lineFontIdentityOf: createSidecarLineFontIdentityProvider(input.sidecar),
        // ★ Step 5B：行来源回溯表（整行 replace 的唯一出路）。
        //   整行 replace 后目标段所有 run 的 source 都是 generated/undefined ⇒ ①② 都答不出
        //   「这一行原本是哪个 PDF 行」；但 paragraph.id 在 replace 前后稳定，且 import-time
        //   快照（beforeDocument）里那个 paragraph 仍带原始 run.source ⇒ **确定性**回溯。
        //   同时提供结构位置键（pageIndex:textBoxIndex:paragraphIndex），与既有 lineDropOf
        //   同款冗余：id 空间不一致时（Core session 由第二次 adapter 调用创建）仍能命中。
        //   命中不了 ⇒ undefined ⇒ 不写 originalFontIdentity ⇒ exporter 如实落既有兜底。
        lineSourceFallbackOf: ({ paragraphId, pageIndex, textBoxIndex, paragraphIndex }) =>
          beforeLineSources.get(paragraphId) ??
          beforeLineSources.get(`${pageIndex}:${textBoxIndex}:${paragraphIndex}`),
        // ★ C-B1.1：export drop overlay。
        //   优先 Core id 匹配；id 空间不一致时回退到**结构位置**匹配。
        lineDropOf: ({ textBoxId, paragraphId, pageIndex, textBoxIndex, paragraphIndex }) =>
          dropByCoreIdentity.get(`${textBoxId}|${paragraphId}`) ??
          dropByPosition.get(`${pageIndex}:${textBoxIndex}:${paragraphIndex}`),
        // ★ F3B-6.28 · D-3B-1/3B-2：重绘几何 overlay。
        //   与 lineDropOf 同款匹配键。
        //   3B-1：`redrawPayloadOf`（首条）供逐行诊断；
        //   3B-2：`redrawPayloadsOf`（全部目标行）才挂载 —— 它是渲染器重绘的唯一入口，
        //         且只在 `redrawEligible` 为真时由上面赋值 ⇒ 不合格 ⇒ 不挂 ⇒ 渲染器不重绘。
        lineRedrawOf:
          redrawLineIdOf && redrawPayloadsOf
            ? ({ textBoxId, paragraphId, pageIndex, textBoxIndex, paragraphIndex }) => {
                const lineId =
                  dropLineIdByIdentity.get(`${textBoxId}|${paragraphId}`) ??
                  dropLineIdByPosition.get(`${pageIndex}:${textBoxIndex}:${paragraphIndex}`);
                return lineId ? redrawPayloadsOf!(lineId) : null;
              }
            : undefined,
        // ★ F3B-6.28 · D-3B-2：「该段落已被重绘覆盖」标记（与上面同一匹配键体系）。
        //   被编辑的 Core 段落常被拆成多条视觉行，只有一条能拿到几何；其余若不标记，
        //   会走既有 overlay 把同一段文字再画一遍（实测正文重复）。
        lineRedrawCoveredOf:
          redrawLineIdOf && redrawPayloadsOf
            ? ({ textBoxId, paragraphId, pageIndex, textBoxIndex, paragraphIndex }) =>
                dropLineIdByIdentity.has(`${textBoxId}|${paragraphId}`) ||
                dropLineIdByPosition.has(`${pageIndex}:${textBoxIndex}:${paragraphIndex}`)
            : undefined,
      });
      // 目标行若一条都没被 legacy 行认领 ⇒ 它不会被重绘（= 该行缺字）⇒ D-3B-4：**拒绝导出**。
      if (redrawPayloadsOf && unclaimedRedrawsOf) {
        const unclaimed = unclaimedRedrawsOf();
        try {
          (globalThis as unknown as Record<string, unknown>).__d3b2Unclaimed = unclaimed;
          (globalThis as unknown as Record<string, unknown>).__d3b2DropKeys = [
            ...dropByCoreIdentity.keys(),
          ];
          (globalThis as unknown as Record<string, unknown>).__d3b2Mounted = redrawMounted;
        } catch {
          /* ignore */
        }
        if (unclaimed.length > 0) {
          throw new Error(
            `F3B-6.28 · D-3B-4：${unclaimed.length} 条重绘目标行未挂到任何 legacy 行 ⇒ ` +
              `不会被重绘（缺行）⇒ 拒绝导出。未认领：${unclaimed.slice(0, 6).join(", ")}`,
          );
        }
      }
      return { document: result.document, warnings: result.warnings };
    },
    redrawDiagnostics: () => ctxRedrawDiagnostics,
  };
}

/**
 * 从真实生产来源取得 Core EditorDocument（不新建第二份 state）。
 *
 * - 已有活跃 Core 输入 session → 直接取 `session.history.state.document`（编辑真相）
 * - 否则用 legacy EditableDocument 引导一次（与 PDFEditor 引导逻辑一致，纯投影、不改 legacy）
 */
export function resolveCoreDocument(
  session: CoreInputSession | null,
  legacyDocument: EditableDocument
): EditorDocument | null {
  if (session) return documentOf(session);
  const created = createCoreInputSession(legacyDocument);
  return created.ok ? documentOf(created.session) : null;
}

/**
 * Core Shadow Export（诊断专用）。
 *
 * - 不下载、不替换用户结果。
 * - 任意失败（runtime 缺失 / 桥接异常 / 导出异常）→ 返回 `{ ok: false }`，**不抛出**，
 *   调用方据此保证 legacy 下载完全不受影响（F2-F / T11）。
 */
export async function runCoreShadowExport(opts: {
  coreDocument: EditorDocument;
  legacyDocument: EditableDocument;
  runtime: EditableDocumentRuntime;
  exportEditableDocument: ExportEditableDocumentFn;
  pdfBytes: ArrayBuffer | null | undefined;
  signatureRegions?: Parameters<ExportEditableDocumentFn>[2];
  editedLineBoxes?: Parameters<ExportEditableDocumentFn>[4];
  /** F3B-6.17 3B'-B.2：Core bounds 唯一来源（BindingSidecar） */
  sidecar?: BindingSidecar | null;
}): Promise<CoreExportShadowResult> {
  try {
    const ctx = buildCoreExportContext({
      document: opts.coreDocument,
      legacyDocument: opts.legacyDocument,
      runtime: opts.runtime,
      sidecar: opts.sidecar,
    });
    if (!ctx) {
      return { ok: false, error: new Error("core-export-shadow: runtime 不完整，abort") };
    }
    const { document, warnings } = ctx.toEditableDocument();
    const bytes = await opts.exportEditableDocument(
      document,
      opts.pdfBytes ?? undefined,
      opts.signatureRegions,
      undefined,
      opts.editedLineBoxes
    );
    return { ok: true, bytes, warnings };
  } catch (error) {
    return { ok: false, error };
  }
}

// ─────────────────────────────────────────────────────────────────────
//  EDITOR-CORE-012-F3A：Production Candidate Export Path
//
//  目标：把 F2 的 Shadow Path 升级成 **Candidate Path** —— 仍是诊断、仍不替换默认下载，
//  但解决一个核心问题：
//
//      "无 Core session 时，如何安全地建立 Core export 所需要的完整上下文"
//
//  本段提供三层：
//    1. 文档来源策略（F3A-1）：resolveProductionCoreDocument —— 绝不 export-time 新建 session
//    2. 纯资格判断（F3A-2）：evaluateCoreExportEligibility —— 把"能不能走"从"实际 export"分离
//    3. 运行时固化（F3A-5）：buildCoreExportRuntime —— 禁止 1/1 fallback
//    4. 生命周期边界（F3A-4）：initializeCoreDocument —— 复用既有 adapter，不在 export 调用
//
//  红线（与 F2 一致，且更严）：
//    ❌ export-time 隐式 createCoreInputSession()
//    ❌ 第二份 EditorDocument state
//    ❌ Segment / docBlocks / localText → Core → export
//    ❌ 新坐标系 / 新 PDF writer / 新 layout engine / 72-96 fallback / fake provenance
// ─────────────────────────────────────────────────────────────────────

/** F3A 候选开关（与 F2 的 `__coreExportShadow` 同风格；默认关，需 globalThis 置真才跑候选导出） */
export const CORE_EXPORT_CANDIDATE_FLAG = "__coreExportCandidate";

/** F3A-1：Core 文档来源策略状态（仅诊断/断言用） */
export type CoreExportSourceState =
  | { kind: "core-session-active"; document: EditorDocument }
  /** 有 site 但没有可用的 Core 文档：只有 legacy EditableDocument → 不进入 Core production path */
  | { kind: "only-legacy" };

/**
 * F3A-1：解析「可用于 Core 导出」的文档。
 *
 * ⚠️ **绝不**在 export 时调用 `createCoreInputSession()` 作为 production source。
 * 这是 F3A 与 F2 `resolveCoreDocument` 的根本区别：
 *   · `resolveCoreDocument`（F2 shadow 验证手段）允许 "无 session → 从 legacy 引导一次"；
 *   · 本函数（F3A candidate）**不允许**——只有「活跃 Core session」或「已持久化的 Core document」
 *     才能进入 Core 导出路径。否则（只有 legacy）→ 返回 null，调用方据此走 legacy。
 *
 * `@persistedCoreDocument` 是 F3B 钩子：将来 Core document 成为稳定的 import-time 持久化 source 后，
 * 即使 session 已 inactive，也能从这里取到。F3A 阶段通常传 undefined。
 */
export function resolveProductionCoreDocument(
  session: CoreInputSession | null,
  persistedCoreDocument?: EditorDocument | null
): EditorDocument | null {
  if (session) return documentOf(session);
  if (persistedCoreDocument) return persistedCoreDocument;
  return null;
}

/**
 * F3A-5：固化 production export runtime。
 *
 * 要求 `renderScale` / `cssScale` / `pageMetrics` 全部来自**真实当前文档/页面上下文**
 * （即 `editableDocumentRef.current.runtime` + `cssScaleRef.current` + 当前页尺寸，
 * 允许随窗口 resize 变化的 `cssScale` 实时传入，不缓存 import 时旧值）。
 *
 * ❌ 禁止 1/1 fallback：任何一项缺失/非法 → 返回 `null`（abort），绝不用 1/1 顶替。
 */
export function buildCoreExportRuntime(input: {
  renderScale: number;
  cssScale: number;
  pageMetrics: { width: number; height: number }[];
}): EditableDocumentRuntime | null {
  if (input.renderScale == null || !Number.isFinite(input.renderScale)) return null;
  if (input.cssScale == null || !Number.isFinite(input.cssScale)) return null;
  if (!input.pageMetrics || input.pageMetrics.length === 0) return null;
  if (!input.pageMetrics.every((m) => Number.isFinite(m.width) && Number.isFinite(m.height))) return null;
  return {
    renderScale: input.renderScale,
    cssScale: input.cssScale,
    pageMetrics: input.pageMetrics,
  };
}

/**
 * F3A-4：明确的「Core document initialization boundary」。
 *
 * 复用既有 `legacy EditableDocument → EditorDocument` adapter（**不是**第二套 PDF parser / layout）。
 * 这是 F3B「Core document 成为稳定 import-time production source」的落地点。
 *
 * ⚠️ **F3A 阶段禁止在 export 时调用本函数作为 fallback**（见 `resolveProductionCoreDocument` /
 * `evaluateCoreExportEligibility`）。它只是把"初始化边界"显式化，供未来生命周期接线，
 * 不在下载路径上隐式 bootstrap。
 */
export function initializeCoreDocument(
  legacy: EditableDocument,
  options: { layoutGranularity?: "block" | "visual-line" } = {},
  registry: ImageAssetRegistry = imageAssetRegistry
): EditorDocument {
  const result = editableDocumentToEditorDocument(legacy, {
    layoutGranularity: options.layoutGranularity ?? "visual-line",
  });
  // B3-C-5-B：把导入产出的资产注册进运行时 registry，
  // 使 C5-C 导出 / C5-D 渲染都可通过 assetRef 解引用取字节。
  // 当前生产导入（editableDocumentToEditorDocument）跳过 image，assets 为空——接缝已就位，待 C5-C 启用。
  registry.registerMany(result.assets);
  return result.document;
}

// ── F3A-2：纯资格判断 ────────────────────────────────────────────────

export type CoreExportEligibilityReason =
  | "no-core-document"
  | "missing-runtime"
  | "missing-layout"
  | "missing-original-bounds"
  | "unsupported-provenance"
  | "unsupported-document-state";

export type CoreExportEligibility =
  | { eligible: true; document: EditorDocument; context: CoreExportContext }
  | { eligible: false; reason: CoreExportEligibilityReason };

const SUPPORTED_PROVENANCE_KINDS = new Set(["pdf-native", "ocr", "user", "generated", "hybrid"]);

/** 遍历文档内全部 run（携带其所属 TextBox id，便于构造 blockId） */
function eachRun(
  document: EditorDocument,
  fn: (textBoxId: string, run: TextRun) => void
): void {
  for (const textBox of allTextBoxes(document)) {
    for (const paragraph of textBox.paragraphs) {
      for (const run of paragraph.runs) fn(textBox.id, run);
    }
  }
}

/**
 * 找出「编辑了既有 PDF 文本、却缺少 originalBounds」的 blockId 列表。
 *
 * 语义：只有 `pdf-native` / `ocr` 这类**有 PDF 来源**的 run 被编辑后，才需要用
 * `originalBounds` 遮盖原文（否则会重影）。`generated` / `user` 等无 provenance 的新增内容
 * 不遮盖任何原文 → 即使没有 originalBounds 也合法，跳过。
 *
 * ── C2-A-Impl-R1：post-injected OCR 的显式分类 ────────────────────────
 * `isModifiedRun()` 的语义是「非 pristine pdf-native」，它把 `kind:"ocr"` 一律当成
 * 「被编辑过的 PDF 文本」。但对 **手动 OCR（W3/W4）后注入** 的 TextBoxObject 而言这是误判：
 *
 *   · `hasGlyphRange === false` ⇒ 该 run 不映射任何原始 PDF glyph
 *     （2b `ocr-core-object-draft` 只写 `{ kind:"ocr", blockId }`，无 lineId / glyph 索引）。
 *   · 其底层原文是**扫描栅格图像**，不是 PDF text operator ⇒ 不存在需要 mask 的原文墨迹。
 *   · Sidecar 是 import-time 不可变 artifact，本就不可能含 post-injection 条目
 *     ⇒ 要求 originalBounds 等于逼迫「用 OCR bbox 伪造 import-time bounds」（明令禁止）。
 *
 * 因此这里按 provenance 显式分叉，**不改 `isModifiedRun()` 本身**（它是共享语义）：
 *
 *   | kind        | hasGlyphRange | 是否要求 originalBounds |
 *   |-------------|---------------|------------------------|
 *   | pdf-native  | true (pristine)| 否（未被编辑，跳过）   |
 *   | pdf-native  | false (edited) | **是**（必须 mask 原文）← 不变量 1，不放宽 |
 *   | ocr         | true (import-time) | **是**（映射真实原文 glyph）← 不变量 2，不放宽 |
 *   | ocr         | false (post-injected) | **否**（无原文墨迹可遮）← 本次唯一行为变化 |
 */
function findEditedBlocksMissingOriginalBounds(
  document: EditorDocument,
  originalBoundsOf: (blockId: string) => BBox | undefined
): string[] {
  const missing: string[] = [];
  eachRun(document, (textBoxId, run) => {
    const prov = provenanceOfBinding(run.source);
    if (!prov || (prov.kind !== "pdf-native" && prov.kind !== "ocr")) return;

    // C2-A-Impl-R1：post-injected OCR —— 无原始 PDF glyph ⇒ 无原文墨迹需 mask ⇒ 不要求 bounds。
    // 与 user / generated / image 同类：新增内容不遮盖任何原文。
    if (prov.kind === "ocr" && !prov.hasGlyphRange) return;

    if (!isModifiedRun(prov)) return;
    const blockId = prov.blockId ?? textBoxId;
    if (!originalBoundsOf(blockId)) missing.push(blockId);
  });
  return missing;
}

/** 任何 run 的 source.kind 不在受支持集合内 → true */
function hasUnsupportedProvenance(document: EditorDocument): boolean {
  let bad = false;
  eachRun(document, (_textBoxId, run) => {
    const prov = provenanceOfBinding(run.source);
    if (prov && !SUPPORTED_PROVENANCE_KINDS.has(prov.kind)) bad = true;
  });
  return bad;
}

/**
 * F3A-2：把「能不能走 Core export」从「实际 export」里分离出来。
 *
 * 不导出 PDF，只回答 eligibility。这样 F3B/F4 不需要在 `useExport` 里堆判断。
 *
 * 评估顺序（首个不满足即返回对应 reason）：
 *   1. 文档存在？（resolveProductionCoreDocument —— 无 session 且无可持久化文档 → no-core-document，
 *      且**绝不** createCoreInputSession 作为 production source）
 *   2. runtime 完整？（缺失 → missing-runtime）
 *   3. layout 完整？（buildCoreRenderSourceFromDocument 失败 → missing-layout）
 *   4. originalBounds 完整？（被编辑的 PDF run 缺 originalBounds → missing-original-bounds）
 *   5. provenance 合法？（unsupported-provenance）
 *   6. document-state 合法？（如空文档 → unsupported-document-state）
 */
export function evaluateCoreExportEligibility(opts: {
  session: CoreInputSession | null;
  legacyDocument: EditableDocument;
  runtime?: EditableDocumentRuntime;
  pageTopPt?: (pageIndex: number) => number | undefined;
  /** F3B-1：import-time 已持久化的 Core document（无活跃 session 时作为 production source） */
  persistedCoreDocument?: EditorDocument | null;
  /**
   * F3B-6.17 3B'-B.2：BindingSidecar（Core bounds 唯一来源）。
   * 缺失 ⇒ bounds 全部 fail-closed（`missing-original-bounds`），**绝不回退 legacy**。
   */
  sidecar?: BindingSidecar | null;
  /** F3B-6.17-3C-6B1.1：编辑前 Core 快照（供 export drop 投影；缺省 ⇒ 不产生 drop） */
  beforeDocument?: EditorDocument | null;
  /**
   * F3B-6.28 · D 第一阶段：位移行（文本未变但旧位置必须清除）。
   * 仅透传给 `buildCoreExportContext` ⇒ `computeAffectedSourceProjection`。
   */
  displacedLines?: readonly DisplacedClearTarget[] | null;
  /** F3B-6.28 · D 第二步（决策二）：unit 全部成员行（原算子必须剥离） */
  unitMemberLines?: readonly DisplacedClearTarget[] | null;
  /** F3B-6.28 · D-3B-1：本次事务实际改动的成员行（与上面两者同源同计划；null ⇒ 保守） */
  changedLineIds?: readonly string[] | null;
  /**
   * F3B-6.28 · D-3B-5 / D-3B-6：场景授权（与上面三者同源同计划；null ⇒ 不授权）。
   * `EXPORT_REDRAW_AUTHORIZED_SCENARIOS`（D1 段落末尾追加 + D2 段落内部插入）
   * 放行清除+重绘；**导出侧与 PDFEditor 侧共用同一授权集合**。
   */
  unitRedrawScenario?: ExportRedrawScenario | null;
  /** ★★ 2026-10-19（多计划）：按 unit 分组的重绘计划透传（3B2 每计划独立跑管线） */
  unitRedrawPlans?: readonly {
    memberLines: readonly DisplacedClearTarget[];
    displacedLines: readonly DisplacedClearTarget[];
    changedLineIds: readonly string[];
  }[] | null;
}): CoreExportEligibility {
  // F3A-1：绝不 createCoreInputSession() 作为 production source；优先 session，其次持久化 Core document
  const document = resolveProductionCoreDocument(opts.session, opts.persistedCoreDocument);
  if (!document) return { eligible: false, reason: "no-core-document" };

  if (
    !opts.runtime ||
    opts.runtime.renderScale == null ||
    opts.runtime.cssScale == null ||
    !opts.runtime.pageMetrics
  ) {
    return { eligible: false, reason: "missing-runtime" };
  }
  const runtime = opts.runtime;

  // F3A-D：layout 必须可用（复用生产 Core 布局引擎）
  const layoutOutcome = buildCoreRenderSourceFromDocument(document);
  if (!layoutOutcome.ok) return { eligible: false, reason: "missing-layout" };

  const ctx = buildCoreExportContext({
    document,
    legacyDocument: opts.legacyDocument,
    runtime,
    pageTopPt: opts.pageTopPt,
    sidecar: opts.sidecar,
    beforeDocument: opts.beforeDocument ?? null,
    // F3B-6.28 · D 第一阶段：位移行必须一路透传到投影（曾漏掉本跳 ⇒ 导出毫无变化）
    displacedLines: opts.displacedLines ?? null,
    unitMemberLines: opts.unitMemberLines ?? null,
    changedLineIds: opts.changedLineIds ?? null,
    // F3B-6.28 · D-3B-5：场景授权同链路透传（曾漏掉本跳 ⇒ 非 D1 场景被误放行）
    unitRedrawScenario: opts.unitRedrawScenario ?? null,
    // ★★ 2026-10-19（多计划）：按 unit 分组的重绘计划（3B2 每计划独立跑管线）
    unitRedrawPlans: opts.unitRedrawPlans ?? null,
  });
  if (!ctx) return { eligible: false, reason: "missing-runtime" }; // 双保险

  // F3A-E：被编辑的 PDF run 必须有 originalBounds
  const missingBounds = findEditedBlocksMissingOriginalBounds(document, ctx.originalBoundsOf);
  if (missingBounds.length > 0) return { eligible: false, reason: "missing-original-bounds" };

  // provenance 合法性
  if (hasUnsupportedProvenance(document)) return { eligible: false, reason: "unsupported-provenance" };

  // document-state 合法性（至少要有页）
  if (document.pages.length === 0) return { eligible: false, reason: "unsupported-document-state" };

  return { eligible: true, document, context: ctx };
}

// ── F3A-8：Candidate Runner（诊断专用，不替换默认下载）──────────────────

export interface CoreCandidateExportResult {
  /** 是否真的进入候选导出（eligibility 通过） */
  attempted: boolean;
  /** eligibility 未通过时的原因 */
  reason?: CoreExportEligibilityReason;
  /** 候选导出结果（仅当 attempted === true） */
  shadow?: CoreExportShadowResult;
}

/**
 * F3A-8：Core Candidate Export。
 *
 * 先用 `evaluateCoreExportEligibility` 判定；通过后才走与 Shadow 同款的
 * `runCoreShadowExport`（同一生产导出引擎）。**默认用户下载仍来自 legacy**，
 * 候选成功/失败都不影响用户结果。
 */
export async function runCoreCandidateExport(opts: {
  session: CoreInputSession | null;
  legacyDocument: EditableDocument;
  runtime?: EditableDocumentRuntime;
  exportEditableDocument: ExportEditableDocumentFn;
  pdfBytes: ArrayBuffer | null | undefined;
  signatureRegions?: Parameters<ExportEditableDocumentFn>[2];
  editedLineBoxes?: Parameters<ExportEditableDocumentFn>[4];
  pageTopPt?: (pageIndex: number) => number | undefined;
  /** F3B-1：import-time 已持久化的 Core document（无活跃 session 时作为 production source） */
  persistedCoreDocument?: EditorDocument | null;
  /** F3B-6.17 3B'-B.2：Core bounds 唯一来源（BindingSidecar） */
  sidecar?: BindingSidecar | null;
}): Promise<CoreCandidateExportResult> {
  const eligibility = evaluateCoreExportEligibility({
    session: opts.session,
    legacyDocument: opts.legacyDocument,
    runtime: opts.runtime,
    pageTopPt: opts.pageTopPt,
    persistedCoreDocument: opts.persistedCoreDocument,
    sidecar: opts.sidecar,
  });
  if (!eligibility.eligible) {
    return { attempted: false, reason: eligibility.reason };
  }
  const shadow = await runCoreShadowExport({
    coreDocument: eligibility.document,
    legacyDocument: opts.legacyDocument,
    runtime: opts.runtime!,
    exportEditableDocument: opts.exportEditableDocument,
    pdfBytes: opts.pdfBytes,
    signatureRegions: opts.signatureRegions,
    editedLineBoxes: opts.editedLineBoxes,
  });
  return { attempted: true, shadow };
}

// ─────────────────────────────────────────────────────────────────────
//  EDITOR-CORE-012-F3B-2：Core Production Export + Legacy Fallback
//
//  目标：把 Core 导出第一次真正接到「用户 Download」。
//  策略（安全双路径，先生成 bytes 再决定 fallback）：
//
//      Core Export ──▶ bytes ──▶ validate ──▶ valid? ─┬─ Yes ─▶ Core PDF
//                                                    └─ No  ─▶ Legacy PDF
//
//  · binding 层（bridge）只做 Core EditorDocument → EditableDocument；
//  · 导出编排层（本段）负责 success/failure → fallback；
//  · Core 导出是纯 bridge，绝不修改传入的 legacyDocument（error isolation）；
//  · 任何阶段失败（eligibility/bridge/renderer/validation）→ 返回 {ok:false}，
//    调用方据此回退 legacy，绝不产出坏 PDF。
//
//  红线（同 F2/F3A，且更严）：
//    ❌ 新 PDF writer / Layout Engine / Document Model / 坐标系
//    ❌ Segment / docBlocks / localText → Core → export
//    ❌ 删除 legacy export / applySegmentEditsToDocument
// ─────────────────────────────────────────────────────────────────────

/**
 * Core 生产导出失败原因（覆盖 eligibility 原因 + bridge/renderer/validation 阶段）。
 * 结构化 reason 便于后续统计 Core export success rate。
 */
export type CoreExportFailureReason =
  | CoreExportEligibilityReason
  | "bridge-error"
  | "export-error"
  | "invalid-pdf";

/** Core 生产导出失败发生的阶段（可观测性，对应 console.warn 的 stage 字段） */
export type CoreExportStage = "eligibility" | "bridge" | "renderer" | "validation";

/** Core 生产导出结果：成功带 bytes；失败带 reason + stage（绝不抛到调用方） */
export type CoreExportResult =
  | {
      ok: true;
      bytes: Uint8Array;
      source: "core";
      warnings: readonly string[];
      /**
       * F3B-6.28 · D-3B-1：重绘几何逐行诊断（**只读取证**）。
       * 诊断 ok **不授权**重绘（3B-2 未授权）；无计划/Sidecar 时为 null。
       */
      redrawDiagnostics: ExportRedrawDiagnostics | null;
    }
  | { ok: false; source: "core"; reason: CoreExportFailureReason; stage: CoreExportStage; error?: unknown };

/**
 * 轻量结构性兜底校验（**不依赖 pdf-lib / 任何 PDF parser**）。
 * 仅挡住明显损坏/空字节：bytes 非空 + `%PDF-` header + 尾部含 `%%EOF`。
 *
 * 这是 binding 层的"最小护栏"。binding 的真实边界契约是「不得依赖 PDF parser/实现」，
 * 因此强校验（用 pdf-lib 重新打开并校验 pageCount）被重新定位到生产域
 * （见 `export-pdf.ts` 的 `validateExportedPdf`，由 `useExport` 注入）。
 * 调用方可始终注入更强的 `validatePdf`。
 */
function defaultValidateExportedPdf(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 8) return false;
  const header = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]);
  if (header !== "%PDF-") return false;
  const tailStart = Math.max(0, bytes.length - 2048);
  const tail = String.fromCharCode(...bytes.subarray(tailStart));
  return tail.includes("%%EOF");
}

/**
 * EDITOR-CORE-012-F3B-2：Core 生产导出（带 Legacy fallback 决策）。
 *
 * 流程（任一阶段失败 → 返回 `ok:false` + `reason` + `stage`，调用方据此回退 legacy）：
 *   1. eligibility   （纯判定，无 export 副作用）
 *   2. bridge        （Core EditorDocument → EditableDocument，纯函数，**不改 legacy**）
 *   3. renderer      （exportEditableDocument → bytes）
 *   4. validation    （先有 bytes 再决定 fallback；默认走轻量结构性校验，
 *                      生产调用方注入 pdf-lib 强校验）
 *
 * 调用方（useExport）包装：
 *   const r = await runCoreProductionExport(...)
 *   if (r.ok) download(r.bytes) else legacyExport()   // 安全双路径
 *
 * `bridge` / `validatePdf` 仅供测试注入（默认走轻量结构性兜底；生产注入真实校验）。
 */
export async function runCoreProductionExport(opts: {
  session: CoreInputSession | null;
  legacyDocument: EditableDocument;
  runtime?: EditableDocumentRuntime;
  exportEditableDocument: ExportEditableDocumentFn;
  pdfBytes: ArrayBuffer | null | undefined;
  signatureRegions?: Parameters<ExportEditableDocumentFn>[2];
  editedLineBoxes?: Parameters<ExportEditableDocumentFn>[4];
  pageTopPt?: (pageIndex: number) => number | undefined;
  /** F3B-1：import-time 已持久化的 Core document（无活跃 session 时作为 production source） */
  persistedCoreDocument?: EditorDocument | null;
  /** F3B-6.17 3B'-B.2：Core bounds 唯一来源（BindingSidecar） */
  sidecar?: BindingSidecar | null;
  /**
   * F3B-6.17-3C-6B1.1：编辑前 Core 快照（`coreDocumentRef.current`）。
   * 与活跃 session 的当前 Core 文档构成 before/after ⇒ 产出 export drop 投影。
   */
  beforeDocument?: EditorDocument | null;
  /**
   * F3B-6.28 · D 第一阶段：位移行（由 `useExport` 依 `unitDisplacedClearRef` 与
   * Core 事务水位校验后传入；stale/未启用受控 gate 时不传 ⇒ 行为不变）。
   */
  displacedLines?: readonly DisplacedClearTarget[] | null;
  /** F3B-6.28 · D 第二步（决策二）：unit 全部成员行（原算子必须剥离） */
  unitMemberLines?: readonly DisplacedClearTarget[] | null;
  /**
   * F3B-6.28 · D-3B-1：本次事务实际改动的成员行（原始断行保真授权；null ⇒ 保守模式）。
   *
   * ⚠️ 必须与 displacedLines / unitMemberLines 来自**同一条已校验**的计划；
   *    计划失效时调用方必须传 null（不得沿用旧声明）。
   */
  changedLineIds?: readonly string[] | null;
  /**
   * F3B-6.28 · D-3B-5 / D-3B-6：场景授权（与上面三者同源同计划；null ⇒ 不授权）。
   * `EXPORT_REDRAW_AUTHORIZED_SCENARIOS`（D1 段落末尾追加 + D2 段落内部插入）
   * 放行清除+重绘；**导出侧与 PDFEditor 侧共用同一授权集合**。
   */
  unitRedrawScenario?: ExportRedrawScenario | null;
  /**
   * ★★ 2026-10-19（多计划）：**按 unit 分组的重绘计划**。多 unit 依次提交时，
   * 各 unit 的成员行跨页交错 ⇒ flow 模型（要求成员行 top 单调）必须**每计划独立跑**；
   * 扁平的 unitMemberLines 仅供 drop 投影（diff 已能发现 changed 行）。
   * 缺省 ⇒ 退回扁平单组（单 unit 行为逐字节不变）。
   */
  unitRedrawPlans?: readonly {
    memberLines: readonly DisplacedClearTarget[];
    displacedLines: readonly DisplacedClearTarget[];
    changedLineIds: readonly string[];
  }[] | null;
  /** 测试注入：Core→EditableDocument 桥接（默认 ctx.toEditableDocument） */
  bridge?: (ctx: CoreExportContext) => { document: EditableDocument; warnings: readonly string[] };
  /** 测试注入 / 生产注入：PDF 校验（默认轻量结构性兜底；生产由 useExport 注入 pdf-lib 强校验） */
  validatePdf?: (bytes: Uint8Array) => boolean | Promise<boolean>;
}): Promise<CoreExportResult> {
  // 1) eligibility（纯判定，无 export 副作用）
  const eligibility = evaluateCoreExportEligibility({
    session: opts.session,
    legacyDocument: opts.legacyDocument,
    runtime: opts.runtime,
    pageTopPt: opts.pageTopPt,
    persistedCoreDocument: opts.persistedCoreDocument,
    sidecar: opts.sidecar,
    // C-B1.1：编辑前快照 ⇒ before/after ⇒ export drop 投影
    beforeDocument: opts.beforeDocument ?? null,
    // F3B-6.28 · D 第一阶段：位移行 ⇒ 旧位置原算子剥离
    displacedLines: opts.displacedLines ?? null,
    unitMemberLines: opts.unitMemberLines ?? null,
    changedLineIds: opts.changedLineIds ?? null,
    // F3B-6.28 · D-3B-5：场景授权必须一路透传（漏掉 ⇒ 非 D1 场景被误放行）
    unitRedrawScenario: opts.unitRedrawScenario ?? null,
    // ★★ 2026-10-19（多计划）：按 unit 分组的重绘计划透传（3B2 段每计划独立跑管线）
    unitRedrawPlans: opts.unitRedrawPlans ?? null,
  });
  if (!eligibility.eligible) {
    return { ok: false, source: "core", reason: eligibility.reason, stage: "eligibility" };
  }
  const ctx = eligibility.context;

  // 2) bridge：Core EditorDocument → EditableDocument（纯函数，不修改 opts.legacyDocument）
  let editable: EditableDocument;
  let warnings: readonly string[] = [];
  try {
    const built = (opts.bridge ?? ((c) => c.toEditableDocument()))(ctx);
    editable = built.document;
    warnings = built.warnings;
  } catch (error) {
    return { ok: false, source: "core", reason: "bridge-error", stage: "bridge", error };
  }

  // 3) renderer：真实导出 PDF bytes
  let bytes: Uint8Array;
  try {
    bytes = await opts.exportEditableDocument(editable, opts.pdfBytes ?? undefined, opts.signatureRegions, undefined, opts.editedLineBoxes);
  } catch (error) {
    return { ok: false, source: "core", reason: "export-error", stage: "renderer", error };
  }

  // 4) validation：必须先生成 bytes 再决定 fallback（绝不 bridge 层 fallback）
  try {
    const valid = await (opts.validatePdf ?? defaultValidateExportedPdf)(bytes);
    if (!valid) return { ok: false, source: "core", reason: "invalid-pdf", stage: "validation" };
  } catch (error) {
    return { ok: false, source: "core", reason: "invalid-pdf", stage: "validation", error };
  }

  // D-3B-1：诊断随结果返回（**只读取证**；不参与任何写入决策）
  return { ok: true, bytes, source: "core", warnings, redrawDiagnostics: ctx.redrawDiagnostics() };
}
