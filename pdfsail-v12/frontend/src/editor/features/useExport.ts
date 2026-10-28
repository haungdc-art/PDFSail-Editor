/**
 * useExport — V12 简化版 + Sprint 7 EditableDocument Export
 *
 * Sprint 7 更新：
 *   - 优先用 EditableDocument 导出（exportEditableDocument）
 *   - 保留旧 TextBlock 导出作为 fallback（exportPDF）
 *   - Mutation 同步：编辑后 docBlocks 从 EditableDocument 重新生成，导出保持一致
 *
 * 流程：
 *   EditableDocument（主数据源）
 *     ↓ exportEditableDocument()
 *   ExportCommand[]
 *     ↓ pdf-lib
 *   PDF bytes
 *
 * Fallback：
 *   EditableDocument 为空 → docBlocks → exportPDF（旧路径）
 *
 * Ref 由 PDFEditorInner 持有并注入：
 *   coordRef / pdfBytesRef / cssScaleRef / editableDocumentRef
 */

import { useEditor } from "../core/EditorProvider";
import { exportPDF, downloadPDF, validateExportedPdf } from "../export-pdf";
import type { LockCoordSystem } from "../coord";
import type { EditableDocument, SignatureRenderRegion } from "../../document-model";
import type { EditorDocument } from "../core/document";
import { exportEditableDocument } from "../../document-model";
import type { Segment } from "../../editor-engine/types";
import type { CoreInputSession } from "../binding/core-input-source";
import {
  buildCoreExportContext,
  runCoreShadowExport,
  runCoreCandidateExport,
  resolveCoreDocument,
  buildCoreExportRuntime,
  runCoreProductionExport,
  CORE_EXPORT_SHADOW_FLAG,
  CORE_EXPORT_CANDIDATE_FLAG,
} from "../binding/build-core-export-context";
import { CORE_EXPORT_PRODUCTION_WIRED } from "../binding/pdf-export-bridge";
import type { BindingSidecar } from "../binding/binding-sidecar";
// F3B-6.28 · D 第一阶段：位移清除计划（身份 + 事务水位；无几何）
import {
  displacedClearPlanIsCurrent,
  type DisplacedClearPlan,
} from "../binding/affected-source-projection";
import { shouldAttemptCoreExport, type ExportOwnership } from "../binding/segment-core-commit";
import { coreExportTelemetry, recordProductionCoreExport } from "../binding/core-export-telemetry";
import { decideExportSafety, ExportSafetyError, decideUseExportE01Safety, type ExportSafety } from "../binding/export-safety-gate";

