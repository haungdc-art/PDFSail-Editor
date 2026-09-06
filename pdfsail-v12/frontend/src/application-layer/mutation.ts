/**
 * Mutation — Application Layer 对 Document 的不可变变更（事实）
 *
 * Sprint36 · TD-002（Immutable Document Mutation）· PR-1 · Commit 1
 *
 * 原则：
 *   - Document 永远只读 Facts。
 *   - Application 不修改 Document，只产生 Mutation[]。
 *   - Mutation Engine 是唯一 Materializer（消费 Mutation 生成 Materialized Document）。
 *
 * Sprint36 仅支持两种 Mutation（RegionMutation + LayoutMutation）。
 * 其它（SignatureMutation / MaskMutation / TableMutation / GeometryMutation）登记 Sprint37。
 *
 * Mutation 是一条"事实"，不是修改指令。
 */

import type { LayoutMode, LayoutRegionType } from "../document-model/types";

/** RegionMutation — 决定 block 的区域类型 */
export interface RegionMutation {
  kind: "RegionMutation";
  blockId: string;
  regionType: LayoutRegionType;
}

/** LayoutMutation — 决定 block 的布局策略 */
export interface LayoutMutation {
  kind: "LayoutMutation";
  blockId: string;
  layoutMode: LayoutMode;
}

/** Mutation — Application 可产生的所有不可变变更（Sprint36 仅两种） */
export type Mutation = RegionMutation | LayoutMutation;
