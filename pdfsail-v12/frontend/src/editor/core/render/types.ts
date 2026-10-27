/**
 * editor/core/render/types.ts — EDITOR-CORE-010-B
 *
 * EditorRenderFrame —— Editor Core 的**渲染派生层**。
 *
 * ── 定位（010-A 审计结论）───────────────────────────────────────────
 * 这不是新的 Document / Selection / Layout 模型，而是 **paint-only 派生数据**：
 * 把 Layout 的几何与 Document 的字符/样式 join 成渲染方真正需要的东西。
 *
 * 为什么必须 join：
 *   · `GlyphLayout`（layout/types.ts）按 ADR-006 刻意**不含** char / style，
 *     只持 `runId` + 几何；
 *   · `TextRun`（document/types.ts）只有 `text` + `style`，**不知道自己的位置**。
 *   二者单独都不能渲染，join 是任何 renderer 都躲不开的一步。
 *
 * ── 与旧 renderer 栈的关系（010-A 已定，本阶段不跨界）──────────────
 * 本层**不**产出旧 renderer 的 RenderObject：
 *   · `GlyphObject.coverage` 是必填，而 Editor Core 没有 coverage 概念
 *     （mask / patch 的 ownership 属 PDF Binding）→ 硬填即伪造绘制数据；
 *   · 给 `RenderObject` union 加成员会在 strict 下打断穷尽 switch 的 `paintObject`。
 * 到旧 renderer 的桥接**故意留到 CORE-011+**（见 docs/editor-core-010a-renderer-audit.md）。
 *
 * ── 坐标系 ─────────────────────────────────────────────────────────
 * 全部沿用 Page Canvas Space（左上原点、y 向下、px，规范 §19），
 * 与 `TextLayout` / `GlyphLayout` 完全一致，本层**不做任何坐标变换**。
 *
 * ── 偏移语义（规范 §9）─────────────────────────────────────────────
 * `textIndex` / `textLength` 一律是 **UTF-16 code unit**，
 * 与 `GlyphLayout.textIndex` 的参照系相同（见下方 EditorGlyphBox 注释）。
 * glyph 索引**不得**进入本层（规范 §10 / 架构地图 V7）：
 * 需要 PDF provenance 时一律沿 `runId → TextRun.source` 追溯。
 */

import type { TextStyle } from "../document/types";
import type { AdvanceSource, CaretGeometry, Rect, SelectionGeometry } from "../layout/types";

// ─────────────────────────────────────────────────────────────────────
//  警告码（稳定前缀，便于上层判定；规范 §65 不静默降级）
// ─────────────────────────────────────────────────────────────────────

/** 传入的 layout 不是针对当前 document.version 算出的（框架不做缓存，只报告） */
export const FRAME_WARNING_STALE_LAYOUT = "stale-layout";
/** layout.textBoxId 在文档中找不到 */
export const FRAME_WARNING_MISSING_TEXT_BOX = "missing-text-box";
/** layout 引用的 paragraphId 在文档中找不到 */
export const FRAME_WARNING_MISSING_PARAGRAPH = "missing-paragraph";
/** layout 引用的 runId 在该 paragraph 中找不到 */
export const FRAME_WARNING_MISSING_RUN = "missing-run";
/** layout 的 glyph 区间与文档文本对不上（长度/边界不一致） */
export const FRAME_WARNING_GLYPH_TEXT_MISMATCH = "glyph-text-mismatch";
/** 传入的 caret 不属于本 frame 的 TextBox */
export const FRAME_WARNING_CARET_TEXT_BOX_MISMATCH = "caret-text-box-mismatch";

// ─────────────────────────────────────────────────────────────────────
//  EditorGlyphBox
// ─────────────────────────────────────────────────────────────────────

/**
 * 一个可绘制字符 = Layout 的几何 + Document 的字符/样式。
 *
 * **纯派生**：所有字段都是复制引用或复制值，不产生第二份真相；
 * 本对象**不拥有**任何状态（frame 是只读快照）。
 */
export interface EditorGlyphBox {
  /** 引用 EditorDocument.TextRun.id（provenance 追溯起点） */
  runId: string;
  /** 引用 EditorDocument.Paragraph.id */
  paragraphId: string;
  /** 该字符（代理对为 2 个 UTF-16 单元，绝不从中间切开） */
  char: string;
  /**
   * 该字符在其**段落文本**中的 UTF-16 起点。
   *
   * ⚠️ 参照系 = **段落**（与 `GlyphLayout.textIndex` 完全一致，直接继承）。
   *    不是 run 内偏移，也不是文档全局偏移 —— 同一段落内多 run 时，
   *    各 run 的 textIndex 落在同一个段落坐标系里连续递增。
   *
   * 规范 §9：一律 UTF-16 code unit，禁止改成 code point / glyph 索引。
   */
  textIndex: number;
  /** 该字符的 UTF-16 长度（BMP = 1，代理对 = 2） */
  textLength: number;
  /** Layout 算出的字符盒（**直接引用**，本层不重新测量） */
  box: Rect;
  /** 含 letterSpacing 的实际推进量（px），来自 GlyphLayout */
  advance: number;
  /** 绝对基线 Y（Page Canvas Space） */
  baseline: number;
  /** 所属 run 的样式（**直接引用** `TextRun.style`，不复制、不合并） */
  style: TextStyle;
  /** 该 advance 的度量来源（§18 证据链，逐项传递、不重新推断） */
  advanceSource: AdvanceSource;
}

// ─────────────────────────────────────────────────────────────────────
//  EditorRenderFrame
// ─────────────────────────────────────────────────────────────────────

/**
 * 一次渲染所需的全部派生数据（单个 TextBox）。
 *
 * 注意本类型**刻意不含**：
 *   · coverage / mask / patch（PDF Binding 语义，Core 不拥有）
 *   · glyphIndex / startGlyphIndex / endGlyphIndex（规范 §10）
 *   · sourceBlockId / sourceLineId 等 provenance 副本（沿 runId 追溯即可）
 */
export interface EditorRenderFrame {
  /** 本 frame 对应的 TextBox */
  textBoxId: string;
  /**
   * 生成本 frame 时的 **document.version**（Document 是权威）。
   *
   * 这不是装饰字段：`EditorDocument.version → TextLayout.documentVersion →
   * EditorRenderFrame.documentVersion` 是后续 stale-frame 判定的基础契约。
   * 010-B 只保存，**不建立缓存 / 失效引擎**。
   */
  documentVersion: number;
  /** 按 layout 遍历顺序排列的字符（段落 → 行 → run → glyph） */
  glyphs: readonly EditorGlyphBox[];
  /** 插入光标几何；**直接是 006-B 的对象**（同一引用，未克隆未重算） */
  caret: CaretGeometry | null;
  /** 选区几何（每视觉行一个 quad）；**直接是 006-B 的对象** */
  selection: SelectionGeometry | null;
  /** 诊断信息（缺失引用 / 陈旧 layout / 文本不一致等，去重后按序） */
  warnings: readonly string[];
}

/** `buildRenderFrame` 的可选几何（均来自 006-B，本层不改写） */
export interface BuildRenderFrameOptions {
  caret?: CaretGeometry | null;
  selection?: SelectionGeometry | null;
}
