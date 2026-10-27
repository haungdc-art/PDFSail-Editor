/**
 * editor/binding/export-safety-gate.ts — Export Safety Contract (Sprint 1 / E-01)
 *
 * 这是 PDFSail「fidelity-gated export」的核心契约模块。
 *
 * 设计原则（来自 F3B-6.17 审计结论与用户策略）：
 *   1. 导出宁可失败，也**绝不**静默导出落后于当前编辑状态的 PDF。
 *   2. Core 拥有文档时，Core 导出失败**不允许**回退到 Legacy（那会用不含 Core 编辑的
 *      base 文档导出 → 下载到旧 PDF）。直接失败，保留编辑状态，让用户重试。
 *   3. 只有 SAFE 才允许下载；PARTIAL / UNKNOWN 一律不叫 "export success"。
 *
 * 本模块是**纯函数 + 零 React / 零 export-renderer 依赖**，可独立单测。
 * 调用方（useExport.handleExport）必须在尝试导出前先过此 gate；
 * 任何 unsafe / partial 都必须中止导出，不得 fallback。
 *
 * 注意（v1 接线逃生口）：当前 import provenance 覆盖率已知为 0（见 F3B-6.17 3C-6B1.1 P0），
 * 若把 provenance partial/unknown 直接判死，会把**所有** Core 导出都变成 fail。
 * 因此 decideExportSafety 接受 `strictProvenance`：
 *   - false（v1 默认）：provenance 无法可靠计算时降级为 `partial`（记录，不致命）；
 *     但"Core 导出引擎自身报告保真失败"仍判 unsafe（这不需要 provenance 覆盖率）。
 *   - true（用户字面语义）：provenance partial/unknown ⇒ unsafe（fail）。
 *   一旦 import provenance 覆盖率被修复，调用方应传 strictProvenance=true。
 */

import type { ExportOwnership } from "./segment-core-commit";

/** 受影响行的保真（provenance）覆盖状态 */
export type ProvenanceStatus = "complete" | "partial" | "unknown" | "unverified";

export interface ExportSafetyInput {
  /** 文档所有权：core = Core 语义编辑拥有；legacy = Legacy 拥有 */
  ownership: ExportOwnership;
  /** CORE_EXPORT_PRODUCTION_WIRED：Core 导出是否在生产接线 */
  coreExportWired: boolean;
  /** 是否存在可用的 Core 源（活跃 session 或 import 期持久化 Core 文档） */
  hasCoreSource: boolean;
  /** BindingSidecar.generation（import 期文档世代标识） */
  sidecarGeneration: number | null;
  /** Core 文档构建时所依据的世代（通常与 sidecarGeneration 同源） */
  coreDocumentGeneration: number | null;
  /** import 期快照世代（coreImportSnapshotRef） */
  snapshotGeneration: number | null;
  /** 受影响行的 provenance 覆盖状态 */
  provenance: ProvenanceStatus;
  /** 仅当已尝试 Core 导出时提供；用于把引擎自身报告的保真失败判为 unsafe */
  coreExportResult?: { ok: boolean; reason?: string; stage?: string };
  /** v1 逃生口；详见文件头注释 */
  strictProvenance?: boolean;
}

export type ExportSafety =
  | { status: "safe"; path: "legacy" | "core" }
  | { status: "unsafe"; reason: string }
  | { status: "partial"; reason: string };

/** 当 gate 判定 unsafe/partial 时，调用方应抛出此错误以中止导出（保留编辑状态） */
export class ExportSafetyError extends Error {
  constructor(
    message: string,
    public readonly safety: { status: "unsafe" | "partial"; reason: string },
  ) {
    super(message);
    this.name = "ExportSafetyError";
  }
}

/**
 * 判定某次导出是否安全。
 * 纯函数：不读全局、不抛异常（调用方负责把 unsafe/partial 转成中止）。
 */
