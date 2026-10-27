/**
 * F3B-6.17 3B'-B.1 — BindingSidecar Core Export Bounds Provider
 *
 * 路径：
 *
 *     BindingSidecar
 *           ↓
 *     Core Export Bounds Provider        ← 本模块（纯查询，无副作用）
 *           ↓
 *     build-core-export-context
 *
 * ── 语义（3B'-B.1 冻结）────────────────────────────────────────────
 *
 *   blockOriginalBoundsDetected === true
 *     → 返回真实 originalBounds（import-time 检测框）
 *
 *   blockOriginalBoundsDetected === false / 字段缺失
 *     → **不把 bbox 冒充 originalBounds**，返回 undefined
 *     → 交由 eligibility / export fail-closed
 *
 *   Sidecar block missing        → fail-closed（undefined）
 *   pages[pageIndex] 缺失        → fail-closed（undefined）
 *   pages[pageIndex].originYPt === undefined → fail-closed（undefined）
 *
 * ── 绝对禁止（3B' 目的所在）───────────────────────────────────────
 *
 *   ❌ Sidecar miss                → Legacy EditableDocument
 *   ❌ pageTopPt miss              → Legacy originYPt
 *   ❌ originalBounds miss         → Legacy block / TextBox bbox / RenderFrame bbox
 *   ❌ 任何「近似」「兜底」「取 0」的伪造
 *
 * 本模块**不 import** 任何 legacy document 类型，从结构上杜绝回退（见同目录 source guard 测试）。
 */

import type { BBox } from "../../document-model/types";
import type { BindingSidecar } from "./binding-sidecar";
import { lookupBlockBinding } from "./binding-sidecar";
// Step 2c-C2-A-Impl：post-import OCR 的第二 bounds 来源（Sidecar miss 后咨询，绝不 bbox fallback）
import {
  ocrExportBoundsRegistry,
  type OcrBoundsSource,
} from "./ocr-export-bounds";

/** 该 provider 的唯一合法数据来源标识 */
export const CORE_EXPORT_BOUNDS_PROVIDER_SOURCE = "binding-sidecar" as const;

/** provider 不可用的原因（fail-closed 时可观测） */
export type CoreExportBoundsUnavailableReason =
  | "sidecar-missing"
  | "block-missing"
  | "bounds-not-detected"
  | "page-missing"
  | "page-origin-undefined";

/** bounds 的实际来源（Step 2c-C2-A-Impl：让「谁提供了 bounds」可观测） */
export type CoreExportBoundsSource = "sidecar" | "ocr" | "unavailable";

export interface CoreExportBoundsProvider {
  /** 恒定 `"binding-sidecar"` —— 用于 source guard / 诊断 */
  readonly source: typeof CORE_EXPORT_BOUNDS_PROVIDER_SOURCE;
  /** sidecar 是否存在（false ⇒ 所有查询 fail-closed） */
  isAvailable(): boolean;
  /** 真实 PDF 检测框；不可用 → `undefined`（绝不返回 bbox 回退值） */
  originalBoundsOf(blockId: string): BBox | undefined;
  /** page-level PDF MediaBox y0（pt）；不可用 → `undefined`（绝不返回 0） */
  pageTopPt(pageIndex: number): number | undefined;
  /** 诊断：为何该 block 的 bounds 不可用（不改变查询结果） */
  explainOriginalBoundsOf(blockId: string): CoreExportBoundsUnavailableReason | null;
  /** 诊断：为何该页 originYPt 不可用（不改变查询结果） */
  explainPageTopPt(pageIndex: number): CoreExportBoundsUnavailableReason | null;
  /** 诊断：该 blockId 的 bounds 实际由哪个来源提供（sidecar 优先，其次 ocr） */
  boundsSourceOf(blockId: string): CoreExportBoundsSource;
}

function cloneBBox(bbox: BBox): BBox {
  return { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height };
}

