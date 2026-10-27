/**
 * editor/binding/render-command-bridge.ts — EDITOR-CORE-011-B
 *
 * EditorRenderFrame  →  { commands: RenderCommand[]; styles: EditableStyle[] }
 *
 * ── 唯一职责：翻译 ──────────────────────────────────────────────────
 *     EditorRenderFrame（010-B：char + style + 已算定的几何）
 *              ↓  纯映射（不测量、不布局）
 *     RenderCommand[] + EditableStyle[]（旧 GlyphRenderer 的输入）
 *
 * **Binding 只能翻译，不能 Layout。**
 * 本文件不出现：`measureText` / canvas / 任何度量提供者 / 任何几何推导。
 * `x / y / width / height` 逐字段来自 `EditorGlyphBox.box`，一个像素都不重算。
 *
 * ── ⚠️ 硬契约 1：绝不输出 `baseline` ────────────────────────────────
 * 011-A 已实证：`GlyphRenderer` 一旦拿到 `cmd.baseline`，就会
 *
 *     spanTop = cmd.baseline - canvas.measureText("M").actualBoundingBoxAscent
 *
 * 即**用自己的 canvas 重新测 ascent，并完全丢弃 `cmd.y` / `cmd.height`**
 * （`glyph-renderer.tsx:1112-1128`，另有两处等价 copy）。
 *
 * 不输出 `baseline` 时，renderer 走 else 分支 `spanTop = cmd.y`，
 * 于是 Core 在 Layout 阶段一次算定的几何被逐字尊重。
 *
 * → 这是**有意省略**，不是"忘了"。测试显式断言 `command.baseline === undefined`，
 *   并附一条反向断言证明 baseline 分支确实会引发重测。
 *
 * ── 硬契约 2：styleRef 只由 runId 决定 ─────────────────────────────
 *     TextRun.id  →  styleRef         ✅
 *     glyph index / paragraph index / line index / 对象顺序  →  styleRef   ❌
 *
 * 规则：
 *   · 同一 `TextRun.id` → 同一 `styleRef`（跨调用、跨 chunk 稳定）
 *   · 不同 run **即使样式完全相同也不共享 ref**（ref 绑 run 身份，不绑样式内容）
 *   · 每个 glyph 不创建 style
 *   · ref 按 glyph 顺序首次出现分配 → 同一 Frame 重建两次结果完全一致
 * 理由：旧 renderer 的 `selectedGlyphIds` 用 `${blockId}__${lineId}__${i}` 做 id
 * （`glyph-renderer.tsx:1287/1439`，依赖数组下标），style 抖动会连带 DOM key 抖动。
 *
 * ── 硬契约 3：不产出 mask / patch / coverage ───────────────────────
 * `RenderCommand` 里 production 还会有 `drawLine{mask}` / `drawRect` / `drawImage`。
 * 那些几何来自 **PDF Binding**（`EditableBlock.originalBounds` + coverage），
 * **不在 frame 里、也不该由本桥接造**（010-A/011-A 的 ownership 决策）。
 * → 本函数只产出 **glyph 命令**；012 把 Binding 侧的非 glyph 命令与它们合并。
 *
 * ── 依赖边界 ───────────────────────────────────────────────────────
 * 允许 import：Editor Core `../core/*`、旧 DTO `../../document-model/render-command` + `/types`。
 * 禁止 import：React / DOM / `editor-engine` / 旧 renderer 实现 / `render-object` / `render-context` / painter。
 */

import type { EditorDocument, TextStyle } from "../core/document";
import type { EditorGlyphBox, EditorRenderFrame } from "../core/render";
import type { TextLayout } from "../core/layout";
import type { DrawGlyphCommand, RenderCommand } from "../../document-model/render-command";
import type { EditableStyle, TransformMatrix } from "../../document-model/types";
import {
  detectLineIdNamespaceMix,
  resolveRenderIdentity,
  type LegacyLineIdResolver,
  type RenderIdentity,
} from "./render-identity";
import { isModifiedRun, resolvePdfProvenance, type PdfProvenance } from "./provenance";

