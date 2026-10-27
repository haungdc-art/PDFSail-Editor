/**
 * ocr-export-bounds.ts — Step 2c-C2-A-Impl：Post-import OCR 的 Export Bounds 第二来源
 *
 * ── 为什么需要第二个来源（C2-A 审计结论）─────────────────────────────
 *
 *   Core export 的 `originalBounds` 目前**只**来自 BindingSidecar（import-time immutable）。
 *   而 `findEditedBlocksMissingOriginalBounds` 对 `kind === "ocr"` 的 run **恒**要求 bounds
 *   （`isModifiedRun = !isPristineNative`，而 `isPristineNative` 要求 kind === "pdf-native"）。
 *
 *   结果：**后注入的 OCR**（Step 2c-C1 Manual OCR）不在 import-time EditableDocument 中
 *   ⇒ Sidecar 无条目 ⇒ `missing-original-bounds` ⇒ Core export fail-closed ⇒ Legacy fallback
 *   ⇒ 导出 PDF 丢失 OCR 文本（C1 实测）。
 *
 * ── 语义：这不是 "bbox fallback" ────────────────────────────────────
 *
 *   ❌ 禁止的 bbox fallback = 拿**编辑后** TextBox 的当前 bbox 冒充原始位置
 *      （会随后续编辑漂移 ⇒ mask 错位 ⇒ 重影）。
 *
 *   ✅ 本 registry 存的是 **OCR detection box** = OCR 时刻从扫描图像区域捕获的
 *      「原始墨迹区域」，与后续文本排版无关。它与 import 期 `ocr-adapter` 写入
 *      `block.originalBounds` 的检测框是**同一语义类**，因此是合法 bounds，不是伪造。
 *
 *   其用途只有一个：导出时用白色矩形 mask 掉该区域的原始扫描墨迹，避免 ghost/overlap。
 *
 * ── 为什么不放进 Core TextBoxObject / Sidecar ───────────────────────
 *
 *   · Core `TextBoxObject` **没有** `originalBounds` 字段（PDF fidelity 不得进 Core，红线）。
 *   · Sidecar 是 import-time immutable artifact，向其写入后注入条目会破坏其契约。
 *   ⇒ 因此本模块是一个**独立、显式命名**的 Binding 侧来源，键 = `ocr_<hash>` blockId。
 *
 * ── 生命周期（用户强制约束）─────────────────────────────────────────
 *
 *   必须与 Sidecar **同一**边界清理：re-import / page structure generation reset /
 *   document replacement 在生产上全部走 `resetCoreDocumentGeneration()`（PDFEditor 唯一实现），
 *   本 registry 的 `clear()` 必须挂在那里。否则 PDF A 的 `ocr_<hash>` 会泄漏到 PDF B
 *   ⇒ stale lookup / 错误 mask（cross-document bleed）。
 *
 * ── 依赖边界 ────────────────────────────────────────────────────────
 *   纯模块：不 import React / DOM / Core document / Sidecar / legacy document / export-renderer。
 */

import type { BBox } from "../../document-model/types";

/** 一条 OCR 检测框（commit-time 捕获，不是运行期推导） */
export interface OcrDetectionBounds {
  /** 确定性 OCR blockId（`ocr_<hash>`），与 Core run.source.blockId 一致 */
  blockId: string;
  /** OCR 检测框 = Canvas Space 的原始墨迹区域（x/y/width/height） */
  bbox: BBox;
  /** 所在页（1-based），用于诊断与未来按页失效 */
  pageIndex?: number;
}

/** registry 不可用 / 未命中的原因（fail-closed 可观测，不改变查询结果） */
export type OcrBoundsUnavailableReason =
  | "not-registered"
  | "cleared";

/** provider 侧只需要这两个能力（避免 provider 依赖 registry 实现细节） */
export interface OcrBoundsSource {
  boundsOf(blockId: string): BBox | undefined;
  explainBoundsOf(blockId: string): OcrBoundsUnavailableReason | null;
}

export interface OcrExportBoundsRegistry extends OcrBoundsSource {
  /** 注册（同 blockId 覆盖 = 幂等重 OCR） */
  register(entries: readonly OcrDetectionBounds[]): void;
  /** 生命周期清理（re-import / generation reset 边界） */
  clear(): void;
  /** 只读快照（测试 / 诊断） */
  size(): number;
  snapshot(): ReadonlyMap<string, OcrDetectionBounds>;
}

function cloneBBox(bbox: BBox): BBox {
  return { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height };
}

/**
 * 建立 OCR export bounds registry。
 *
 * 深拷贝进出：**不**持有调用方对象引用（OCR draft 与 Core document 都可能在注册后被改写，
 * 而检测框语义是 commit-time 快照，必须冻结）。
 */
export function createOcrExportBoundsRegistry(): OcrExportBoundsRegistry {
  const entries = new Map<string, OcrDetectionBounds>();

  return {
    register(list: readonly OcrDetectionBounds[]): void {
      for (const entry of list) {
        if (!entry || typeof entry.blockId !== "string" || entry.blockId.length === 0) continue;
        if (!entry.bbox) continue;
        entries.set(entry.blockId, {
          blockId: entry.blockId,
          bbox: cloneBBox(entry.bbox),
          pageIndex: entry.pageIndex,
        });
      }
    },

    boundsOf(blockId: string): BBox | undefined {
      const hit = entries.get(blockId);
      return hit ? cloneBBox(hit.bbox) : undefined;
    },

    explainBoundsOf(blockId: string): OcrBoundsUnavailableReason | null {
      return entries.has(blockId) ? null : "not-registered";
    },

    clear(): void {
      entries.clear();
    },

    size(): number {
      return entries.size;
    },

    snapshot(): ReadonlyMap<string, OcrDetectionBounds> {
      return new Map(entries);
    },
  };
}

/**
 * 生产单例（与 `imageAssetRegistry` 同模式）。
 *
 * ⚠️ 生命周期责任在调用方：必须在 `resetCoreDocumentGeneration()` 中 clear()。
 */
export const ocrExportBoundsRegistry: OcrExportBoundsRegistry =
  createOcrExportBoundsRegistry();