export function decideExportSafety(input: ExportSafetyInput): ExportSafety {
  const {
    ownership,
    coreExportWired,
    hasCoreSource,
    sidecarGeneration,
    coreDocumentGeneration,
    snapshotGeneration,
    provenance,
    coreExportResult,
    strictProvenance = false,
  } = input;

  // ── Legacy ownership：只允许走 Legacy 导出（既有行为，不做保真 gate）────────
  if (ownership === "legacy") {
    return { status: "safe", path: "legacy" };
  }

  // ── 以下都是 Core ownership ──────────────────────────────────────────

  // 用户表：Core ownership + Core export 不可用 → Fail
  if (!coreExportWired || !hasCoreSource) {
    return { status: "unsafe", reason: "core-owned but core export source unavailable" };
  }

  // 用户表：Core ownership + generation mismatch / missing → Fail
  // 文档世代必须一致：sidecar / core doc / import snapshot 同源同代。
  const generations = [sidecarGeneration, coreDocumentGeneration, snapshotGeneration];
  if (generations.some((g) => g === null)) {
    return { status: "unsafe", reason: "core-owned but document generation identity missing" };
  }
  if (new Set(generations).size !== 1) {
    return { status: "unsafe", reason: "core-owned but document generation mismatch" };
  }

  // 用户表：Core ownership + PARTIAL / UNKNOWN / UNVERIFIED provenance → Fail（strict）
  // 用户表：Core export exception / invalid PDF → Fail
  // 放在 provenance 降级之前：导出引擎自身报告失败是比"provenance 不可靠"更强的失败信号，
  // 必须优先判 unsafe（即使 provenance 只是 tolerant 下的 partial）。
  if (coreExportResult && !coreExportResult.ok) {
    return {
      status: "unsafe",
      reason: `core export failed at ${coreExportResult.stage ?? "unknown"}: ${coreExportResult.reason ?? "unknown"}`,
    };
  }

  const provenanceFatal = provenance === "partial" || provenance === "unknown" || provenance === "unverified";
  if (provenanceFatal) {
    if (strictProvenance) {
      return { status: "unsafe", reason: `core-owned but provenance is ${provenance}` };
    }
    // v1 逃生：provenance 无法可靠计算时不致命，但明确标记 partial（绝不叫 success）。
    return { status: "partial", reason: `provenance ${provenance} (tolerant v1)` };
  }

  return { status: "safe", path: "core" };
}

/**
 * E-01 (F3B-6.17) gate helper：判断在 Core 拥有文档且已尝试 Core 导出的前提下，
 * 是否应当因「Core 导出失败/不安全」而抛出 ExportSafetyError（而非静默回退 Legacy）。
 *
 * 纯函数，无 React / 无 export-renderer 依赖，可独立单测。
 */
export function decideUseExportE01Safety(params: {
  ownership: ExportOwnership;
  attemptedCore: boolean;
  coreResult?: { ok: boolean; reason?: string; stage?: string };
  sidecarGeneration: number | null;
  coreExportWired: boolean;
  hasCoreSource: boolean;
  strictProvenance?: boolean;
}): ExportSafety {
  // 非 Core 拥有 / 未尝试 Core / Core 已成功 ⇒ 不触发 E-01（具体导出路径由调用方决定）。
  if (params.ownership !== "core" || !params.attemptedCore || params.coreResult?.ok) {
    return { status: "safe", path: "core" };
  }
  // 复用到期的 Export Safety Contract（decideExportSafety）：
  // Core 拥有 + Core 引擎报告失败（coreExportResult.ok=false）⇒ 判定 unsafe。
  // v1 宽松：provenance 不可靠时不致命（降级 partial，不在此分支）；
  // generation 在 v1 阶段以 sidecar.generation 为准（sidecar 与 Core document 同源同代）。
  return decideExportSafety({
    ownership: params.ownership,
    coreExportWired: params.coreExportWired,
    hasCoreSource: params.hasCoreSource,
    sidecarGeneration: params.sidecarGeneration,
    coreDocumentGeneration: params.sidecarGeneration,
    snapshotGeneration: params.sidecarGeneration,
    provenance: "unverified",
    coreExportResult: params.coreResult
      ? { ok: params.coreResult.ok, reason: params.coreResult.reason, stage: params.coreResult.stage }
      : undefined,
    strictProvenance: params.strictProvenance ?? false,
  });
}
