/**
 * editing-unit-gate.ts — F3B-6.28 · B2/B3：受控 EditingUnit gate（resolver 驱动）
 *
 * ── 职责（用户 B 阶段裁决）────────────────────────────────────────────
 *   把「显式注入 gate」（`__f1EditingUnit`，harness only）替换为 **resolver
 *   驱动的受控 gate**：目标行属于 P0 **confirmed 多行组** 时，产出与注入
 *   兼容的 unit 来源（{unitId, paragraphIds, separator:"\n"}）。
 *
 * ── 受控边界（B4 冻结 → 2026-10-15 用户验收裁决翻转）────────────────────
 *   · gateEnabled 由调用方显式传入（生产受控 flag `window.__unitEditing`，
 *     **缺省 ON**：`!== false`；显式 `=== false` = 紧急回滚单文本框路径）。
 *   · 只回答「目标行是否属于 confirmed 多行组」；单行组 / unknown / 找不到
 *     目标 / 成员定位失败 ⇒ 一律 fail-closed（维持单段落路径）。
 *   · 纯判定：零 DOM / 零 React；Core 依赖经 `locate` 注入（成员行 → paragraphId）。
 *
 * ── 与显式注入的关系 ─────────────────────────────────────────────────
 *   输出形状与 `ExplicitEditingUnit` 兼容（unitId / paragraphIds / separator:"\n"）
 *   ⇒ PDFEditor 的既有 F1 链（explicitUnitSurface → buildEditingUnit → unit
 *   surface → beforeinput unit route）**零结构改动**即可消费。
 */

import {
  groupLogicalParagraphs,
  type LogicalLineFeature,
} from "./logical-paragraph-contract";
import { deriveUnitId } from "./editing-unit-resolver";
// ★ F3B-6.28：表格行识别（等距列判据）⇒ 表格行不参与跨行合并
import { detectTableCells } from "./table-cell-contract";

export interface ControlledUnitSource {
  readonly unitId: string;
  readonly paragraphIds: readonly string[];
  readonly separator: "\n";
}

export type ControlledUnitGateResult =
  | { readonly ok: true; readonly source: ControlledUnitSource }
  | {
      readonly ok: false;
      readonly reason:
        | "gate-off"
        | "target-not-found"
        | "single-line"
        | "unconfirmed"
        | "member-not-found";
    }

/** 成员行定位器（调用方注入：lineId → Core paragraphId；找不到 ⇒ null） */
export type UnitMemberLocator = (lineId: string) => string | null;

/**
 * 受控 gate：目标行是否走 EditingUnit 路径。
 *
 * @param features     文档行特征（同 generation；P0 分组输入）
 * @param targetLineId 触发编辑的行（segment.source.lineId）
 * @param gateEnabled  受控开关（生产 `window.__unitEditing !== false`；缺省 ON）
 * @param locate       成员行 → Core paragraphId（PDFEditor 注入；找不到 ⇒ null）
 */
export function resolveControlledUnitGate(
  features: readonly LogicalLineFeature[],
  targetLineId: string,
  gateEnabled: boolean,
  locate: UnitMemberLocator,
): ControlledUnitGateResult {
  if (!gateEnabled) return { ok: false, reason: "gate-off" };
  const groups = groupLogicalParagraphs(features);
  for (const g of groups) {
    if (!g.lines.some((l) => l.lineId === targetLineId)) continue;
    // 目标行所在组：多行 confirmed ⇒ unit；其余 fail-closed（维持单段落路径）。
    // 单行组区分 reason：unknown 拆分（separatedFromPrev）⇒ "unconfirmed"
    // （可观测：本可能合并但证据不足）；普通单行 ⇒ "single-line"。
    if (g.lines.length < 2) {
      return {
        ok: false,
        reason: g.separatedFromPrev?.verdict === "unknown" ? "unconfirmed" : "single-line",
      };
    }
    if (!g.confirmed) return { ok: false, reason: "unconfirmed" };
    const paragraphIds: string[] = [];
    for (const l of g.lines) {
      const pid = locate(l.lineId);
      if (pid === null) return { ok: false, reason: "member-not-found" };
      paragraphIds.push(pid);
    }
    return {
      ok: true,
      source: {
        unitId: deriveUnitId(g.lines[0]!.pageIndex, paragraphIds),
        paragraphIds,
        separator: "\n",
      },
    };
  }
  return { ok: false, reason: "target-not-found" };
}

