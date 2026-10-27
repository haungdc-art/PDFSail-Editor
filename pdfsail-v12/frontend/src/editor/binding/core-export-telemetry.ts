/**
 * core-export-telemetry.ts — EDITOR-CORE-012-F3B-3
 *
 * Core Export Production Observability & Coverage。
 *
 * F3B-2 已经把 Core 生产导出接到了用户 Download，并且 `reason` / `stage` / `exportSource`
 * 已经是结构化字段。本模块把每一次 Download 的结果**沉淀成可统计的 coverage 数据**：
 *
 *   - 成功接管 Core 多少次？
 *   - 回退 Legacy 多少次？按 reason / stage 拆分。
 *   - 哪些文档根本没进入 Core（legacy-only）？
 *   - 哪些 provenance / document state 仍然无法进入 Core？
 *
 * 设计原则：
 *   · 这是一个**本地内存 sink + 聚合器**，不触碰网络 / 不上报任何用户文档内容。
 *   · `onRecord` 是一个 transport seam：未来要接 analytics beacon 时，只需在创建时传入，
 *     调用方（useExport）无需改动。
 *   · 聚合计数器与有界原始缓冲分离：缓冲溢出（保留最近 N 条）不会丢失统计。
 *   · 调用方必须 fail-open：telemetry 永不抛出到用户下载路径。
 *
 * 红线（同 F3B-2）：
 *   ❌ 不删除 Legacy / 不修改 Core 导出语义 / 不把 Core 当作唯一真相源。
 *   ❌ 本模块只读 `reason/stage/exportSource` 等已有结构化字段，不引入新的导出逻辑。
 */

import type { CoreExportFailureReason, CoreExportStage } from "./build-core-export-context";

/** 一次 Download 的最终结果类别 */
export type CoreExportOutcome = "core" | "legacy-fallback" | "legacy-only";

/** 最终下载来源（与 useExport 的 ExportResult.exportSource 对齐） */
export type CoreExportEventSource = "core" | "editableDocument" | "textBlock";

/**
 * 单次 Core 生产导出事件（结构化，可统计）。
 *
 * - `attempted`：Core 生产管线是否真的跑过（eligibility 是否评估过）。
 * - `eligible`：是否通过 eligibility（仅 attempted 时有意义）。
 * - `outcome`：core / legacy-fallback / legacy-only。
 * - `reason` / `stage`：仅 fallback 时有意义（结构化失败原因 + 阶段）。
 * - `provenance`：文档文本来源种类（覆盖「哪些 provenance 仍进不了 Core」）。
 */
/** 文档状态（从 legacy 文档派生，不读取任何正文文本 / 文件名） */
export type CoreExportDocumentState = "empty" | "pristine" | "edited";

/** renderer / validation 阶段状态 */
export type CoreExportStageStatus = "ok" | "error" | "skipped";

export interface CoreExportEvent {
  ts?: number;
  attempted: boolean;
  eligible: boolean;
  outcome: CoreExportOutcome;
  /** 下载来源（F3B-5-B 的「source」维度）：core / editableDocument / textBlock */
  exportSource: CoreExportEventSource;
  reason?: CoreExportFailureReason;
  stage?: CoreExportStage;
  pageCount?: number;
  /** 文档文本来源种类（只读 block.source，不含正文） */
  provenance?: readonly string[];
  // ── EDITOR-CORE-012-F3B-5-B 新增（满足 beacon 要求的粒度）────────────
  /** 文档状态（empty / pristine / edited，从 legacy 文档派生，不读取正文） */
  documentState?: CoreExportDocumentState;
  /** renderer 阶段状态：skipped（Core 未尝试）/ error（stage==="renderer"）/ ok */
  rendererStatus?: CoreExportStageStatus;
  /** validation 阶段状态：skipped（Core 未尝试）/ failed（stage==="validation"）/ ok */
  validationStatus?: CoreExportStageStatus;
}

