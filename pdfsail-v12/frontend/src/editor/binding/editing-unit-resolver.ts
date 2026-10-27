/**
 * editing-unit-resolver.ts — F3B-6.28 · B1：生产 EditingUnit 解析（contract + resolver，未接生产输入）
 *
 * ── 定位（用户 B 阶段裁决 2026-10-12）────────────────────────────────
 *
 *   B1 = 消费 P0 的 `confirmed` 分组（logical-paragraph-contract.ts）与底层
 *   Core 文档，把「真实文档的行」解析成 EditingUnit 实例；`unknown` 维持单行
 *   编辑（fail-closed）。
 *
 *   与 P0-B 的关系（editing-unit-real-fixture.test.ts 冻结的边界演进）：
 *     P0-B：「L5/L6 的聚合由测试**显式声明**；0 自动语义（不猜）」
 *     B1  ：聚合由 **P0 有证据分组**驱动——三态判定 + fail-closed 的保守契约
 *           替代了当年被否决的邻近启发式（25% grouping / 大量 false merge 的
 *           实测针对旧方法；P0 的 unknown-拒绝语义正是对它的回答）。
 *     不变：「0 merge」「paragraphId 现取不硬编码」「unit 是视图/映射层」。
 *
 * ── unitId 持久身份规则（冻结）────────────────────────────────────────
 *
 *   `unit:p{pageIndex}:{成员 paragraphId 升序 "+" 连接}`
 *
 *   · **确定性**：同文档同分组 ⇒ 同 unitId（可从底层来源重推导，不依赖数组
 *     位置 / 临时视觉坐标——用户 B1 要求）。
 *   · **generation 内持久**：paragraphId 每次导入带随机性（实测），跨 session
 *     的 unit 身份本就不可能稳定；本规则保证**同一文档 generation 内**身份
 *     稳定且成员变化 ⇒ 新 id（旧 unit 自然失效）。
 *
 * ── 分组语义（B1 冻结）────────────────────────────────────────────────
 *
 *   · **多行 confirmed 组** ⇒ 产出 EditingUnit（kind="explicit-multi-line"，
 *     沿用 P0-A 两种 kind 之一；生产接入仍受 B4 受控 gate 约束）。
 *   · **单行组** ⇒ **不产 unit**（保持现行单段落编辑路径，逐字节不变）。
 *   · **unknown 边界** ⇒ 拆出的行进 `unconfirmedLineIds`（fail-closed：保持
 *     单行编辑，绝不强制合并）。
 *   · **解析失败**（成员行在 Core 文档中找不到来源 / buildEditingUnit 不变量
 *     失败）⇒ 该组降级：不产 unit，行进 unconfirmedLineIds，failure 记录
 *     reason（可观测，不静默）。
 *
 * ── separators（显式扩展点）────────────────────────────────────────────
 *   本阶段成员行间**直接拼接**（separators=[]）——真实样本 l5+l6 行间无间隙
 *   字符；「行间存在间隙字符」（如段间空格 glyph）的文档需显式扩展，
 *   不得猜测。已知限制如实声明。
 *
 * ── 文本真值 ──────────────────────────────────────────────────────────
 *   unit.lines[].text = **Core 段落文本**（getParagraphText），不是 legacy
 *   glyph 拼接——B1 要求文本/身份/映射一致；feature.text（legacy 拼接）仅
 *   用于 P0 分组，不进入 unit。
 */

import {
  buildEditingUnit,
  type EditingUnit,
} from "./editing-unit";
import {
  groupLogicalParagraphs,
  type LogicalLineFeature,
  type LogicalParagraphGroup,
} from "./logical-paragraph-contract";
import type { EditorDocument } from "../core/document/types";
import { getParagraphText } from "../core/document/query";
import {
  resolveParagraphIdForLine,
  type LineIdentityLedger,
} from "./core-segment-text-projection";

/** 成员行在 Core 文档中的身份与文本真值 */
export interface UnitMemberSource {
  readonly lineId: string;
  readonly textBoxId: string;
  readonly paragraphId: string;
  /** Core 段落全文（文本真值） */
  readonly text: string;
}