// ─────────────────────────────────────────────────────────────────────
//  警告码（稳定前缀；规范 §65 不静默降级）
// ─────────────────────────────────────────────────────────────────────

export const BRIDGE_WARNING_INVALID_BOX = "glyph-invalid-box";
export const BRIDGE_WARNING_UNKNOWN_RUN = "glyph-unknown-line";
export const BRIDGE_WARNING_DUPLICATE_KEY = "glyph-duplicate-key";
export const BRIDGE_WARNING_IDENTITY_MIX = "line-id-namespace-mix";
export const BRIDGE_WARNING_DUPLICATE_LEGACY_LINE_ID = "duplicate-legacy-line-id";

// ─────────────────────────────────────────────────────────────────────
//  选项
// ─────────────────────────────────────────────────────────────────────

/**
 * 字体身份提供者 —— **Binding 独占**的字段。
 *
 * Core `TextStyle` **没有**（也不应该有）`pdfjsFontFamily` / `fontId`：
 *   · `pdfjsFontFamily` 是 PDF.js 注入的 `@font-face` 名（如 `g_d0_f1`），来自浏览器运行时
 *   · `fontId` 是跨页/跨文档的 PDF 字体身份
 * 只有 `sourceFontName`（如 `ABCDEF+Helvetica`）是 Core 合法持有的 provenance，
 * 由本桥接映射到 `EditableStyle.pdfFontName`。
 */
export interface FontIdentityProvider {
  /** PDF.js `@font-face` 名（GlyphRenderer 优先消费此字段） */
  pdfjsFontFamilyOf?: (runId: string, style: TextStyle) => string | undefined;
  /** 跨文档稳定字体标识 */
  fontIdOf?: (runId: string, style: TextStyle) => string | undefined;
  /** 覆盖 `pdfFontName`（缺省用 Core 的 `TextStyle.sourceFontName`） */
  pdfFontNameOf?: (runId: string, style: TextStyle) => string | undefined;
  /** 字体是否已加载（@font-face 就绪），避免 fallback 闪烁 */
  fontLoadedOf?: (runId: string) => boolean | undefined;
}

/** 桥接选项 */
export interface RenderCommandBridgeOptions {
  /** legacy lineId 解析器（缺省只认 provenance，不拼公式；决策见 render-identity.ts） */
  legacyLineId?: LegacyLineIdResolver;
  /** CSS 归一化 transform 提供者（Core 无 matrix；缺省不输出 transform） */
  transformOf?: (glyph: EditorGlyphBox, provenance: PdfProvenance | null) => TransformMatrix | undefined;
  /** Binding 独占的字体身份 */
  fontIdentity?: FontIdentityProvider;
}