/**
 * 从 legacy EditableDocument 收集全页行特征（P0 分组输入）。
 * 纯读取：只遍历 text 块的 lines（防御式，缺字段跳过）。
 */
export function collectLineFeatures(
  legacyDoc: unknown,
  pageIndex = 0,
): LogicalLineFeature[] {
  const out: LogicalLineFeature[] = [];
  // 延迟 import 会破坏纯度断言 ⇒ 用结构化最小类型（EditableLine 形状子集）
  type LineLike = {
    id?: string;
    bbox?: { x?: number; y?: number; height?: number; width?: number };
    style?: { fontName?: string; fontSize?: number };
    glyphs?: readonly {
      char?: string;
      bbox?: { x?: number; y?: number; width?: number; height?: number };
    }[];
  };
  type BlockLike = { id?: string; type?: string; lines?: readonly LineLike[] };
  const pages = (legacyDoc as { pages?: ReadonlyArray<{ blocks?: readonly BlockLike[] }> } | null)?.pages;
  const blocks = pages?.[pageIndex]?.blocks ?? [];
  for (const b of blocks) {
    if (b.type !== "text" || !b.id) continue;
    for (const l of b.lines ?? []) {
      if (!l.id) continue;
      const glyphs = l.glyphs ?? [];
      const text = glyphs.map((g) => g.char ?? "").join("");
      const style = l.style;
      const h = l.bbox?.height;
      const fontSize =
        typeof style?.fontSize === "number" && style.fontSize > 0
          ? style.fontSize
          : typeof h === "number" && h > 0
            ? h
            : 12;
      // ★ F3B-6.28：表格行识别（失败 ⇒ false = 非表格行，方向安全）
      //   ★ 2026-10-23：传入真实行字号 ⇒ 启用列间隙宽度判据（0.6em），
      //     杜绝正文行「、50 ≈ +100 宽度巧合」的等距假阳性（用户缺陷：
      //     段落被误判表格行 ⇒ table-row-not-merged 拆组 ⇒ 编辑面只覆盖单行）。
      let isTableRow = false;
      try {
        isTableRow = detectTableCells(
          glyphs.map((g) => ({
            char: g.char ?? "",
            bbox: g.bbox
              ? { x: g.bbox.x ?? 0, y: g.bbox.y ?? 0, width: g.bbox.width ?? 0, height: g.bbox.height ?? 0 }
              : undefined,
          })),
          { fontSize },
        ).isTableRow;
      } catch {
        isTableRow = false;
      }
      out.push({
        lineId: l.id,
        blockId: b.id,
        pageIndex,
        text,
        x: l.bbox?.x ?? 0,
        y: l.bbox?.y ?? 0,
        fontSize,
        isTableRow,
        // ★ 折断行判定输入（顶格续行规则 7.5）：行盒宽度（bbox.width）
        width: typeof l.bbox?.width === "number" && l.bbox.width > 0 ? l.bbox.width : undefined,
        // ★ 与 lineFeatureFromEditableLine 同口径：fontFamily（CSS 映射）优先，
        //   fontName 为兼容回退。实测 gd-swim fontFamily 全同 ⇒ 字体证据不可区分
        //   ⇒ 相邻判定 unknown（保守漏合并，方向安全；PDF 字体恢复属后续改进）。
        fontName:
          typeof style?.fontFamily === "string" && style.fontFamily
            ? style.fontFamily
            : typeof (style as any)?.fontName === "string" && (style as any).fontName
              ? (style as any).fontName
              : null,
      });
    }
  }
  return out;
}
