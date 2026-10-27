/**
 * editor/binding/render-identity.ts — EDITOR-CORE-011-B
 *
 * Render Identity —— 喂给旧 `GlyphRenderer` 的 `blockId` / `lineId`。
 *
 * ── 语义铁律（011-A 决策 #4）───────────────────────────────────────
 *
 *     blockId / lineId
 *         =  Renderer identity / grouping key
 *         ≠  PDF provenance
 *
 * 旧 `GlyphRenderer` 用它们做：block grouping（`glyph-renderer.tsx:900-909`）、
 * DOM key、`data-sig-block`、`editedLines` 判定、mask 裁剪（`:837-871`）。
 * 它们**不写回 PDF**。因此：
 *
 *   · generated run **可以**用 Core 自己的 id 当 blockId（它是渲染身份）
 *   · 但**绝不**能伪造一个看起来像 PDF blockId 的值
 *
 * ── lineId 命名空间：011-B 正式拍板（决策 #5）──────────────────────
 *
 * 现状存在两套 **不能混用** 的 line id 命名空间：
 *
 *     Core（Layout 派生）   `${paragraphId}#L${lineIndex}`   layout/types.ts:119
 *     Legacy（PDF 侧）      `pdf_${blockId}_l${idx}` / OCR 的 UUID
 *
 * 旧系统的 `editedLines` / `editedLineBoxes` / `EditableTextNode` 全按 **Legacy** id 索引。
 *
 * **决策：A —— 分离 + 显式映射。**
 *   · Core 的 `LineLayout.lineId` **保持不动**（它是 Layout 的派生身份，不因适配旧 renderer 而改名）
 *   · 在 Binding 内显式映射：有 PDF provenance → 用 `source.lineId`（权威 legacy id）
 *   · 没有 → 用 Core id，但**标记** `lineIdNamespace: "core"`，让下游能断言自己拿到的是哪一种
 *
 * **明确不做**：不按公式 `pdf_${blockId}_l${lineIdx}` 凭空拼一个 legacy id。
 * 该公式只对 native 成立（`document/types.ts:142-143` 明确 OCR 用 UUID），
 * 拼出来会与真实 `EditableLine.id` 对不上 → 导出/编辑行匹配静默失效。
 * 需要公式回退时，由调用方**注入** `LegacyLineIdResolver`（012 wiring 提供真实 lookup）。
 *
 * ── 依赖边界 ───────────────────────────────────────────────────────
 * 只 import Editor Core（`../core/*`）。不 import React / DOM / 旧 renderer 实现。
 */

import type { TextBoxObject } from "../core/document";
import type { PdfProvenance } from "./provenance";

// ─────────────────────────────────────────────────────────────────────
//  命名空间
// ─────────────────────────────────────────────────────────────────────

/** Core 的 line id 形态：`${paragraphId}#L${lineIndex}`（layout/types.ts:119） */
export const CORE_LINE_ID_NAMESPACE = "core";
/** Legacy / PDF 侧 line id 形态：`pdf_${blockId}_l${idx}` 或 OCR UUID */
export const PDF_LINE_ID_NAMESPACE = "pdf";

export type LineIdNamespace = typeof CORE_LINE_ID_NAMESPACE | typeof PDF_LINE_ID_NAMESPACE;
export type BlockIdSource = typeof CORE_LINE_ID_NAMESPACE | typeof PDF_LINE_ID_NAMESPACE;

/** 一次渲染身份的解析结果 */
export interface RenderIdentity {
  /** 喂给 `DrawGlyphCommand.blockId`（**渲染分组键**，不是 PDF provenance） */
  blockId: string;
  /** blockId 来自哪一侧：`pdf` = 沿用 PDF block 身份；`core` = Core 自己的 id */
  blockIdSource: BlockIdSource;
  /** 喂给 `DrawGlyphCommand.lineId` */
  lineId: string;
  /** lineId 属于哪个命名空间（下游必须据此决定是否可用于 `editedLines` 匹配） */
  lineIdNamespace: LineIdNamespace;
}

/** 解析输入 */
export interface RenderIdentityInput {
  /** Core TextBox id（generated 的 blockId 回退值） */
  textBoxId: string;
  /** Core Paragraph id */
  paragraphId: string;
  /** Core `LineLayout.lineId`（`${paragraphId}#L${i}`） */
  coreLineId: string;
  /**
   * 该视觉行在**本段落**内的序号（段落折行后的第几条，0-based）。
   *
   * ⚠️ 011-C 已实证：`TextSourceBinding.lineId` 是 **run 级**，
   * 一个 run 跨 2 条视觉行时两行会拿到**同一个** legacy lineId，
   * 而旧 renderer 的 `editedLineBoxes` 是 `Map<lineId, BBox>`（一行一个盒）
   * → 撞 id 会静默错行。**能区分折行的唯一信息就是这个序号**，
   * 因此它必须进入 resolver（012-E 硬要求）。
   */
  visualLineIndex: number;
  /** 该视觉行在**本 TextBox 内**的序号（跨段落连续，便于按块定位 legacy 行表） */
  lineIndexInTextBox: number;
  /** 该行所属 run 的 PDF provenance（来自 `resolvePdfProvenance`，可为 null） */
  provenance: PdfProvenance | null;
}