/** 桥接结果 */
export interface RenderCommandBridgeResult {
  /** **只含 glyph 命令**（mask/rect/image 由 Binding 侧另行提供并合并） */
  commands: RenderCommand[];
  /** 文档级样式表（`styleRef` 指向此数组下标） */
  styles: EditableStyle[];
  /** runId → styleRef（供 012 断言稳定性 / 复用） */
  styleRefByRunId: ReadonlyMap<string, number>;
  /** 与 `commands` **同序**的渲染身份（供 012 做 mask 裁剪 / 编辑行匹配） */
  identities: readonly RenderIdentity[];
  /** 诊断（已去重、按首次出现排序） */
  warnings: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────
//  主入口
// ─────────────────────────────────────────────────────────────────────

/**
 * 把一帧渲染数据翻译成旧 renderer 的输入。
 *
 * 纯函数：不修改 `document` / `layout` / `frame`；输出全部是新对象。
 * 需要 `layout` 的唯一原因是：frame 的 glyph **不带行归属**，
 * 而 `DrawGlyphCommand.lineId` 必须按行给出（用 `LineLayout.lineId` / provenance，不重算几何）。
 *
 * @param document 文档权威（provenance / run 身份）
 * @param layout   该 TextBox 的布局（用于 glyph → line 归属，只读）
 * @param frame    010-B 的可绘制帧（几何 + 字符 + 样式）
 */
export function buildRenderCommands(
  document: EditorDocument,
  layout: TextLayout,
  frame: EditorRenderFrame,
  options: RenderCommandBridgeOptions = {}
): RenderCommandBridgeResult {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const warn = (message: string): void => {
    if (seen.has(message)) return;
    seen.add(message);
    warnings.push(message);
  };

  const lineIndexOf = buildGlyphLineIndex(layout, warn);

  // ── Step 2b：layout line 级 PDF 身份（供 generated run 继承）─────────────
  // Core layout 的 `LineLayout.lineId` 只是**合成 ID**（reflow.ts: `${paragraph.id}#L${n}`），
  // 真实 PDF 身份只能来自 run 的 provenance。generated run 按 Core 规则
  // （GENERATED_SOURCE）**不带** provenance，因此其 glyph 会拿到合成身份 ⇒ 无法归属原行
  // （mask 按 lineId 索引 ⇒ 原墨迹盖不住；reconciliation / 导出也无法定位）。
  //
  // 规则（fail-closed，绝不猜）：
  //   同一 layout line 内所有 pdf-native provenance **完全一致** ⇒ generated 继承该身份；
  //   存在多个不同身份 / 完全没有 pdf-native identity ⇒ **不继承**（保持合成身份）。
  // 注：本处只读 Core 文档，不修改 run provenance、不给 GENERATED_SOURCE 加字段。
  const pdfIdentityByCoreLine = new Map<string, { blockId: string; lineId: string }>();
  {
    const candidates = new Map<string, Set<string>>();
    for (const g of frame.glyphs) {
      const ref = lineIndexOf.get(glyphKey(g.runId, g.textIndex));
      if (ref === undefined) continue;
      const prov = resolvePdfProvenance(document, g.runId);
      const bId = prov?.blockId;
      const lId = prov?.lineId;
      if (typeof bId !== "string" || bId === "") continue;
      if (typeof lId !== "string" || lId === "") continue;
      const key = bId + "\u0001" + lId;
      const set = candidates.get(ref.lineId) ?? new Set<string>();
      set.add(key);
      candidates.set(ref.lineId, set);
    }
    for (const [coreLineId, set] of candidates) {
      if (set.size !== 1) continue; // 混合身份 / 无身份 ⇒ fail-closed
      const only = [...set][0] as string;
      const sep = only.indexOf("\u0001");
      pdfIdentityByCoreLine.set(coreLineId, { blockId: only.slice(0, sep), lineId: only.slice(sep + 1) });
    }
  }

  const registry = new StyleRegistry(options.fontIdentity);
  const identityMixCheck: RenderIdentity[] = [];
  /** coreLineId → 解析出的 legacy lineId（用于检测"两条视觉行撞同一 legacy id"） */
  const legacyLineIdByCoreLine = new Map<string, string>();

  const commands: RenderCommand[] = [];
  const identities: RenderIdentity[] = [];

  // F3B-6.18-C.1：transform 的**唯一来源 = Core 文档对象**（TextBoxObject.transform）。
  // `frame.glyphs` 不带 transform；这里按 textBoxId 读文档对象 —— **绝不读 legacy glyph.transform**。
  const textBoxTransform = lookupTextBoxTransform(document, frame.textBoxId);

  for (const glyph of frame.glyphs) {
    if (!isFiniteBox(glyph)) {
      warn(`${BRIDGE_WARNING_INVALID_BOX}: run=${glyph.runId} textIndex=${glyph.textIndex}`);
      continue;
    }

    const ownProvenance = resolvePdfProvenance(document, glyph.runId);

    const lineRef = lineIndexOf.get(glyphKey(glyph.runId, glyph.textIndex));
    if (lineRef === undefined) {
      warn(`${BRIDGE_WARNING_UNKNOWN_RUN}: run=${glyph.runId} textIndex=${glyph.textIndex}`);
      continue;
    }
    const coreLineId = lineRef.lineId;
    // Step 2b：generated run 继承所属 layout line 的**唯一** PDF 身份。
    // 自身带 provenance 的 glyph（pdf-native）**原样保留**，一行不改。
    // REVERSE-VERIFICATION: env-gated fault injection (never active in browser builds).
    const inherited =
      process.env.BRIDGE_NO_INHERIT === "1"
        ? undefined
        : pdfIdentityByCoreLine.get(coreLineId);
    const provenance =
      ownProvenance?.blockId && ownProvenance?.lineId
        ? ownProvenance
        : inherited
        ? { ...(ownProvenance ?? {}), blockId: inherited.blockId, lineId: inherited.lineId }
        : ownProvenance;

    const identity = resolveRenderIdentity(
      {
        textBoxId: frame.textBoxId,
        paragraphId: glyph.paragraphId,
        coreLineId,
        visualLineIndex: lineRef.visualLineIndex,
        lineIndexInTextBox: lineRef.lineIndexInTextBox,
        provenance,
      },
      { legacyLineId: options.legacyLineId }
    );
    identityMixCheck.push(identity);
    if (identity.lineIdNamespace === "pdf") {
      legacyLineIdByCoreLine.set(coreLineId, identity.lineId);
    }

    const styleRef = registry.getOrCreate(glyph.runId, glyph.style);
    // F3B-6.18-C.1：优先注入式 `transformOf`；否则用 **Core 文档对象**的 TextBox.transform。
    const transform =
      options.transformOf?.(glyph, provenance) ?? textBoxTransformToMatrix6(textBoxTransform);

    // 注意：此处**刻意不写 baseline**（硬契约 1）。若将来要加，必须先读文件头。
    const command: DrawGlyphCommand = {
      type: "drawGlyph",
      char: glyph.char,
      x: glyph.box.x,
      y: glyph.box.y,
      width: glyph.box.width,
      // F3B-6.18-C.2 B · invariant guard：只保证 height 是**正的有限 px**（非法值才兜底）。
      // **不做单位换算** —— lineHeight 的单位语义由 Adapter 的 `lineHeightIsRatio` 决定。
      height: presentationHeight(glyph.box.height, glyph.style.fontSize),
      styleRef,
      blockId: identity.blockId,
      lineId: identity.lineId,
      // 该字段在 GlyphRenderer 中已无消费者（011-A §5.1），但类型要求必填；
      // 这里给出由 provenance 推导的真实值，供将来导出/诊断使用。
      modified: isModifiedRun(provenance),
    };
    if (transform) command.transform = transform;

    commands.push(command);
    identities.push(identity);
  }

  for (const violation of detectLineIdNamespaceMix(identityMixCheck)) {
    warn(`${BRIDGE_WARNING_IDENTITY_MIX}: ${violation}`);
  }

  // 两条**不同**的视觉行解析出**同一个** legacy lineId：
  // Core 的 `TextSourceBinding.lineId` 是 run 级，天然表达不了折行，
  // 而旧 renderer 的 `editedLineBoxes` 是 `Map<lineId, BBox>`（一行一个盒）
  // → 撞 id 会让 mask 裁剪/编辑行定位错行，且是**静默**的。必须显式报告。
  for (const [legacyId, coreLineIds] of groupCoreLinesByLegacyId(legacyLineIdByCoreLine)) {
    if (coreLineIds.length > 1) {
      warn(
        `${BRIDGE_WARNING_DUPLICATE_LEGACY_LINE_ID}: legacy lineId "${legacyId}" 被 ${coreLineIds.length} 条视觉行复用（${coreLineIds.join(", ")}）—— 需要能区分视觉行的 legacy resolver`
      );
    }
  }

  return {
    commands,
    styles: registry.styles,
    styleRefByRunId: registry.snapshot(),
    identities,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  glyph → line 索引
// ─────────────────────────────────────────────────────────────────────

function glyphKey(runId: string, textIndex: number): string {
  return `${runId}\u0001${textIndex}`;
}

/** 一个 glyph 所属视觉行的定位信息 */
interface GlyphLineRef {
  lineId: string;
  /** 段落内视觉行序号（折行必需，见 `LegacyLineIdResolver`） */
  visualLineIndex: number;
  /** TextBox 内视觉行序号（跨段落连续） */
  lineIndexInTextBox: number;
}

/**
 * 由 `TextLayout` 建 `(runId, textIndex) → 视觉行定位` 索引。
 *
 * ⚠️ 这里**只读** `lineId`，不读取也不使用 `RunLayout.textStart/textEnd`
 * 作为 run 的任何"起点"（007 已确定它是行内可见切片）。
 * 行归属刻意用 `glyph.textIndex`（段落坐标系 UTF-16）精确匹配。
 */
function buildGlyphLineIndex(
  layout: TextLayout,
  warn: (message: string) => void
): Map<string, GlyphLineRef> {
  const index = new Map<string, GlyphLineRef>();
  let lineIndexInTextBox = 0;
  for (const paragraph of layout.paragraphs) {
    for (let visualLineIndex = 0; visualLineIndex < paragraph.lines.length; visualLineIndex += 1) {
      const line = paragraph.lines[visualLineIndex];
      const ref: GlyphLineRef = {
        lineId: line.lineId,
        visualLineIndex,
        lineIndexInTextBox,
      };
      for (const run of line.runs) {
        for (const glyph of run.glyphs) {
          const key = glyphKey(run.runId, glyph.textIndex);
          if (index.has(key)) {
            warn(`${BRIDGE_WARNING_DUPLICATE_KEY}: run=${run.runId} textIndex=${glyph.textIndex}`);
            continue;
          }
          index.set(key, ref);
        }
      }
      lineIndexInTextBox += 1;
    }
  }
  return index;
}

/** 反转 `coreLineId → legacyLineId`：得到 `legacyLineId → coreLineId[]` */
function groupCoreLinesByLegacyId(
  byCoreLine: ReadonlyMap<string, string>
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [coreLineId, legacyId] of byCoreLine) {
    const list = out.get(legacyId) ?? [];
    list.push(coreLineId);
    out.set(legacyId, list);
  }
  return out;
}

function isFiniteBox(glyph: EditorGlyphBox): boolean {
  const { x, y, width, height } = glyph.box;
  return (
    Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height)
  );
}

/**
 * F3B-6.18-C.1：取 Core 文档对象 `TextBoxObject.transform`（authoritative；缺省 `undefined`）。
 *
 * 这是 bridge 获取旋转的**唯一**来源 —— **绝不**读 legacy `glyph.transform`
 * （否则 Legacy 会重新变成 Core Renderer 的隐性真相）。
 */
function lookupTextBoxTransform(
  document: EditorDocument,
  textBoxId: string
): readonly [number, number, number, number] | undefined {
  for (const page of document.pages) {
    for (const object of page.objects) {
      if (object.id === textBoxId) return object.transform;
    }
  }
  return undefined;
}

/** `[a,b,c,d]` → CSS 归一化 6 元矩阵 `[a,b,c,d,0,0]`（平移由 `x`/`y` 承担） */
function textBoxTransformToMatrix6(
  t: readonly [number, number, number, number] | undefined
): TransformMatrix | undefined {
  if (!t) return undefined;
  return [t[0], t[1], t[2], t[3], 0, 0];
}

/**
 * F3B-6.18-C.2 **B · Binding invariant guard**。
 *
 * 不变式：`RenderCommand.height` 必须是**正的有限 px** —— 无 `baseline` 时它被渲染器
 * 当作 `line-height: <h>px` / `height: <h>px`，非正/非有限会破坏 renderer contract。
 *
 * ⚠️ 本函数**只拦非法值**：合法（正有限）几何**原样通过**，既不覆盖 Core Layout 的几何，
 * 也不做量纲换算 —— lineHeight 是比例还是 px 由 **Adapter 的 `lineHeightIsRatio`** 决定
 * （见 `editable-document-adapter.ts`），Binding 层不猜单位。
 */
function presentationHeight(boxHeight: number, fontSize: number): number {
  if (Number.isFinite(boxHeight) && boxHeight > 0) return boxHeight;
  // 非法值 ⇒ 用 1em 兜底（不引入任何新比例常量）
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 1;
}

// ─────────────────────────────────────────────────────────────────────
//  样式注册表
// ─────────────────────────────────────────────────────────────────────

/**
 * 按 **runId** 分配 `styleRef` 的注册表。
 *
 * 不按样式内容去重 —— 这是**有意选择**：
 *   · 对 `RendererStrategyInput.styles`（本桥接的输出）而言，
 *     styleRef 的价值是"稳定且与 run 身份一一对应"，不是"省内存"
 *   · 按内容去重会让"两个 run 样式恰好相同"与"一个 run 样式变了"难以区分，
 *     进而让 ref 在下一次 Frame 重建时发生漂移
 *   · `EditableDocument.styles` 是另一套 DTO，它显式声明"去重"（document-model/types.ts:718），
 *     由 `pdf-export-bridge.ts` 按内容去重 —— 两者语义不同，故规则不同
 */
class StyleRegistry {
  private readonly refs = new Map<string, number>();
  private readonly list: EditableStyle[] = [];