interface UseExportParams {
  coordRef: React.MutableRefObject<LockCoordSystem | null>;
  pdfBytesRef: React.MutableRefObject<ArrayBuffer | null>;
  cssScaleRef: React.MutableRefObject<number>;
  /** Sprint 7: EditableDocument 引用（主数据源） */
  editableDocumentRef?: React.MutableRefObject<EditableDocument | null>;
  /** Sprint 7: renderScale（默认 1.5） */
  renderScale?: number;
  /** Sprint 33.5.6: 签名区域数据（用于导出时应用旋转） */
  signatureRegionsRef?: React.MutableRefObject<SignatureRenderRegion[]>;
  /** M7.7-006: 编辑态真实墨迹覆盖盒（lineId → CSS bbox），供导出 mask 覆盖真实墨迹。 */
  editedLineBoxesRef?: React.MutableRefObject<Map<string, { x: number; y: number; width: number; height: number }> | undefined>;
  /** M7.8-020-PROD: segment 列表引用，导出前把文本编辑回写 EditableDocument。 */
  segmentsRef?: React.MutableRefObject<Segment[]>;
  /** M7.8-041: 跨页 segment 累积（导出专用）。展开全部已渲染页的编辑，避免翻页后其它页修改丢失。 */
  getAllPageSegments?: () => Segment[];
  /** EDITOR-CORE-012-F2：活跃 Core 输入 session ref（取真实生产 Core EditorDocument；无则按需从 legacy 引导） */
  coreInputSessionRef?: React.MutableRefObject<CoreInputSession | null>;
  /** EDITOR-CORE-012-F3B-1：import-time 持久化的唯一 Core EditorDocument ref（无活跃 session 时作为 production source） */
  coreDocumentRef?: React.MutableRefObject<EditorDocument | null>;
  /**
   * F3B-6.17-3C-6B1.1：**编辑前** Core 快照 ref（只在 import / rehydrate 边界写入）。
   *
   * ⚠️ 不能复用 `coreDocumentRef.current` 充当 before —— Core 提交分支会写
   * `coreDocumentRef.current = documentOf(session)`（PDFEditor），导出时 before === after，
   * 受影响行恒为空 ⇒ 原算子无法投影。
   */
  coreImportSnapshotRef?: React.MutableRefObject<EditorDocument | null>;
  /**
   * F3B-6.28 · D 第一阶段：受控 unit 编辑（`__unitEditing`）提交时登记的
   * **位移清除计划**（哪些后续原始行被段落重排推移、必须从旧位置剥离原算子）。
   *
   * 只在本层读取 `.current` 并与 Core 事务水位校验（`displacedClearPlanIsCurrent`）：
   *   · 计划缺失 / 事务已被 undo ⇒ **不传** `displacedLines`（行为与本阶段之前一致）；
   *   · 有效 ⇒ 传 `plan.lines` 给 Core export 的 drop 投影。
   * 不含任何几何/屏幕坐标（重绘几何属第二阶段）。
   */
  unitDisplacedClearRef?: React.MutableRefObject<DisplacedClearPlan | null>;
  /**
   * F3B-6.17 3B.1：Binding Sidecar ref（import-time immutable PDF fidelity snapshot）。
   *
   * ⚠️ 只在本层（React/feature）读取 `.current` 形成 **export-time snapshot** 后，
   * 把 `BindingSidecar | null` **值**传进 Core export；
   * binding 层**不得**接触 React ref（Sidecar generation 属于 export snapshot 的一部分）。
   */
  bindingSidecarRef?: React.MutableRefObject<BindingSidecar | null>;
  /**
   * F3B-6.17-3C-0.5：**export ownership**（按 document generation，"core" | "legacy"）。
   *
   * `"legacy"` ⇒ 本层**跳过 Core Export**、直接走 Legacy 导出。
   * 语义 = 「当前文档的编辑真相是否已由 Core semantic path 完整接管」：
   * 只要有一次 Segment 编辑未被 Core 接管（fallback / migration 关闭），就必须走 Legacy，
   * 否则该 legacy-only 编辑会在 Core 产物中**静默丢失**。
   */
  exportOwnershipRef?: React.MutableRefObject<ExportOwnership>;
}

export interface ExportResult {
  bytes: Uint8Array;
  blob: Blob;
  fileName: string;
  /** 导出方式：editableDocument（legacy 主）/ textBlock（legacy fallback）/ core（F3B-2 Core 生产导出） */
  exportSource: "editableDocument" | "textBlock" | "core";
}

/**
 * M7.8-020-PROD / M7.8-040：把 segment 层的文本编辑同步进 EditableDocument。
 * 实现抽到 segmentEditBinding.ts（纯 additive binding 层，无 React 依赖，便于测试）。
 * 这里在导出前调用它，按 Segment.source 精确回写，不依赖 indexOf(originalText)。
 */
import { applySegmentEditsToDocument } from "./segmentEditBinding";