/** 在 Core 文档中按 run provenance（source.lineId）定位成员行 */
export function findTextBoxBySourceLineId(
  doc: EditorDocument,
  lineId: string,
): UnitMemberSource | null {
  for (const page of doc.pages ?? []) {
    for (const obj of page.objects ?? []) {
      if (obj.type !== "text") continue;
      for (const p of obj.paragraphs ?? []) {
        for (const r of p.runs ?? []) {
          if (r.source?.lineId === lineId) {
            return {
              lineId,
              textBoxId: obj.id,
              paragraphId: p.id,
              text: getParagraphText(p),
            };
          }
        }
      }
    }
  }
  return null;
}

/**
 * SPEC v2.1 C3 第二跳：按 paragraphId 定位 TextBox（ledger 命中后使用）。
 * 段落不存在 ⇒ null；`text` = Core 段落全文（整 run 删除后的空段落 ⇒ `""`）。
 */
export function findTextBoxByParagraphId(
  doc: EditorDocument,
  paragraphId: string,
): { textBoxId: string; paragraphId: string; text: string } | null {
  for (const page of doc.pages ?? []) {
    for (const obj of page.objects ?? []) {
      if (obj.type !== "text") continue;
      for (const p of obj.paragraphs ?? []) {
        if (p.id !== paragraphId) continue;
        return { textBoxId: obj.id, paragraphId: p.id, text: getParagraphText(p) };
      }
    }
  }
  return null;
}

/** unitId 持久身份派生（确定性；generation 内持久；成员变化 ⇒ 新 id） */
export function deriveUnitId(pageIndex: number, paragraphIds: readonly string[]): string {
  return `unit:p${pageIndex}:${[...paragraphIds].sort().join("+")}`;
}

export interface EditingUnitResolution {
  /** 多行 confirmed 组解析出的单元（可跨 TextBox 编辑的范围） */
  readonly units: readonly EditingUnit[];
  /** 单行组数量（保持现行单段落编辑路径，不产 unit） */
  readonly singleLineGroupCount: number;
  /** fail-closed：这些行保持单行编辑（unknown 拆分 / 解析失败降级） */
  readonly unconfirmedLineIds: readonly string[];
  /** 解析失败记录（可观测，不静默） */
  readonly failures: readonly UnitResolutionFailure[];
}

export interface UnitResolutionFailure {
  readonly lineIds: readonly string[];
  readonly reason: "source-not-found" | "build-failed";
  readonly detail: string;
}

/**
 * 把文档行特征解析为 EditingUnit（B1 主入口）。
 *
 * ⚠️ `features` 必须来自同一文档同一 generation；coreDoc 与 features 必须同源
 * （调用方契约——成员行定位依赖 run.source 与导入身份一致）。
 *
 * @param ledger           可选 identity ledger（SPEC v2.1 N2；缺省 ⇒ 行为与 B1 逐字节一致）
 * @param currentGeneration 可选文档 generation（ledger 域校验键；缺省 ⇒ 不做 fallback）
 */