  constructor(private readonly fontIdentity?: FontIdentityProvider) {}

  getOrCreate(runId: string, style: TextStyle): number {
    const existing = this.refs.get(runId);
    if (existing !== undefined) return existing;
    const ref = this.list.length;
    this.list.push(toEditableStyle(runId, style, this.fontIdentity));
    this.refs.set(runId, ref);
    return ref;
  }

  get styles(): EditableStyle[] {
    return this.list;
  }

  snapshot(): ReadonlyMap<string, number> {
    return new Map(this.refs);
  }
}

/**
 * Core `TextStyle` → 旧 `EditableStyle`。
 *
 * 字段归属（011-A 决策 #6）：
 *   Core 提供            fontFamily / fontSize / fontWeight / fontStyle / color / lineHeight / letterSpacing
 *   Core 合法 provenance  sourceFontName → `pdfFontName`（"PDF 原始字体名（含 subset 前缀）"，两侧描述一致）
 *   Binding 注入          pdfjsFontFamily / fontId / fontLoaded
 *
 * **不注入就不写** —— 不写空串、不猜、不用 fontFamily 顶替 pdfjsFontFamily
 * （否则 renderer 会拿到一个"看起来有值但实际是 CSS 字体名"的 @font-face 名）。
 */
export function toEditableStyle(
  runId: string,
  style: TextStyle,
  fontIdentity?: FontIdentityProvider
): EditableStyle {
  const out: EditableStyle = {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    color: style.color,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    // V1 format capability（H1-C）：从 Core `TextStyle` 透传装饰，
    // 缺省 undefined 时不写（不写 false、不猜、不继承其它字段）。
    underline: style.underline,
    strike: style.strike,
  };

  const pdfjsFontFamily = fontIdentity?.pdfjsFontFamilyOf?.(runId, style);
  if (pdfjsFontFamily) out.pdfjsFontFamily = pdfjsFontFamily;

  const pdfFontName = fontIdentity?.pdfFontNameOf?.(runId, style) ?? style.sourceFontName;
  if (pdfFontName) out.pdfFontName = pdfFontName;

  const fontId = fontIdentity?.fontIdOf?.(runId, style);
  if (fontId) out.fontId = fontId;

  const fontLoaded = fontIdentity?.fontLoadedOf?.(runId);
  if (fontLoaded !== undefined) out.fontLoaded = fontLoaded;

  return out;
}