export function useExport({
  coordRef,
  pdfBytesRef,
  cssScaleRef,
  editableDocumentRef,
  renderScale = 1.5,
  signatureRegionsRef,
  editedLineBoxesRef,
  segmentsRef,
  getAllPageSegments,
  coreInputSessionRef,
  coreDocumentRef,
  coreImportSnapshotRef,
  unitDisplacedClearRef,
  bindingSidecarRef,
  exportOwnershipRef,
}: UseExportParams) {
  const { docBlocks, fileName } = useEditor();

  /**
   * 生成 PDF 并返回 blob。
   *
   * Sprint 7：优先用 EditableDocument 导出，fallback 到 TextBlock。
   *
   * @param _skipPay 保留参数签名以兼容旧调用
   * @param download 是否触发本地下载
   * @returns ExportResult 或 null
   */
  const handleExport = async (
    _skipPay?: boolean,
    download = false
  ): Promise<ExportResult | null> => {
    if (!pdfBytesRef.current) return null;

    let bytes!: Uint8Array;
    let exportSource!: "editableDocument" | "textBlock" | "core";
    // 012-F2/F3B-2：hoist 出 legacy 基准 doc（供 Core 取 originalBounds / pageTopPt，以及 Legacy fallback）。
    // 仅在此补齐 runtime（既有行为），不修改 pages；Core 导出路径只读此 doc，绝不反向修改。
    const doc = editableDocumentRef?.current ?? null;
    /**
     * F3B-6.17 3B.2-B：**Legacy 专属** materialization 产物。
     *
     * ⚠️ 只在 `!usedCore`（Core 未接管 / 未启用 / 失败）时于下方 Legacy 分支内 lazy 生成。
     * Core Export 路径**不再**读取它（Core 用 `doc` + EditorDocument + Core Layout + BindingSidecar）。
     */
    let legacyDocForExport: EditableDocument | null = null;
    if (doc) {
      // 文档就绪时补齐 runtime（renderScale/cssScale 属于 Editor Runtime，非 Export 参数）。
      if (!doc.runtime) {
        doc.runtime = {
          renderScale,
          cssScale: cssScaleRef.current,
          pageMetrics: doc.pages.map((p) => ({ width: p.width, height: p.height })),
        };
      }
    }

    // ── EDITOR-CORE-012-F3B-2：Core Production Export（安全双路径）──────────────────
    // 仅当 CORE_EXPORT_PRODUCTION_WIRED 为真且确实存在 Core document source 时尝试，
    // 避免对纯 legacy 文档无效 double-export。
    // 流程：resolve Core → eligibility → bridge(Core→EditableDocument) → exportEditableDocument
    //       → validate PDF → ok? Core PDF : Legacy fallback。
    // 任何阶段失败（含 invalid-pdf）都回退 legacy，绝不产出坏 PDF。
    // Core 导出是纯 bridge（buildEditableDocument 返回新 EditableDocument），不修改 legacy doc。
    // F3B-6.17 3B.1：export-time Sidecar snapshot（本层唯一读取点）。
    // 之后只传这个值，binding 层不再回查 ref —— Sidecar generation 成为 export snapshot 的一部分。
    const sidecarSnapshot: BindingSidecar | null = bindingSidecarRef?.current ?? null;

    // ── F3B-6.28 · D 第一/第二步：位移清除计划（受控 unit 编辑）────────────────
    //   计划含「哪些后续原始行被段落重排推移」+「unit 全部成员行」（决策二）。
    //   这些行的 before/after diff 结构上发现不了（或不足以触发清除），
    //   只能由提交时显式登记。此处按 **Core 事务身份**校验：
    //     · 计划缺失 / 事务 id 已被取代（Undo 后又编辑）/ undo 过头 ⇒ 不传；
    //     · 有效 ⇒ 传 lines/memberLines 给 drop 投影（原算子被剥离）。
    //   ⚠️ 只传身份（blockId/lineId），不传任何屏幕坐标或 delta。
    // ★★ 2026-10-19（多计划）：**合并全部当前有效的 unit 计划**。旧单计划被每次
    //   新 unit 提交整体替换 ⇒ 只有最后一个 unit 的剥除/重绘在效 ⇒ 先前 unit 的行
    //   残留 ⇒ D-3B-4 核验 clear-incomplete ⇒ E-01。每个计划按自己的事务身份
    //   （appliedIndex / txId / sidecar 代次）独立校验：undo 过头某 unit ⇒ 仅该
    //   计划失效剔除，其余保留。memberLines 跨计划按 lineId 去重（同一行先后在
    //   多个 unit 时，重绘归属由 3B2 认领机制保证唯一）。
    const planMap = unitDisplacedClearRef?.current ?? null;
    const planHistory = coreInputSessionRef?.current?.history;
    const displacedAppliedCount = planHistory?.appliedCount ?? 0;
    const planEntries =
      typeof planHistory?.entries === "function" ? planHistory.entries() : null;
    const appliedTxIds =
      planEntries && displacedAppliedCount > 0
        ? planEntries.slice(0, displacedAppliedCount).map((t) => t.id)
        : [];
    const sidecarGenerationNow = bindingSidecarRef?.current?.generation ?? null;
    const validPlans: DisplacedClearPlan[] = planMap
      ? [...planMap.values()].filter((p) =>
          displacedClearPlanIsCurrent(p, {
            appliedCount: displacedAppliedCount,
            appliedTxIds,
            sidecarGeneration: sidecarGenerationNow,
          }),
        )
      : [];
    const planCurrent = validPlans.length > 0 ? validPlans[0]! : null;
    const displacedLines = validPlans.length
      ? validPlans.flatMap((p) => p.lines)
      : null;
    const unitMemberLines = validPlans.length
      ? [...new Map(validPlans.flatMap((p) => p.memberLines).map((m) => [m.lineId, m] as const)).values()]
      : null;
    // ★★ 2026-10-19（多计划）：**按 unit 分组的重绘计划**——flow 模型要求成员行
    //   top 单调（一个 unit 的连续行），多 unit 合并后跨页交错 ⇒ 3B2 必须每计划
    //   独立跑管线（扁平 unitMemberLines 仅供 drop 投影）。
    const unitRedrawPlans = validPlans.length
      ? validPlans.map((p) => ({
          memberLines: p.memberLines,
          displacedLines: p.lines,
          changedLineIds: p.changedLineIds,
        }))
      : null;

    let usedCore = false;
    let attemptedCore = false;
    let coreResult: Awaited<ReturnType<typeof runCoreProductionExport>> | undefined = undefined;
    const hasCoreSource = !!(coreInputSessionRef?.current ?? coreDocumentRef?.current);
    // ★ F3B-6.17-3C-0.5：export ownership（每 document generation）决定本次导出路径。
    //   ownership === "legacy" ⇒ **绝不**尝试 Core Export（Legacy fallback contract）。
    //   ⚠️ 不改变 `CORE_EXPORT_PRODUCTION_WIRED`（仍是全局 production wired）。
    const ownership: ExportOwnership = exportOwnershipRef?.current ?? "core";

    // ★ Redaction P0：文档含 redact / image / signature block 时，强制走 TextBlock / 原始 PDF 路径。
    //    exportPDF 才是真正 redaction（从 content stream 删除算子）的出口；Core 分支不消费这类
    //    block（它们只存在于 docBlocks，不进入 EditableDocument / Core document），否则 redaction 会丢失。
    const hasSpecialBlocks = docBlocks.some(
      (b) => b.type === "redact" || b.type === "image" || b.type === "signature",
    );

    const allowCoreExport = shouldAttemptCoreExport({
      ownership,
      coreExportWired: CORE_EXPORT_PRODUCTION_WIRED,
      hasCoreSource,
      hasDocument: !!doc,
    }) && !hasSpecialBlocks;
    // ⚠️ `&& doc` 不仅表达守卫，也是 TS 的 null 收窄（否则块内 `doc` 仍为 `EditableDocument | null`）
    if (allowCoreExport && doc) {
      const candidateRuntime = buildCoreExportRuntime({
        renderScale,
        cssScale: cssScaleRef.current,
        // F3B-6.17 3B.2-B：Core 只读 legacy **base** doc 的页宽高（Segment 文本编辑不改页尺寸）
        pageMetrics: doc.pages.map((p) => ({ width: p.width, height: p.height })),
      });
      if (candidateRuntime) {
        attemptedCore = true;
        coreResult = await runCoreProductionExport({
          session: coreInputSessionRef?.current ?? null,
          legacyDocument: doc,
          runtime: candidateRuntime,
          exportEditableDocument,
          validatePdf: validateExportedPdf,
          pdfBytes: pdfBytesRef.current,
          signatureRegions: signatureRegionsRef?.current,
          editedLineBoxes: editedLineBoxesRef?.current,
          // F3B-6.17 3B.1：bounds / originYPt 唯一来源 = BindingSidecar（provider 按 page.index 取）。
          // 已删除 legacy `pageTopPt` override（它按数组下标取，且会旁路 Sidecar provider）。
          sidecar: sidecarSnapshot,
          // F3B-1：无活跃 session 时，用 import-time 持久化的唯一 Core 文档作为 production source
          persistedCoreDocument: coreDocumentRef?.current ?? null,
          // F3B-6.17-3C-6B1.1：**编辑前** Core 快照（独立 ref，只在 import / rehydrate 写入）。
          // 与活跃 session 的当前 Core 文档构成 before/after ⇒ Binding 侧投影受影响原行的
          // operator/glyph（不改 Core、不改 Sidecar、不产生第二套 provenance）。
          beforeDocument: coreImportSnapshotRef?.current ?? null,
          // F3B-6.28 · D 第一阶段：位移行清除（文本未变但旧位置必须剥离）
          displacedLines,
          // F3B-6.28 · D 第二步（决策二）：unit 全部成员行（都会被 flow 重绘 ⇒ 原算子必须剥离）
          unitMemberLines,
          // F3B-6.28 · D-3B-1：本次事务实际改动的成员行（与上面两者**同一条**计划）。
          //   计划失效（Undo/Redo/事务被取代/换文档）⇒ planCurrent 为 null ⇒ 这里传 null
          //   ⇒ 导出侧回到保守模式（unresolved），绝不沿用过期声明。
          changedLineIds: planCurrent ? planCurrent.changedLineIds : null,
          // F3B-6.28 · D-3B-5：场景授权（与上面三者同源同计划；计划失效 ⇒ null）。
          //   仅 `d1-paragraph-append` 放行「原算子清除 + 重绘」；其它场景
          //   （替换/删除/合并/多段落流动/跨页推挤）⇒ unit 计划输入整体失效，
          //   导出走既有路径（用户 2026-10-14 裁决）。
          unitRedrawScenario: planCurrent ? planCurrent.scenario : null,
          // ★★ 2026-10-19（多计划）：按 unit 分组的重绘计划（3B2 每计划独立跑管线；
          //   扁平 unitMemberLines 仅供 drop 投影，跨 unit 交错的行不能合并进 flow）
          unitRedrawPlans: unitRedrawPlans,
        });
        if (coreResult.ok) {
          bytes = coreResult.bytes;
          exportSource = "core";
          usedCore = true;
          console.log("[CORE-EXPORT-PROD] Core 接管下载（eligible + valid PDF）", {
            bytes: bytes.length,
            warnings: coreResult.warnings.length,
          });
          // F3B-6.28 · D-3B-1：逐行诊断取证（**只读**；浏览器 e2e 从这里抓取）。
          //   ⚠️ 诊断 ok 不触发任何重绘 —— 3B-2 未授权。
          if (coreResult.redrawDiagnostics) {
            (window as unknown as Record<string, unknown>).__d3bDiag = coreResult.redrawDiagnostics;
            console.log(
              "[D3B-1-REDRAW-DIAG] changedSource=%s changedLineIds=%o ok=%s stage=%s lines=%d",
              coreResult.redrawDiagnostics.changedSource,
              coreResult.redrawDiagnostics.changedLineIds,
              coreResult.redrawDiagnostics.ok,
              coreResult.redrawDiagnostics.stage,
              coreResult.redrawDiagnostics.lines.length,
            );
            for (const l of coreResult.redrawDiagnostics.lines) {
              console.log(
                "[D3B-1-REDRAW-DIAG-LINE] %s role=%s status=%s origLen=%s targetLen=%s origBase=%s predBase=%s deltaPt=%s fidelity=%s coverage=%s/%s/%s reason=%s",
                l.lineId.slice(-4),
                l.role,
                l.status,
                l.originalTextLength,
                l.targetTextLength,
                l.originalBaselinePt?.toFixed(3) ?? "-",
                l.predictedBaselinePt?.toFixed(3) ?? "-",
                l.deltaPt?.toFixed(3) ?? "-",
                l.breakFidelity,
                l.coverage?.withFullProvenance ?? "-",
                l.coverage?.withSource ?? "-",
                l.coverage?.total ?? "-",
                l.reason ?? "-",
              );
            }
          }
        } else {
          // 可观测 fallback：结构化 reason + stage，不把内部错误直接暴露给用户。
          // Step 2c-C2-A-Impl：附带 error 摘要（仅日志，诊断用）—— 否则 bridge/renderer
          // 阶段抛错时无法定位（曾出现 stage:renderer 但无原因）。
          console.warn("[CORE-EXPORT-FALLBACK]", {
            reason: coreResult.reason,
            stage: coreResult.stage,
            error:
              coreResult.error instanceof Error
                ? coreResult.error.message
                : coreResult.error === undefined
                  ? undefined
                  : String(coreResult.error),
          });
        }
      }
    } else if (ownership === "legacy") {
      // ★ F3B-6.17-3C-0.5：Legacy fallback contract —— Core 未完整接管本文件 ⇒ Core Export
      //   必须让位（否则 legacy-only 编辑静默丢失）。走下方 Legacy 导出。
      console.log("[EXPORT-OWNERSHIP] legacy owns this document ⇒ 跳过 Core Export", {
        hasCoreSource,
        hasDoc: !!doc,
      });
    }

    // ── F3B-6.17 / E-01：Core 拥有文档时，若已尝试 Core 导出但引擎报告失败/不安全，
    // 绝不回退 Legacy（那会用不含 Core 编辑的 base 文档导出 → 下载到落后编辑状态的旧 PDF）。
    // 直接抛 ExportSafetyError，保留编辑状态，由上层（下载按钮）捕获并提示用户重试。
    // v1 接线（strictProvenance=false）：import provenance 覆盖率已知为 0，partial/unknown
    // 降级为 partial（不致命），Core 导出保持可用；待 import provenance 修复后切 strict。
    // generation 在 v1 阶段以 sidecar.generation 为准（sidecar 与 Core document 同源同代）。
    if (ownership === "core" && attemptedCore && !coreResult?.ok) {
      const e01 = decideUseExportE01Safety({
        ownership,
        attemptedCore,
        coreResult: coreResult
          ? { ok: coreResult.ok, reason: coreResult.reason, stage: coreResult.stage }
          : undefined,
        sidecarGeneration: sidecarSnapshot?.generation ?? null,
        coreExportWired: CORE_EXPORT_PRODUCTION_WIRED,
        hasCoreSource,
        strictProvenance: false,
      });
      if (e01.status === "unsafe") {
        throw new ExportSafetyError(
          `[E-01] Core-owned document Core export failed; refusing silent Legacy fallback: ${e01.reason}`,
          { status: "unsafe", reason: e01.reason },
        );
      }
    }

    // ── Legacy 导出（fallback / 未启用 Core / Core 失败）────────────────────────────
    if (!usedCore) {
      // F3B-6.17 3B.2-B：**Segment compatibility materialization 只属于 Legacy 路径**。
      // M7.8-020-PROD：导出前把 segment 的文本编辑回写 EditableDocument；
      // M7.8-041：优先用跨页累积 segments（展开全部已渲染页 + 回放编辑）。
      // Core 成功接管时本块完全不执行 ⇒ Core 路径 applySegmentEditsToDocument caller = 0。
      if (doc) {
        const allEditSegs = getAllPageSegments ? getAllPageSegments() : (segmentsRef?.current ?? []);
        console.log("[EXPORT-DIAG]", {
          willUse: "editableDocument",
          allEditSegs: allEditSegs.length,
          docPage0Block0Line0: doc.pages[0]?.blocks[0]?.lines?.[0]?.glyphs?.map((g: any) => g.char).join(""),
          docEditedLines: doc.pages.flatMap((p: any) => p.blocks).flatMap((b: any) => b.lines).filter((l: any) => l.edited || l.glyphs?.some((g: any) => g.modified)).length,
        });
        legacyDocForExport = allEditSegs.length ? applySegmentEditsToDocument(doc, allEditSegs) : doc;
      }
      if (legacyDocForExport && !hasSpecialBlocks) {
        try {
          bytes = await exportEditableDocument(
            legacyDocForExport,
            pdfBytesRef.current,
            signatureRegionsRef?.current,
            undefined,
            // M7.7-006: 真实墨迹覆盖盒 → 导出 mask 盖住旧文字像素，避免残留
            editedLineBoxesRef?.current
          );
          exportSource = "editableDocument";
          console.log("[Sprint 7] Export from EditableDocument:", {
            pages: legacyDocForExport.pages.length,
            styles: legacyDocForExport.styles.length,
          });
        } catch (e) {
          console.warn("[Sprint 7] EditableDocument export failed, falling back to TextBlock:", e);
          bytes = await exportFromTextBlocks();
          exportSource = "textBlock";
        }
      } else {
        // 无 EditableDocument，或含 redact/image/signature block（这些只存在于 docBlocks，
        // 不进入 EditableDocument）→ 用旧 TextBlock 导出（经由 exportPDF 原始 PDF 路径，含真正 redaction）
        bytes = await exportFromTextBlocks();
        exportSource = "textBlock";
      }
    }

    // ── EDITOR-CORE-012-F2：Core Export Shadow Path（诊断专用）──────────────────────
    // 真实生产 Core EditorDocument 第一次经过现有 PDF exporter，但：
    //   · 不下载、不替换用户结果（legacy bytes 已确定）
    //   · 任意失败（runtime 缺失 / 桥接异常 / 导出异常）→ 仅 warning，绝不抛到用户路径
    //   · 默认关闭，仅当 globalThis.__coreExportShadow 为真时运行
    if ((globalThis as Record<string, unknown>)[CORE_EXPORT_SHADOW_FLAG]) {
      try {
        // F3B-6.17 3B.2-B：诊断路径同 Core —— 只用 legacy **base** doc（不再用 materialization 产物）
        const legacyForCore = doc ?? editableDocumentRef?.current;
        const runtime = editableDocumentRef?.current?.runtime;
        if (legacyForCore && runtime) {
          const coreDoc = resolveCoreDocument(coreInputSessionRef?.current ?? null, legacyForCore);
          if (coreDoc) {
            void runCoreShadowExport({
              coreDocument: coreDoc,
              legacyDocument: legacyForCore,
              runtime,
              sidecar: sidecarSnapshot,
              exportEditableDocument,
              pdfBytes: pdfBytesRef.current,
              signatureRegions: signatureRegionsRef?.current,
              editedLineBoxes: editedLineBoxesRef?.current,
            })
              .then((r) => {
                if (r.ok) {
                  console.log("[CORE-EXPORT-SHADOW] 影子导出完成（诊断，不影响用户下载）", {
                    bytes: r.bytes.length,
                    warnings: r.warnings.length,
                  });
                } else {
                  console.warn("[CORE-EXPORT-SHADOW] 影子导出跳过/失败（不影响用户下载）:", r.error);
                }
              })
              .catch((e) => {
                console.warn("[CORE-EXPORT-SHADOW] 影子导出异常（不影响用户下载）:", e);
              });
          } else {
            console.warn("[CORE-EXPORT-SHADOW] 跳过：无法解析 Core 文档");
          }
        } else {
          console.warn("[CORE-EXPORT-SHADOW] 跳过：legacyDocument 或 runtime 缺失");
        }
      } catch (e) {
        console.warn("[CORE-EXPORT-SHADOW] 影子导出异常（不影响用户下载）:", e);
      }
    }

    // ── EDITOR-CORE-012-F3A：Core Export Candidate（诊断专用，不替换默认下载）────
    // 与 F2 shadow 的区别：先经 evaluateCoreExportEligibility 判定资格，
    // 且**绝不**在 export 时隐式创建 Core session（无 Core document → 直接走 legacy）。
    // 默认用户下载结果仍来自上方 legacy bytes。候选成功/失败都只做诊断。
    if ((globalThis as Record<string, unknown>)[CORE_EXPORT_CANDIDATE_FLAG]) {
      try {
        // F3B-6.17 3B.2-B：诊断路径同 Core —— 只用 legacy **base** doc（不再用 materialization 产物）
        const legacyForCore = doc ?? editableDocumentRef?.current;
        if (legacyForCore) {
          // F3A-5：runtime 来自**真实当前文档/页面上下文**（含可能随 resize 变化的 cssScale），
          // 缺失/非法 → buildCoreExportRuntime 返回 null → 候选不进入（绝不 1/1 fallback）。
          const candidateRuntime = buildCoreExportRuntime({
            renderScale,
            cssScale: cssScaleRef.current,
            pageMetrics: legacyForCore.pages.map((p) => ({ width: p.width, height: p.height })),
          });
          void runCoreCandidateExport({
            session: coreInputSessionRef?.current ?? null,
            legacyDocument: legacyForCore,
            runtime: candidateRuntime ?? undefined,
            exportEditableDocument,
            pdfBytes: pdfBytesRef.current,
            signatureRegions: signatureRegionsRef?.current,
            editedLineBoxes: editedLineBoxesRef?.current,
            // F3B-6.17 3B.1：originYPt 唯一来源 = BindingSidecar provider（按 page.index）；已删除 legacy override
            sidecar: sidecarSnapshot,
            // F3B-1：无活跃 session 时，用 import-time 持久化的唯一 Core 文档作为 production source
            // （不在此处隐式 createCoreInputSession / initializeCoreDocument）
            persistedCoreDocument: coreDocumentRef?.current ?? null,
          })
            .then((r) => {
              if (r.attempted && r.shadow && r.shadow.ok) {
                console.log("[CORE-EXPORT-CANDIDATE] 候选导出完成（诊断，不影响用户下载）", {
                  bytes: r.shadow.bytes.length,
                  warnings: r.shadow.warnings.length,
                });
              } else if (r.attempted && r.shadow && !r.shadow.ok) {
                console.warn("[CORE-EXPORT-CANDIDATE] 候选导出失败（不影响用户下载）:", r.shadow.error);
              } else if (!r.attempted) {
                console.warn(`[CORE-EXPORT-CANDIDATE] 不符合条件，跳过：${r.reason}`);
              }
            })
            .catch((e) => {
              console.warn("[CORE-EXPORT-CANDIDATE] 候选导出异常（不影响用户下载）:", e);
            });
        }
      } catch (e) {
        console.warn("[CORE-EXPORT-CANDIDATE] 异常（不影响用户下载）:", e);
      }
    }

    // ── EDITOR-CORE-012-F3B-3：Core Export Production Observability ──────────────
    // 把每次 Download 的 Core 接管/回退结果沉淀为可统计 coverage 数据（reason/stage/exportSource）。
    // telemetry **fail-open**：任何异常都不影响用户下载路径。
    try {
      // F3B-6.17 3B.2-B：provenance 只看 block.source 种类（materialization 不改它）⇒ 用 legacy **base** doc，
      // 避免为了 telemetry 在 Core 路径上触发 Segment materialization。
      const provenance = doc
        ? Array.from(new Set(doc.pages.flatMap((p) => p.blocks).map((b) => String(b.source))))
        : undefined;
      // EDITOR-CORE-012-F3B-5-B：真实 download path 经 production wiring helper 写 telemetry
      // （派生 documentState / rendererStatus / validationStatus，单独统计 missing-original-bounds）。
      // helper 内部 fail-open；外层 try/catch 为第二道防线，telemetry 异常绝不阻断下载。
      recordProductionCoreExport({
        attempted: attemptedCore,
        coreResult: coreResult ?? undefined,
        exportSource,
        provenance,
        // Legacy 路径 = materialized（与 3B.2-B 之前一致）；Core 接管时退化为 legacy base doc（不再 materialize）
        docForExport: legacyDocForExport ?? doc ?? undefined,
      });
    } catch {
      /* telemetry 失败绝不影响用户下载 */
    }

    const outName = `edited-${fileName || "output"}.pdf`;
    if (download) {
      downloadPDF(bytes, outName);
    }
    const blob = new Blob([bytes.slice().buffer], {
      type: "application/pdf",
    });
    return { bytes, blob, fileName: outName, exportSource };
  };

  /**
   * 旧 TextBlock 导出路径（fallback）
   */
  const exportFromTextBlocks = async (): Promise<Uint8Array> => {
    if (!coordRef.current) {
      throw new Error("CoordSystem not available for TextBlock export");
    }
    const s = cssScaleRef.current;
    const pxBlocks = docBlocks.map((b) => ({
      ...b,
      x: b.x / s,
      y: b.y / s,
      w: b.w / s,
      h: b.h / s,
      fontSize: b.fontSize ? b.fontSize / s : b.fontSize,
    }));
    const { bytes, warnings } = await exportPDF(pxBlocks, coordRef.current, pdfBytesRef.current!);
    if (warnings.length > 0) {
      // 图片 / 签名资源未能写入 PDF = 内容丢失，必须让上层看到（不得静默导出）
      console.warn("[export][export-pdf] asset(s) failed:", warnings);
    }
    return bytes;
  };

  return { handleExport };
}