/** 覆盖率汇总（可回答 F3B-3 的核心问题） */
export interface CoreExportCoverageSummary {
  /** 总下载次数 */
  totalDownloads: number;
  /** Core 成功接管下载 */
  coreExports: number;
  /** 进入 Core 但回退 Legacy（任意阶段失败） */
  coreFallbacks: number;
  /** 根本没进入 Core（flag 关 / 无 Core 源 / runtime 缺失） */
  legacyOnly: number;
  /** Core 成功率 = core / (core + fallback) */
  coreSuccessRate: number;
  /** Core 资格覆盖率 = (core + fallback) / totalDownloads */
  coreEligibilityRate: number;
  /** 回退按原因拆分（含 eligibility / bridge / renderer / validation 全部 reason） */
  fallbacksByReason: Partial<Record<CoreExportFailureReason, number>>;
  /** 回退按阶段拆分 */
  fallbacksByStage: Partial<Record<CoreExportStage, number>>;
  /** 资格不通过按原因拆分（仅 stage === "eligibility"） */
  ineligibleByReason: Partial<Record<CoreExportFailureReason, number>>;
  /** validation 失败次数（先生成 bytes 再校验失败） */
  validationFailures: number;
  /** 单独统计 missing-original-bounds（eligibility 阶段，F3B-5 专项观测） */
  missingOriginalBounds: number;
}

export interface CoreExportTelemetry {
  /** 记录一次 Download 的 Core 接管/回退结果（fail-open） */
  record(event: CoreExportEvent): void;
  /** 当前覆盖率汇总 */
  summarize(): CoreExportCoverageSummary;
  /** 清空所有计数（测试用） */
  reset(): void;
  /** 有界原始事件缓冲（仅供调试，不保证完整历史） */
  events(): readonly CoreExportEvent[];
}

export interface CreateCoreExportTelemetryOptions {
  /** 原始事件缓冲上限（默认 200；溢出只丢旧事件，不丢聚合计数） */
  maxRawBuffer?: number;
  /** transport seam：每条事件都会回调（未来接 analytics beacon 用，本模块不内置网络） */
  onRecord?: (event: CoreExportEvent) => void;
}

function emptySummary(): CoreExportCoverageSummary {
  return {
    totalDownloads: 0,
    coreExports: 0,
    coreFallbacks: 0,
    legacyOnly: 0,
    coreSuccessRate: 0,
    coreEligibilityRate: 0,
    fallbacksByReason: {},
    fallbacksByStage: {},
    ineligibleByReason: {},
    validationFailures: 0,
    missingOriginalBounds: 0,
  };
}

/**
 * 创建一个 Core 导出遥测 sink（内存 + 聚合）。
 *
 * 默认导出 `coreExportTelemetry` 单例供生产使用；测试可 `createCoreExportTelemetry()` 取独立实例。
 */
export function createCoreExportTelemetry(
  opts: CreateCoreExportTelemetryOptions = {}
): CoreExportTelemetry {
  const maxRawBuffer = opts.maxRawBuffer ?? 200;
  const raw: CoreExportEvent[] = [];
  const summary = emptySummary();

  return {
    record(event: CoreExportEvent): void {
      const stamped: CoreExportEvent = { ...event, ts: event.ts ?? Date.now() };

      // transport seam（不在此处做网络；fail-open）
      if (opts.onRecord) {
        try {
          opts.onRecord(stamped);
        } catch {
          /* transport 失败不影响主路径 */
        }
      }

      // 有界缓冲：只保留最近 N 条，不影响聚合
      raw.push(stamped);
      if (raw.length > maxRawBuffer) raw.splice(0, raw.length - maxRawBuffer);

      // 聚合（纯计数，不抛）
      summary.totalDownloads += 1;
      if (stamped.outcome === "core") {
        summary.coreExports += 1;
      } else if (stamped.outcome === "legacy-fallback") {
        summary.coreFallbacks += 1;
        if (stamped.reason) {
          summary.fallbacksByReason[stamped.reason] = (summary.fallbacksByReason[stamped.reason] ?? 0) + 1;
        }
        if (stamped.stage) {
          summary.fallbacksByStage[stamped.stage] = (summary.fallbacksByStage[stamped.stage] ?? 0) + 1;
        }
        if (stamped.stage === "eligibility" && stamped.reason) {
          summary.ineligibleByReason[stamped.reason] = (summary.ineligibleByReason[stamped.reason] ?? 0) + 1;
        }
        if (stamped.stage === "validation") {
          summary.validationFailures += 1;
        }
        if (stamped.stage === "eligibility" && stamped.reason === "missing-original-bounds") {
          summary.missingOriginalBounds += 1;
        }
      } else {
        summary.legacyOnly += 1;
      }
    },

    summarize(): CoreExportCoverageSummary {
      const attempted = summary.coreExports + summary.coreFallbacks;
      return {
        ...summary,
        coreSuccessRate: attempted > 0 ? summary.coreExports / attempted : 0,
        coreEligibilityRate: summary.totalDownloads > 0 ? attempted / summary.totalDownloads : 0,
        fallbacksByReason: { ...summary.fallbacksByReason },
        fallbacksByStage: { ...summary.fallbacksByStage },
        ineligibleByReason: { ...summary.ineligibleByReason },
      };
    },

    reset(): void {
      raw.length = 0;
      Object.assign(summary, emptySummary());
    },

    events(): readonly CoreExportEvent[] {
      return raw;
    },
  };
}