/** 解析输入（不含 TextBox 级上下文时的便捷形态） */
export interface LegacyLineIdResolverInput {
  provenance: PdfProvenance | null;
  coreLineId: string;
  paragraphId: string;
  textBoxId: string;
  /** 段落内视觉行序号（折行必需） */
  visualLineIndex: number;
  /** TextBox 内视觉行序号（跨段落连续） */
  lineIndexInTextBox: number;
}

/**
 * 注入式 legacy lineId 解析器。
 *
 * 默认实现**只信任 `provenance.lineId`**（权威），不做公式拼接。
 * 012 wiring 可注入真实 lookup（如 legacy `EditableLine` 索引表）。
 * 返回 `undefined` = 无法解析 → 回退 Core 命名空间。
 *
 * 可用信息：`textBoxId` / `paragraphId` / `visualLineIndex` / `lineIndexInTextBox` /
 * `coreLineId` / `provenance`（含 `lineId`、`lineIdx`、glyph 区间）。
 * 若要区分折行，**必须**使用 `visualLineIndex`（见其注释）。
 */
export type LegacyLineIdResolver = (input: LegacyLineIdResolverInput) => string | undefined;

/** 解析选项 */
export interface RenderIdentityOptions {
  legacyLineId?: LegacyLineIdResolver;
}

/** 默认解析器：只认 provenance 里现成的 legacy id，绝不凭空拼 */
export const defaultLegacyLineIdResolver: LegacyLineIdResolver = ({ provenance }) =>
  provenance?.lineId ?? undefined;

// ─────────────────────────────────────────────────────────────────────
//  解析
// ─────────────────────────────────────────────────────────────────────

/**
 * 解析一行 glyph 的渲染身份。
 *
 * blockId 规则：
 *   1. `provenance.blockId`（沿用 PDF block 身份，保持与旧 DOM key 连续）
 *   2. 否则 `textBoxId`（Core 自己的 id —— **渲染身份**，不是伪造的 PDF id）
 *
 * lineId 规则（决策 A）：
 *   1. `legacyLineId(provenance, coreLineId, ...)` → `lineIdNamespace: "pdf"`
 *   2. 否则 `coreLineId` → `lineIdNamespace: "core"`
 */
export function resolveRenderIdentity(
  input: RenderIdentityInput,
  options: RenderIdentityOptions = {}
): RenderIdentity {
  const resolver = options.legacyLineId ?? defaultLegacyLineIdResolver;

  const pdfBlockId = input.provenance?.blockId ?? null;
  const blockId = pdfBlockId ?? input.textBoxId;
  const blockIdSource: BlockIdSource = pdfBlockId ? PDF_LINE_ID_NAMESPACE : CORE_LINE_ID_NAMESPACE;

  const legacyLineId = resolver({
    provenance: input.provenance,
    coreLineId: input.coreLineId,
    paragraphId: input.paragraphId,
    textBoxId: input.textBoxId,
    visualLineIndex: input.visualLineIndex,
    lineIndexInTextBox: input.lineIndexInTextBox,
  });

  if (typeof legacyLineId === "string" && legacyLineId.length > 0) {
    return { blockId, blockIdSource, lineId: legacyLineId, lineIdNamespace: PDF_LINE_ID_NAMESPACE };
  }
  return {
    blockId,
    blockIdSource,
    lineId: input.coreLineId,
    lineIdNamespace: CORE_LINE_ID_NAMESPACE,
  };
}

/** 便捷：直接从 TextBox 取 Core blockId 回退值（generated 用） */
export function coreBlockIdOf(textBox: TextBoxObject): string {
  return textBox.id;
}

// ─────────────────────────────────────────────────────────────────────
//  守卫
// ─────────────────────────────────────────────────────────────────────

/**
 * 检测「命名空间混用」违规：同一份产物里既有 Core lineId 又有 legacy lineId。
 *
 * 为什么危险：`editedLines` / `editedLineBoxes` 是**按 legacy id 建索引**的。
 * 混用会让一部分行匹配得上、一部分匹配不上 → mask 裁剪错行、编辑行错位，
 * 而且是**静默**的（不报错、不崩溃，只是画错）。
 *
 * 返回违规描述列表（空数组 = 干净）。仅供测试 / 012 断言使用。
 */
export function detectLineIdNamespaceMix(identities: readonly RenderIdentity[]): string[] {
  const violations: string[] = [];
  const pdf = identities.filter((i) => i.lineIdNamespace === PDF_LINE_ID_NAMESPACE);
  const core = identities.filter((i) => i.lineIdNamespace === CORE_LINE_ID_NAMESPACE);
  if (pdf.length > 0 && core.length > 0) {
    violations.push(
      `lineId 命名空间混用：pdf=${pdf.length} 条（如 "${pdf[0].lineId}"），core=${core.length} 条（如 "${core[0].lineId}"）`
    );
  }
  for (const identity of identities) {
    // Core 命名空间的值不得看起来像 legacy id（防止"拼出来冒充"）
    if (
      identity.lineIdNamespace === CORE_LINE_ID_NAMESPACE &&
      /^pdf_.*_l\d+$/.test(identity.lineId)
    ) {
      violations.push(`伪造 legacy lineId：${identity.lineId}`);
    }
  }
  return violations;
}
