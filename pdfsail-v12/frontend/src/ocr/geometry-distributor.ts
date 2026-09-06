/**
 * geometry-distributor.ts — Geometry Distributor（Sprint-1 MVP）
 *
 * ADR-006：Fact Distribution Stage。
 * 职责：把 Parent Geometry 重新分配（Redistribute）到 Child Geometry。
 *   - 是 Fact Redistributor，不是 Fact Producer。
 *   - 只能写 Child Geometry，Parent Geometry 永远只读。
 *   - 不能产生新的视觉事实（不 Run Analyzer / OCR）。
 *
 * Sprint-1 Commit 1：只建立 Stage，0 业务逻辑。
 * Sprint-1 Commit 3：迁移 Ownership（Normalizer 的 geometry 复制迁到这里）。
 *
 * 注：当前是空壳，业务逻辑在后续 Commit 填充。
 */

import type { OcrTextBlock } from "./ocr-storage";

/**
 * Distributor 输入：Parent 与 Child 的关联（一组 Parent → 多个 Child）。
 */
export interface GeometryDistributorInput {
  /** normalize 之前的 Parent block（含 Parent Geometry）*/
  parentBlocks: OcrTextBlock[];
  /** normalize 之后的 Child block（结构）*/
  childBlocks: OcrTextBlock[];
}

/**
 * 重新分配 Child Geometry（Sprint-1 Commit 3：Ownership 迁移）。
 *
 * ADR-006：Fact Redistributor。
 *   - 只写 Child Geometry，Parent Geometry 永远只读。
 *   - 不产生新 Fact，不 Run Analyzer / OCR。
 *
 * 当前实现（MVP，行为与 Normalizer 一致）：
 *   把 Parent Geometry 复制到每个 Child（继承）。
 *   —— 这是迁移前 Normalizer 的原有行为，此处保持等价，
 *      后续 Story 再细化"哪些 Child 继承"的规则。
 *
 * @param input Distributor 输入
 * @returns 处理后的 Child blocks（Geometry 已分配）
 */
export function distributeGeometry(input: GeometryDistributorInput): OcrTextBlock[] {
  // ADR-006 Forbidden：不修改 Parent Geometry（只读）。
  // 把 Parent Geometry 分配给 Child（Ownership 迁移：Distributor 成为唯一 Child Geometry Owner）。
  const parentById = new Map<string, OcrTextBlock>(
    input.parentBlocks.map(p => [p.id, p])
  );

  for (const child of input.childBlocks) {
    // 找到 child 的 parent（通过 _parentBlockId，由 Normalizer 记录）
    const parentId = (child as any)._parentBlockId as string | undefined;
    const parent = parentId ? parentById.get(parentId) : undefined;
    if (parent?.geometry) {
      child.geometry = parent.geometry;
    }
  }

  return input.childBlocks;
}