/**
 * F3B-5-C — Production beacon transport（复用已加载的 Microsoft Clarity，不新建 backend）。
 *
 * index.html 已加载 Clarity(tag xqxbxvifhi)。`clarity("event", "core_export", flat)`
 * 把每次下载的结构化 coverage 事件发到现有 Clarity 项目，无需任何新基础设施。
 *
 * payload 已验证 PII-free（F3B-5-B §4）：不含 PDF bytes / 正文 / 文件名 / 用户 ID / 坐标 / block ID。
 *
 * Clarity 自定义事件要求扁平 string KV，故在边界把 event 拍平：
 *   - provenance: string[] → CSV
 *   - 派生 missingOriginalBounds 布尔（per-event，stage==="eligibility" && reason==="missing-original-bounds"）
 * 其余字段原样（均为 primitive，统一转 string 以最大化 Clarity 摄取保真度）。
 *
 * 全程 fail-open：window.clarity 不存在 / 抛错都不影响下载主路径（record() 外层另有 try/catch）。
 */
/**
 * provenance 仅允许保留 source kind（与 document-model/types TextSource 对齐：
 * "pdf_native" | "ocr" | "hybrid"）。任何非 source-kind 的 token（疑似正文 / 文件名 /
 * blockId / geometry）在 adapter 边界丢弃，不上送 Clarity（F3B-5-C 隐私红线 #9/#10）。
 * canonical event 不被修改；若未来 TextSource 新增成员，需同步此处 allowlist。
 */
const PROVENANCE_SOURCE_KINDS = new Set(["pdf_native", "ocr", "hybrid"]);

export function createClarityCoreExportTransport(): (event: CoreExportEvent) => void {
  return (event: CoreExportEvent): void => {
    if (typeof window === "undefined") return;
    const clarity = (window as unknown as {
      clarity?: (method: string, ...args: unknown[]) => void;
    }).clarity;
    if (typeof clarity !== "function") return;

    const flat: Record<string, string> = {
      ts: String(event.ts ?? Date.now()),
      attempted: String(event.attempted),
      eligible: String(event.eligible),
      outcome: event.outcome,
      exportSource: event.exportSource,
      documentState: event.documentState ?? "n/a",
      rendererStatus: event.rendererStatus ?? "n/a",
      validationStatus: event.validationStatus ?? "n/a",
      pageCount: String(event.pageCount ?? 0),
      provenance: (event.provenance ?? [])
        .filter((p): p is string => typeof p === "string" && PROVENANCE_SOURCE_KINDS.has(p))
        .join(","),
      missingOriginalBounds: String(
        event.stage === "eligibility" && event.reason === "missing-original-bounds",
      ),
    };
    if (event.reason) flat.reason = event.reason;
    if (event.stage) flat.stage = event.stage;

    try {
      clarity("event", "core_export", flat);
    } catch {
      /* Clarity 上报失败不影响下载 */
    }
  };
}

