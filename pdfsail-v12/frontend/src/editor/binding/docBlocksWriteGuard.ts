/**
 * docBlocks Write Guard — B2 统一原则
 * ───────────────────────────────────────────────────────────────────────
 * 所有 docBlocks authoritative writer 必须证明「我仍然拥有当前这份状态」才能写。
 *
 * 与 ExportSafetyGate 同一架构思想：
 *   Export：当前状态是否安全？          → Safety Gate
 *   Writer：当前 writer 是否仍有权写？   → Write Guard
 *
 * generation 在「换文档」时被 bump（re-import / OCR injection / Page Ops / 新文档加载），
 * 经由唯一的 canonical 实现 `resetCoreDocumentGeneration` 触发。任何挂起的、携带旧世代
 * 的 writer（页面页号映射 / 拖拽几何 / 旧 OCR 直写）在写盘时若发现 generation 已变
 * ⇒ 拒绝写入，让新世代重新派生，避免「旧映射污染新文档」。
 *
 * 本模块是纯函数 + 单一实例计数器（与 imageAssetRegistry / ocrExportBoundsRegistry
 * 同属 per-app 单例；编辑器在应用中常态只有一个实例）。
 */

let docBlocksGeneration = 0;

export function getDocBlocksGeneration(): number {
  return docBlocksGeneration;
}

/** canonical reset：换文档时调用，使所有挂起的旧世代 writer 失效。 */
export function bumpDocBlocksGeneration(): void {
  docBlocksGeneration += 1;
}

/** 整份文档作废（最彻底）时归零——与 `resetDocBlocksGenerationForNewDocument` 语义一致。 */
export function resetDocBlocksGeneration(): void {
  docBlocksGeneration = 0;
}

export interface DocBlocksWriteGuard {
  /** 写操作开始时捕获的 generation。 */
  readonly generation: number;
}

export function captureDocBlocksWriteGuard(): DocBlocksWriteGuard {
  return { generation: docBlocksGeneration };
}

/** 若 generation 已变化 ⇒ 该 writer 持有的状态已不再属于当前文档 ⇒ stale。 */
export function isDocBlocksWriteStale(guard: DocBlocksWriteGuard): boolean {
  return guard.generation !== docBlocksGeneration;
}

/**
 * 在 React functional updater 内使用：stale 时返回原状态（拒绝写入）。
 * 用法：setBlocks((prev) => guardedDocBlocksUpdate(guard, prev, (p) => ...))
 */
export function guardedDocBlocksUpdate<T>(
  guard: DocBlocksWriteGuard,
  prev: T,
  updater: (prev: T) => T
): T {
  if (isDocBlocksWriteStale(guard)) return prev;
  return updater(prev);
}

/**
 * B2-4：seg_block 的 id 必须在 FindReplace / FloatingToolbar / PDFCanvas / Export /
 * rehydrate 之间保持稳定。集中定义，避免各站点各自拼接产生漂移。
 */
export const SEG_BLOCK_PREFIX = "seg_block_";

export function segBlockId(segmentId: string): string {
  return `${SEG_BLOCK_PREFIX}${segmentId}`;
}

/** B2-4：判断一个 block id 是否为 seg_block 镜像（与 segBlockId 同前缀，避免漂移）。 */
export function isSegBlockId(id: string): boolean {
  return id.startsWith(SEG_BLOCK_PREFIX);
}