/** 全部查询 fail-closed 的空 provider（sidecar 缺失时使用） */
export function createUnavailableCoreExportBoundsProvider(): CoreExportBoundsProvider {
  return {
    source: CORE_EXPORT_BOUNDS_PROVIDER_SOURCE,
    isAvailable: () => false,
    originalBoundsOf: () => undefined,
    pageTopPt: () => undefined,
    explainOriginalBoundsOf: () => "sidecar-missing",
    explainPageTopPt: () => "sidecar-missing",
    // sidecar 缺失 ⇒ 整体不可用（post-import OCR 也不咨询：无 sidecar 即无 live document generation）
    boundsSourceOf: () => "unavailable",
  };
}

/**
 * 从 BindingSidecar 建立 bounds provider。
 *
 * 纯查询：不缓存可变量、不写 sidecar、不读任何 legacy 对象。
 *
 * ★ Step 2c-C2-A-Impl：lookup 顺序确定为
 *
 *     Sidecar（import-time detected） → OCR detection bounds（post-import） → undefined
 *
 *   **绝不存在**第三级 `current TextBox bbox` fallback —— 那会打穿 fail-closed 契约。
 */
export function createCoreExportBoundsProvider(
  sidecar: BindingSidecar | null | undefined,
  ocrBounds: OcrBoundsSource = ocrExportBoundsRegistry
): CoreExportBoundsProvider {
  if (!sidecar) return createUnavailableCoreExportBoundsProvider();

  /** Sidecar 命中检测框（三态语义：仅 detected===true） */
  const sidecarBoundsOf = (blockId: string): BBox | undefined => {
    const binding = lookupBlockBinding(sidecar, blockId);
    if (!binding) return undefined;
    if (binding.blockOriginalBoundsDetected !== true) return undefined;
    if (!binding.blockOriginalBounds) return undefined;
    return cloneBBox(binding.blockOriginalBounds);
  };

  const explainOriginalBoundsOf = (
    blockId: string
  ): CoreExportBoundsUnavailableReason | null => {
    // Sidecar 命中 ⇒ 可用（null）
    if (sidecarBoundsOf(blockId)) return null;
    // Sidecar miss ⇒ 咨询 post-import OCR detection bounds
    if (ocrBounds && ocrBounds.boundsOf(blockId)) return null;
    // 两者都 miss ⇒ 报告 Sidecar 侧原因（保留既有诊断语义）
    const binding = lookupBlockBinding(sidecar, blockId);
    if (!binding) return "block-missing";
    if (binding.blockOriginalBoundsDetected !== true) return "bounds-not-detected";
    if (!binding.blockOriginalBounds) return "bounds-not-detected";
    return null;
  };

  const explainPageTopPt = (
    pageIndex: number
  ): CoreExportBoundsUnavailableReason | null => {
    const page = sidecar.pages?.[pageIndex];
    if (!page) return "page-missing";
    if (page.originYPt === undefined) return "page-origin-undefined";
    if (!Number.isFinite(page.originYPt)) return "page-origin-undefined";
    return null;
  };

  return {
    source: CORE_EXPORT_BOUNDS_PROVIDER_SOURCE,
    isAvailable: () => true,

    originalBoundsOf(blockId: string): BBox | undefined {
      // ① Sidecar（import-time 检测框，detected===true 才算）
      const fromSidecar = sidecarBoundsOf(blockId);
      if (fromSidecar) return fromSidecar;
      // ② post-import OCR detection box（commit-time 快照）
      if (ocrBounds) {
        const fromOcr = ocrBounds.boundsOf(blockId);
        if (fromOcr) return cloneBBox(fromOcr);
      }
      // ③ fail-closed —— 绝无第三级（current TextBox bbox）fallback
      return undefined;
    },

    boundsSourceOf(blockId: string): CoreExportBoundsSource {
      if (sidecarBoundsOf(blockId)) return "sidecar";
      if (ocrBounds && ocrBounds.boundsOf(blockId)) return "ocr";
      return "unavailable";
    },

    pageTopPt(pageIndex: number): number | undefined {
      // 缺失一律 undefined —— **绝不退化为 0**（0 是合法 y0，不可与"缺失"混淆）。
      const page = sidecar.pages?.[pageIndex];
      if (!page) return undefined;
      if (page.originYPt === undefined) return undefined;
      if (!Number.isFinite(page.originYPt)) return undefined;
      return page.originYPt;
    },

    explainOriginalBoundsOf,
    explainPageTopPt,
  };
}