/** 生产默认 sink（useExport 直接调用 record）；onRecord 复用已加载的 Clarity */
export const coreExportTelemetry = createCoreExportTelemetry({
  onRecord: createClarityCoreExportTransport(),
});

// ───────────────────────────────────────────────────────────────────────────
// EDITOR-CORE-012-F3B-5-B：Production wiring helper
// ───────────────────────────────────────────────────────────────────────────
// useExport 的真实下载路径调用本函数（而非内联 record），以便「真实 download path」
// 与测试共用同一段 wiring 逻辑。本函数：
//   · 从 attempted / coreResult / exportSource / docForExport 派生
//     documentState / rendererStatus / validationStatus（不读取任何正文文本）；
//   · 写入给定 telemetry（默认生产单例）；
//   · 纯粹 fail-open：调用方（useExport）外层仍有 try/catch，这里也不抛。
// 绝不引入 PDF bytes / 正文 / 文件名 / 用户 ID。

/** docForExport 的最小只读结构（供 documentState 派生，避免引入整包类型依赖） */
export interface CoreExportDocumentLike {
  pages: ReadonlyArray<{
    blocks: ReadonlyArray<{
      source?: unknown;
      lines: ReadonlyArray<{
        edited?: boolean;
        glyphs: ReadonlyArray<{ modified?: boolean }>;
      }>;
    }>;
  }>;
}

export interface ProductionCoreExportTelemetryInput {
  attempted: boolean;
  coreResult?: { ok: boolean; reason?: CoreExportFailureReason; stage?: CoreExportStage };
  exportSource: CoreExportEventSource;
  provenance?: readonly string[];
  docForExport?: CoreExportDocumentLike;
  /** 自定义 sink（默认用生产单例）；测试可注入带 throwing onRecord 的实例 */
  telemetry?: CoreExportTelemetry;
}

function deriveDocumentState(doc: CoreExportDocumentLike | undefined): CoreExportDocumentState {
  if (!doc || doc.pages.length === 0) return "empty";
  let hasBlock = false;
  for (const p of doc.pages) {
    for (const b of p.blocks) {
      hasBlock = true;
      for (const l of b.lines) {
        if (l.edited) return "edited";
        for (const g of l.glyphs) if (g.modified) return "edited";
      }
    }
  }
  return hasBlock ? "pristine" : "empty";
}

/**
 * useExport 真实下载路径调用的生产 wiring 入口。
 * 派生 renderer/validation/document 状态后写入 telemetry（fail-open）。
 */
export function recordProductionCoreExport(input: ProductionCoreExportTelemetryInput): void {
  const tel = input.telemetry ?? coreExportTelemetry;
  const attempted = input.attempted;
  const ok = input.coreResult ? input.coreResult.ok : false;
  const reason = !ok ? input.coreResult?.reason : undefined;
  const stage = !ok ? input.coreResult?.stage : undefined;

  let rendererStatus: CoreExportStageStatus;
  let validationStatus: CoreExportStageStatus;
  if (!attempted) {
    rendererStatus = "skipped";
    validationStatus = "skipped";
  } else if (ok) {
    rendererStatus = "ok";
    validationStatus = "ok";
  } else if (stage === "renderer") {
    rendererStatus = "error";
    validationStatus = "skipped";
  } else if (stage === "validation") {
    rendererStatus = "ok";
    validationStatus = "failed";
  } else {
    // eligibility / bridge 失败：renderer 与 validation 阶段未到达
    rendererStatus = "skipped";
    validationStatus = "skipped";
  }

  tel.record({
    attempted,
    eligible: ok,
    outcome: input.exportSource === "core" ? "core" : attempted ? "legacy-fallback" : "legacy-only",
    exportSource: input.exportSource,
    reason,
    stage,
    pageCount: input.docForExport?.pages.length,
    provenance: input.provenance,
    documentState: deriveDocumentState(input.docForExport),
    rendererStatus,
    validationStatus,
  });
}