export function resolveEditingUnits(
  features: readonly LogicalLineFeature[],
  coreDoc: EditorDocument,
  ledger?: LineIdentityLedger | null,
  currentGeneration?: number,
): EditingUnitResolution {
  const groups: readonly LogicalParagraphGroup[] = groupLogicalParagraphs(features);
  const units: EditingUnit[] = [];
  const unconfirmed: string[] = [];
  const failures: UnitResolutionFailure[] = [];
  let singleLineGroupCount = 0;

  for (const g of groups) {
    // 单行组：保持现行单段落路径（不产 unit——unit 只为跨 TextBox 范围存在）。
    // unknown 拆分的单行（separatedFromPrev=unknown）同样单行编辑，但**可观测**：
    // 进 unconfirmedLineIds（调用方知道这里本可能合并但证据不足）。
    if (g.lines.length === 1) {
      singleLineGroupCount++;
      if (g.separatedFromPrev?.verdict === "unknown") unconfirmed.push(g.lines[0]!.lineId);
      continue;
    }
    // 多行 confirmed 组才解析（unknown 组不可能多行——P0 语义：unknown 拆单行）。
    // ★ 多行 confirmed 组**不**进 unconfirmed——即使它与前组之间是 unknown 拆分
    //   （separatedFromPrev），组本身已确认可编辑（实测教训：l5+l6 组的
    //   separatedFromPrev=unknown，但 l5 属于可编辑 unit，推入 unconfirmed 会误导）。
    if (!g.confirmed) {
      for (const l of g.lines) unconfirmed.push(l.lineId);
      continue;
    }

    // 成员定位（run provenance；SPEC v2.1 C3：miss ⇒ 统一解析入口含 ledger fallback）
    const members: UnitMemberSource[] = [];
    const missing: string[] = [];
    const recoverMisses: string[] = [];
    for (const f of g.lines) {
      const found = findTextBoxBySourceLineId(coreDoc, f.lineId);
      if (found) {
        members.push(found);
        continue;
      }
      // ★ SPEC v2.1 C3：provenance 缺失 ⇒ resolveParagraphIdForLine。
      //   歧义立即失败（ledger 不介入）；仅 not-found 查 ledger（hint）；
      //   命中 ⇒ 按 paragraphId 定位 TextBox，lineId 用**原 binding id**（不合成）。
      const resolved =
        ledger && typeof currentGeneration === "number"
          ? resolveParagraphIdForLine(coreDoc, f.lineId, ledger, currentGeneration)
          : null;
      if (resolved?.ok) {
        const box = findTextBoxByParagraphId(coreDoc, resolved.paragraphId);
        if (box) {
          members.push({
            lineId: f.lineId,
            textBoxId: box.textBoxId,
            paragraphId: box.paragraphId,
            text: box.text, // Core 段落全文（整 run 删除后的空段落 ⇒ ""）
          });
          continue;
        }
        recoverMisses.push(`${f.lineId}=>textbox-miss`);
      } else if (resolved) {
        recoverMisses.push(`${f.lineId}=>${resolved.reason}`);
      }
      missing.push(f.lineId);
    }
    if (missing.length > 0 || members.length === 0) {
      failures.push({
        lineIds: g.lines.map((l) => l.lineId),
        reason: "source-not-found",
        detail:
          `成员行在 Core 文档中无 run.source 匹配: ${missing.join(", ") || "(全部)"}` +
          (recoverMisses.length > 0 ? `（ledger 未恢复: ${recoverMisses.join("; ")}）` : ""),
      });
      for (const l of g.lines) unconfirmed.push(l.lineId);
      continue;
    }

    const paragraphIds = members.map((m) => m.paragraphId);
    const unitId = deriveUnitId(g.lines[0]!.pageIndex, paragraphIds);
    const built = buildEditingUnit({
      unitId,
      blockId: g.lines[0]!.blockId,
      kind: "explicit-multi-line",
      lines: members.map((m) => ({
        lineId: m.lineId,
        textBoxId: m.textBoxId,
        paragraphId: m.paragraphId,
        text: m.text,
      })),
      // ★ separator = "\n"（synthetic 行分隔，与 P0-F1 注入缺省一致）：
      //   编辑面 pre-wrap 用 \n 表达视觉换行；P0-D1 的 coreProjection 语义保证
      //   \n 不进 Core 文本（「软换行不占 Core offset」），且使「删除换行合并」
      //   可表达（consume separator）。直接拼接（无 \n）无法走 F1 链。
      separators: members.slice(0, -1).map((m) => ({ afterLineId: m.lineId, text: "\n" })),
    });
    if (!built.ok) {
      failures.push({
        lineIds: g.lines.map((l) => l.lineId),
        reason: "build-failed",
        detail: `buildEditingUnit: ${built.reason}`,
      });
      for (const l of g.lines) unconfirmed.push(l.lineId);
      continue;
    }
    units.push(built.unit);
  }

  return { units, singleLineGroupCount, unconfirmedLineIds: unconfirmed, failures };
}
