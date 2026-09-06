/**
 * Policy — Application Layer 的统一决策接口
 *
 * Sprint36 · TD-002（Immutable Document Mutation）· PR-1 · Commit 3
 *
 * 原则（ADR-002 Step 3.5）：
 *   - Policy 可以依赖 Facts（OCR.label / confidence / overlap / geometry），
 *     不能依赖 Materialized Document（block.regionType / layoutMode / 布局后 bbox）。
 *   - Policy 只产生 Mutation[]，不修改 Document。
 *   - 统一接口后，新增 Policy（SignaturePolicy 等）无需改 Mutation Engine。
 */

import type { LayoutMode, LayoutRegionType } from "../document-model/types";
import type { OcrTextBlock } from "../ocr/ocr-storage";
import { classifyRegion } from "../document-model/region-classifier";
import type { LayoutMutation, Mutation, RegionMutation } from "./mutation";

/** Policy 统一接口：Facts → Mutation[] */
export interface Policy<TFact, TMutation extends Mutation> {
  evaluate(facts: TFact): TMutation[];
}

/** RegionPolicy Facts */
export interface RegionFacts {
  ocr: OcrTextBlock;
  /** 页面总高度（OCR canvas px at scale=1.5，可选，用于页脚判断） */
  pageHeightOcrSpace?: number;
}

/** RegionPolicy — 决定 block 的区域类型（75% overlap 规则归属本 Policy） */
export class RegionPolicy implements Policy<RegionFacts, RegionMutation> {
  evaluate(facts: RegionFacts): RegionMutation[] {
    const regionType = classifyRegion(facts.ocr, facts.pageHeightOcrSpace);
    return [{ kind: "RegionMutation", blockId: facts.ocr.id, regionType }];
  }
}

/** LayoutPolicy Facts */
export interface LayoutFacts {
  ocr: OcrTextBlock;
  regionType: LayoutRegionType;
}

/** LayoutPolicy — 决定 block 的布局策略 */
export class LayoutPolicy implements Policy<LayoutFacts, LayoutMutation> {
  evaluate(facts: LayoutFacts): LayoutMutation[] {
    // paragraph → reconstruct（word wrapping，可重新换行）
    // signature/stamp/table/footer → preserve（禁止 reflow，保持原位置）
    const layoutMode: LayoutMode =
      facts.regionType === "paragraph" ? "reconstruct" : "preserve";
    return [{ kind: "LayoutMutation", blockId: facts.ocr.id, layoutMode }];
  }
}
