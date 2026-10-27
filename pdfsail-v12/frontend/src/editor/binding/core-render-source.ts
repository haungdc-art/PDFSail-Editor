/**
 * editor/binding/core-render-source.ts — EDITOR-CORE-012-A（Phase A3）
 *
 * 唯一编排函数：把既有的 legacy `EditableDocument` **只读投影**成旧渲染器可用的
 * `RenderCommand[] + EditableStyle[]`。
 *
 *     EditableDocument（既有的唯一编辑真相）
 *            ↓ editableDocumentToEditorDocument({ layoutGranularity: "visual-line" })   ← A1
 *       EditorDocument（**派生快照，不是可写真相**）
 *            ↓ createLegacyLineMetrics(...)                                              ← A2
 *       FontMetricsProvider（L2 = PDF 原始 advance）
 *            ↓ layoutTextBox(...)                                                        ← 006-B
 *       TextLayout
 *            ↓ buildRenderFrame(...)                                                     ← 010-B
 *       EditorRenderFrame
 *            ↓ buildRenderCommands(...)                                                  ← 011-B
 *       RenderCommand[]（仅 drawGlyph） + EditableStyle[]
 *
 * ── 它**不是**什么 ─────────────────────────────────────────────────
 *   · 不保存任何 document state（没有 class、没有 store、没有 useState）
 *   · 不产生第二套文档/布局/渲染模型（只调用既有 Core 函数）
 *   · 不修改 `EditorDocument` schema、不修改 006-B 的 layout contract
 *   · 不接输入（编辑真相迁移属于 012-C）
 *
 * ── 为什么不放在 `editor/core/runtime/` ────────────────────────────
 * 本函数需要 import `editor/legacy`（A1）与 `document-model` 类型，
 * 而 `editor/core/**` **禁止** import 这些（011-C 的架构守卫会失败）。
 * 因此编排放在 Core 的对侧 Adapter 层（`editor/binding/`），Core 本身保持干净。
 *
 * ── 失败语义（生产安全）─────────────────────────────────────────────
 * 返回判别联合而不是抛错：任何一步失败 → `{ ok: false }`，
 * 调用方（PDFEditor）保持旧渲染源。**绝不让 Core 渲染的失败导致白屏。**
 *
 * ── 为什么保留 legacy 的非 glyph 命令 ──────────────────────────────
 * Core 只产出 glyph；`drawLine{mask}` / `drawRect` / `drawImage` 属于
 * **PDF Binding / coverage** 的产物（011-A ownership 决策）。
 * 因此 flag 打开时是「**Core 接管 glyph + legacy 继续提供 mask/patch/image**」，
 * 而不是"Core 吞掉其他命令"。
 */

import type { EditableDocument, EditableLine, EditableStyle } from "../../document-model/types";
import type { DrawGlyphCommand, DrawImageCommand, RenderCommand } from "../../document-model/render-command";
import { editableDocumentToEditorDocument } from "../legacy";
import { imageAssetRegistry } from "./image-asset-registry";
import { buildCoreImageRenderCommands, isImageRenderCommand } from "./core-image-render-adapter";
import type { EditorDocument, TextBoxObject } from "../core/document";
import type { AdvanceSource, FontMetricsProvider } from "../core/layout";
import { createFontMetricsProvider, layoutTextBox } from "../core/layout";
import type { TextLayout } from "../core/layout";
import { buildRenderFrame } from "../core/render";
import type { EditorRenderFrame } from "../core/render";
import { buildRenderCommands, type FontIdentityProvider, type RenderCommandBridgeOptions } from "./render-command-bridge";
import { createLegacyLineMetrics } from "./pdf-metrics";
import { createDiffedLineMetrics } from "./diffed-line-metrics";
import type { LegacyLineIdResolver } from "./render-identity";

/**
 * 生产开关名。
 *
 * F3B-6.18-D.1 起契约变更：**缺省 ON**（Core 文本 renderer = production default）；
 * 只有显式 `window.__coreRender === false` 才回退 legacy（emergency rollback）。
 */
export const CORE_RENDER_FLAG = "__coreRender";

// ─────────────────────────────────────────────────────────────────────
//  结果类型
// ─────────────────────────────────────────────────────────────────────

export interface CoreRenderSourceStats {
  pages: number;
  textBoxes: number;
  /** Core 侧布局出来的视觉行总数（`visual-line` 粒度下应等于 legacy 行数） */
  layoutLines: number;
  glyphs: number;
  /** 违反「1 段落 = 1 视觉行」的段落数（**导入路径应为 0**；编辑路径允许 >0） */
  wrappedParagraphs: number;
  /** 命中 L2（PDF advance）的 glyph 数 */
  metricsWithAdvance: number;
  /** 退回兜底估算的 glyph 数 */
  metricsWithoutAdvance: number;
  /** 实际渲染用的 advance 来源直方图（§18 证据链） */
  advanceSourceHistogram: Partial<Record<AdvanceSource, number>>;
  /** 使用了**调用方注入**度量的 TextBox id（其余 TextBox 走兜底估算） */
  metricsInjectedTextBoxes: string[];
  /** 走兜底估算（`advanceSource = "canvas"`）的 TextBox id —— 编辑后应有值 */
  metricsFallbackTextBoxes: string[];
  /** 含 >1 段落的 TextBox 数。导入路径应为 0；**编辑路径允许 >0**（Enter 会新增段落） */
  multiParagraphTextBoxes: number;
  /** 整个派生链耗时（ms）。供 012-A 评估：同步构建，大文档下需关注 */
  elapsedMs: number;
}

export interface CoreRenderSourceSuccess {
  ok: true;
  /** **仅含 drawGlyph**；mask / rect / image 由调用方从 legacy 侧合并 */
  commands: RenderCommand[];
  styles: EditableStyle[];
  /** 派生出来的文档快照（只读；供测试与诊断，**不是**可写真相） */
  editorDocument: EditorDocument;
  layouts: TextLayout[];
  frame: EditorRenderFrame;
  stats: CoreRenderSourceStats;
  warnings: string[];
}

export interface CoreRenderSourceFailure {
  ok: false;
  reason: string;
  warnings: string[];
}

export type CoreRenderSourceOutcome = CoreRenderSourceSuccess | CoreRenderSourceFailure;

export interface CoreRenderSourceOptions {
  legacyLineId?: LegacyLineIdResolver;
  fontIdentity?: FontIdentityProvider;
  transformOf?: RenderCommandBridgeOptions["transformOf"];
}

/** `buildCoreRenderSourceFromDocument` 的额外选项（**只有度量**，不含任何 legacy 文档输入） */
export interface CoreRenderSourceFromDocumentOptions extends CoreRenderSourceOptions {
  /**
   * 每 TextBox 的度量提供者，**由调用方决定**。
   *
   * 未提供 provider 的 TextBox → 兜底估算（`advanceSource = "canvas"`），
   * 并如实登记在 `stats.metricsFallbackTextBoxes`。
   *
   * ⚠️ C6-F：**不要**为了保持 `pdfsail-glyph` 数字好看，把"已被编辑过"的 TextBox
   * 也塞进 L2 provider —— 编辑会移动 `textIndex`，逐 glyph 复用旧 PDF advance 会**错位**，
   * 产生"看似精确的错误"（比明确 fallback 更危险）。调用方只应对**文本未变**的 TextBox 注入。
   */
  metricsByTextBox?: ReadonlyMap<string, FontMetricsProvider>;

  /**
   * ★ F3B-6.27-G3：**编辑后 run 的行级原字体**解析（显示层专用，**与 export provenance 无关**）。
   *
   * 缺陷（真实文档实测）：编辑某行后该行在**画布**上用 sans 绘制，而**透明点击层**仍用
   * 原 PDF 字体（`__pdfsail_pdf_font_*`）。两套 advance metrics 不一致 ⇒ 用户「按看到的字
   * 去点，光标落到另一个字符」。
   *
   * 机制：`toEditableStyle` 的 `pdfjsFontFamilyOf(runId, style)` 仅靠 `style.sourceFontName`
   * 解析；编辑后该 run 变 `generated`、`sourceFontName` 丢失 ⇒ 解析返回 undefined ⇒
   * 画布回落 Core 默认 `fontFamily`（sans）。
   *
   * 契约（**窄、fail-open**）：
   *   · 仅当段落内**存在** `sourceFontName` 缺失的 run 时才回调（未编辑段落零开销、零行为变化）；
   *   · 每个段落**只回调一次**（避免逐 run 重复回溯）；
   *   · 返回 `undefined` ⇒ 不写 `pdfjsFontFamily`，沿用 Core 既有 `fontFamily`（**绝不猜**）。
   *
   * ⚠️ **不解决「新字符是否在该子集字体内」的 coverage 判定** —— 那是下一层 fallback 问题
   * （且已证明 fontkit 对 CID-keyed CJK 子集的 coverage API 不可靠）。本层只做
   * 「已知原 PDF font identity ⇒ 使用已注册的 PDF font face」。
   */
  fontFamilyOfGeneratedLine?: (query: {
    textBoxId: string;
    paragraphId: string;
    paragraphIndex: number;
    pageIndex: number;
    textBoxIndex: number;
  }) => string | undefined;
}

/**
 * ★ F3B-6.27-G3：预建 `runId → 行级原字体 family` 映射。
 *
 * 为什么必须在**这里**建：`pdfjsFontFamilyOf(runId, style)` 的签名只有 `runId` + `style`，
 * **没有 document 上下文**，无法从 run 反查段落/行来源。而本函数持有 `editorDocument`，
 * 可在进入主循环前一次性把映射算好，由 `fontIdentity` 包装层闭包捕获。
 *
 * 只登记「段落内存在缺失 `sourceFontName` 的 run」的段落；未编辑段落完全不触碰。
 */
function buildGeneratedLineFontFamilies(
  document: EditorDocument,
  resolve: CoreRenderSourceFromDocumentOptions["fontFamilyOfGeneratedLine"]
): Map<string, string> {
  const out = new Map<string, string>();
  if (!resolve) return out;
  for (const page of document.pages ?? []) {
    const objects = (page.objects ?? []) as TextBoxObject[];
    for (let textBoxIndex = 0; textBoxIndex < objects.length; textBoxIndex++) {
      const textBox = objects[textBoxIndex];
      if (textBox.type !== "text") continue;
      const paragraphs = textBox.paragraphs ?? [];
      for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
        const paragraph = paragraphs[paragraphIndex];
        const runs = paragraph.runs ?? [];
        // 只在「有 run 缺 sourceFontName」时才回溯；未编辑段落零开销
        if (!runs.some((r) => !r.style?.sourceFontName)) continue;
        let family: string | undefined;
        try {
          family = resolve({
            textBoxId: textBox.id,
            paragraphId: paragraph.id,
            paragraphIndex,
            pageIndex: page.index ?? 0,
            textBoxIndex,
          });
        } catch {
          family = undefined; // fail-open：解析异常不得影响渲染
        }
        if (!family) continue; // 查不到 ⇒ 不登记，沿用 Core 既有 fontFamily
        for (const run of runs) out.set(run.id, family);
      }
    }
  }
  return out;
}

/**
 * **导入边界**的契约守卫：`legacy → Core` 投影要求 **每个 TextBox 恰好 1 个段落**。
 *
 * ⚠️ 它证明的是「**legacy → Core 的初始投影**满足 visual-line contract」，
 * **不是**「任何 Core document 都必须满足」的不变量（012-C6-B）。
 *
 * 为什么导入路径必须守：只要一个 TextBox 里有 >1 段，Core 就会从 `textBox.y` 起
 * 按 `style.lineHeight` 累加 y（`reflow.ts:374-375`）→ 纵向漂移，
 * 也就是 012-A 审计 §3.2 明确拒绝的 `block` 粒度行为。
 *
 * 为什么**不能**把它当成 Core document 的生产前置条件：Core 编辑本身会新增段落
 * （Enter → `split-paragraph`）→ `1 TextBox = 1 Paragraph` 在**编辑后必然被打破**。
 * 若继续用它守卫所有 Core document，Enter 会被自己设计的 invariant 卡死。
 * 编辑路径（`buildCoreRenderSourceFromDocument`）因此**跳过**它，只记
 * `stats.multiParagraphTextBoxes` + 警告（可观测，不阻塞）。
 */
export function checkImportedVisualLineGranularity(
  document: EditorDocument
): { ok: true } | { ok: false; reason: string } {
  for (const page of document.pages) {
    for (const textBox of page.objects) {
      if (textBox.type !== "text") continue; // F3B-6.24-B3：图片对象无段落
      if (textBox.paragraphs.length !== 1) {
        return {
          ok: false,
          reason:
            `granularity-not-visual-line: textBox=${textBox.id} 有 ${textBox.paragraphs.length} 个段落` +
            `（visual-line 粒度要求恰好 1）`,
        };
      }
    }
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────
//  主入口
// ─────────────────────────────────────────────────────────────────────

/** 每个 TextBox 的度量决议（由两条入口各自决定） */
interface TextBoxMetricsDecision {
  metrics: FontMetricsProvider;
  /** 是否由调用方注入（`false` = 走 Core 兜底估算，`advanceSource` 会是 `"canvas"`） */
  injected: boolean;
  warnings: string[];
}

type MetricsResolver = (textBox: TextBoxObject) => TextBoxMetricsDecision;

/** `projectDocument` 的注入参数 */
interface ProjectionInput {
  resolveMetrics: MetricsResolver;
  importWarnings: readonly string[];
  /** `true` = 导入边界（legacy 投影），强制执行 visual-line 守卫 */
  enforceImportedGranularity: boolean;
}

/** 把 legacy 文档只读投影成 Core 渲染源。失败返回 `{ ok: false }`（调用方回退旧路径）。 */
export function buildCoreRenderSource(
  legacy: EditableDocument,
  options: CoreRenderSourceOptions = {}
): CoreRenderSourceOutcome {
  const warnings: string[] = [];

  let imported;
  try {
    imported = editableDocumentToEditorDocument(legacy, { layoutGranularity: "visual-line" });
  } catch (error) {
    return { ok: false, reason: `import-failed: ${describe(error)}`, warnings };
  }
  warnings.push(...imported.warnings);
  const editorDocument = imported.document;

  // B3-C-5-E-A：本入口直连 import adapter（**不经** initializeCoreDocument），
  // 而 adapter 现已产出 image 资产 ⇒ 必须在此自行注册本 run 的 assets，
  // 否则 Core ImageObject.assetRef 将 resolve null（D-B fail-closed 静默回 legacy）。
  // document 与 assets 成对来自**同一次**适配（绝不重复调用 adapter）；注册先于任何解析。
  // 用户裁决：沿用 nextId 机制，允许重复适配产生新 assetRef（不做稳定 id / 去重 / GC）。
  if (imported.assets.length > 0) imageAssetRegistry.registerMany(imported.assets);

  // 导入边界守卫：只证明「legacy → Core 初始投影」满足 visual-line contract
  const granularityCheck = checkImportedVisualLineGranularity(editorDocument);
  if (!granularityCheck.ok) {
    return { ok: false, reason: granularityCheck.reason, warnings };
  }

  // 未编辑 → 每个 TextBox 都能用 legacy 行做 L2（PDF 原始 advance）
  const legacyLineIndex = buildLegacyLineIndex(legacy);
  const resolveMetrics: MetricsResolver = (textBox) => {
    const binding = textBox.paragraphs[0]?.runs[0]?.source;
    const legacyLine = lookupLegacyLine(legacyLineIndex, binding?.blockId, binding?.lineId);
    if (!legacyLine) {
      return {
        metrics: createFallbackMetrics(),
        injected: false,
        warnings: [
          `missing-legacy-line: textBox=${textBox.id} blockId=${binding?.blockId ?? "(none)"} ` +
            `lineId=${binding?.lineId ?? "(none)"} → 该行退回兜底度量`,
        ],
      };
    }
    const lineMetrics = createLegacyLineMetrics(legacyLine);
    return { metrics: lineMetrics.metrics, injected: true, warnings: [...lineMetrics.warnings] };
  };

  return projectDocument(editorDocument, options, {
    resolveMetrics,
    importWarnings: warnings,
    enforceImportedGranularity: true,
  });
}

/**
 * **C6-A**：用**已存在的** `EditorDocument`（Core session 的 `history.state.document`）投影。
 *
 * ⚠️ 与 `buildCoreRenderSource` 的关键区别：**绝不再次从 legacy 转换**。
 * 一旦 Core session 存在，渲染源必须直接来自 `EditorHistory` 持有的文档，否则会出现
 *
 *     Input → EditorDocument(N+1) → 又去读 legacy(N) → 退回 N   （编辑后画面不更新）
 *
 * ⚠️ **不执行**导入边界守卫：Core 编辑本身会新增段落（Enter → `split-paragraph`），
 * `1 TextBox = 1 Paragraph` 在编辑后**必然被打破**；继续用它守卫会卡死 Enter。
 * 多段落只登记 `stats.multiParagraphTextBoxes` + 警告（可观测，不阻塞）。
 *
 * 度量由调用方按 TextBox 给定（`options.metricsByTextBox`）；未给的 TextBox 走兜底估算
 * 并登记在 `stats.metricsFallbackTextBoxes` —— **编辑后应当如此**（C6-F：不要为了
 * `pdfsail-glyph` 好看而复用已经错位的旧 PDF advance）。
 */
export function buildCoreRenderSourceFromDocument(
  document: EditorDocument,
  options: CoreRenderSourceFromDocumentOptions = {}
): CoreRenderSourceOutcome {
  const metricsByTextBox = options.metricsByTextBox;
  const resolveMetrics: MetricsResolver = (textBox) => {
    const injected = metricsByTextBox?.get(textBox.id);
    if (injected) return { metrics: injected, injected: true, warnings: [] };
    return { metrics: createFallbackMetrics(), injected: false, warnings: [] };
  };

  return projectDocument(document, options, {
    resolveMetrics,
    importWarnings: [],
    enforceImportedGranularity: false,
  });
}

/** 两条入口共享的投影实现
/**
 * Step 2: build metricsByTextBox for an already-existing Core document.
 *
 * The Core visible render entry buildCoreRenderSourceFromDocument accepts metricsByTextBox,
 * but production never passed one => every TextBox used createFallbackMetrics()
 * (advance = fontSize * 0.5 uniform). Production evidence:
 *   [CORE-012C6] metricsFallbackTextBoxes: Array(21)
 * That is the root cause recorded in text-reflow-forensic.ts.
 *
 * Why not createLegacyLineMetrics: it is positional (textIndex -> original glyph). After an
 * edit textIndex shifts, so the same index yields a DIFFERENT char advance - exactly the
 * C6-F 'precise but wrong' failure. We use createDiffedLineMetrics (LCS identity, Step 1).
 *
 * Conservative boundaries:
 * - only 1 TextBox = 1 Paragraph; after a split the line identity is no longer 1:1
 *   => NOT injected (falls back); never guesses paragraph 0.
 * - line missing / no glyph / alignment failure => NOT injected.
 * - metrics only: no fontFamily, no mask, no export path.
 */
export function buildMetricsByTextBoxFromLegacy(
  legacy: EditableDocument,
  coreDocument: EditorDocument
): Map<string, FontMetricsProvider> {
  const out = new Map<string, FontMetricsProvider>();
  const index = buildLegacyLineIndex(legacy);
  for (const page of coreDocument.pages ?? []) {
    for (const textBox of page.objects ?? []) {
      if (textBox.type !== "text") continue;
      const paragraphs = textBox.paragraphs ?? [];
      // P0-COORD: split (Enter -> insert-paragraph) 后不再 fail-closed。
      //
      // 原逻辑 paragraphs.length !== 1 => continue，会让「按 Enter 提交」的整行退回
      // createFallbackMetrics()（advance = fontSize * 0.5 统一值）⇒ 行宽压缩到约 68%
      // （实测 364.776 vs 515.609）⇒ 提前换行 + 视觉「坐标左移」。
      // 实测：blur 提交 injected/fallback = 21/0；Enter 提交 = 20/1（fallback 正是被编辑行）。
      //
      // 可行性已验证（tests/e2e/_out/p0vps-split-align.mts）：
      //   createDiffedLineMetrics(legacyLine, 含换行符的新文本)
      //     -> withRealAdvance 13 / measured 1 / warnings []
      //     换行符与新字符走 measured；13 个原字符复用**各自**真实 advance（LCS 身份对齐）。
      //
      // 仍保留的 fail-closed：定位不到 legacy 行 ⇒ 不注入（绝不猜测）。
      const binding = (paragraphs as any[])
        .flatMap((p) => (p?.runs ?? []) as any[])
        .find((r) => r && r.source && r.source.lineId)?.source;
      const legacyLine = lookupLegacyLine(index, binding?.blockId, binding?.lineId);
      if (!legacyLine) continue;
      // newText 必须覆盖**整个 textBox**（多 paragraph 用换行连接）；
      // 只取 paragraphs[0] 会让 diff 在 split 后误判原文被删除。
      const newText = (paragraphs as any[])
        .map((p) => ((p?.runs ?? []) as any[]).map((r) => (r?.text ?? "")).join(""))
        .join("\n");
      out.set(textBox.id, createDiffedLineMetrics(legacyLine, newText).metrics);
    }
  }
  return out;
}
/** 两条入口共享的投影实现：布局 → 帧 → glyph 命令（不 import legacy，不碰 session） */
function projectDocument(
  editorDocument: EditorDocument,
  options: CoreRenderSourceOptions,
  input: ProjectionInput
): CoreRenderSourceOutcome {
  const warnings: string[] = [...input.importWarnings];
  const startedAt = typeof performance !== "undefined" ? performance.now() : 0;

  // F3B-6.24-B3：只取文本框（图片对象不参与文本渲染源）
  const textBoxes = editorDocument.pages.flatMap((page) =>
    page.objects.filter((o): o is TextBoxObject => o.type === "text")
  );
  if (textBoxes.length === 0) {
    // 没有可渲染的 TextBox → Core 渲染会得到空白页面，必须让调用方回退
    return { ok: false, reason: "no-text-boxes", warnings };
  }

  const commands: RenderCommand[] = [];
  const styles: EditableStyle[] = [];
  const layouts: TextLayout[] = [];
  const frames: EditorRenderFrame[] = [];
  const advanceSourceHistogram: Partial<Record<AdvanceSource, number>> = {};
  const metricsInjectedTextBoxes: string[] = [];
  const metricsFallbackTextBoxes: string[] = [];
  let layoutLines = 0;
  let glyphCount = 0;
  let wrappedParagraphs = 0;
  let multiParagraphTextBoxes = 0;

  // ★ F3B-6.27-G3：编辑后 run（无 sourceFontName）的行级原字体回填。
  //   调用方 provider 仍是**主路径**（未编辑 run 行为逐字节不变）；仅当它给不出答案时
  //   才用行级映射兜底。两者都无 ⇒ 不写 pdfjsFontFamily，沿用 Core 既有 fontFamily。
  const generatedLineFamilies = buildGeneratedLineFontFamilies(
    editorDocument,
    options.fontFamilyOfGeneratedLine
  );
  const effectiveFontIdentity: FontIdentityProvider | undefined =
    options.fontIdentity || generatedLineFamilies.size > 0
      ? {
          ...options.fontIdentity,
          pdfjsFontFamilyOf: (runId: string, style: never) =>
            options.fontIdentity?.pdfjsFontFamilyOf?.(runId, style) ??
            generatedLineFamilies.get(runId),
        }
      : undefined;

  for (const textBox of textBoxes) {
    if (textBox.paragraphs.length > 1) multiParagraphTextBoxes += 1;

    const decision = input.resolveMetrics(textBox);
    warnings.push(...decision.warnings);
    if (decision.injected) metricsInjectedTextBoxes.push(textBox.id);
    else metricsFallbackTextBoxes.push(textBox.id);

    let layoutResult;
    try {
      layoutResult = layoutTextBox(editorDocument, textBox.id, decision.metrics);
    } catch (error) {
      return {
        ok: false,
        reason: `layout-failed: textBox=${textBox.id}: ${describe(error)}`,
        warnings,
      };
    }
    warnings.push(...layoutResult.warnings);

    const layout = layoutResult.layout;
    const frame = buildRenderFrame(editorDocument, layout, {
      caret: null,
      selection: null,
    });
    warnings.push(...frame.warnings);

    // 核心不变量：visual-line 粒度下每个段落必须恰好 1 条视觉行
    for (const paragraph of layout.paragraphs) {
      if (paragraph.lines.length !== 1) wrappedParagraphs += 1;
      layoutLines += paragraph.lines.length;
    }
    for (const glyph of frame.glyphs) {
      advanceSourceHistogram[glyph.advanceSource] =
        (advanceSourceHistogram[glyph.advanceSource] ?? 0) + 1;
      glyphCount += 1;
    }

    const bridge = buildRenderCommands(editorDocument, layout, frame, {
      legacyLineId: options.legacyLineId,
      fontIdentity: effectiveFontIdentity,
      transformOf: options.transformOf,
    });
    warnings.push(...bridge.warnings);

    // 各 TextBox 自成一个样式空间 → 合并时对 styleRef 做偏移
    const styleOffset = styles.length;
    for (const style of bridge.styles) styles.push(style);
    for (const command of bridge.commands) {
      const glyphCommand = command as DrawGlyphCommand;
      commands.push(
        styleOffset === 0
          ? glyphCommand
          : ({ ...glyphCommand, styleRef: glyphCommand.styleRef + styleOffset } as DrawGlyphCommand)
      );
    }

    layouts.push(layout);
    frames.push(frame);
  }

  // 实际用了什么度量，以**帧的直方图**为准（不预声明，避免"声明与事实不符"）
  const metricsWithAdvance =
    (advanceSourceHistogram["pdf-metrics"] ?? 0) +
    (advanceSourceHistogram["pdfsail-glyph"] ?? 0) +
    (advanceSourceHistogram["resolved-font"] ?? 0);
  const metricsWithoutAdvance = advanceSourceHistogram.canvas ?? 0;

  if (input.enforceImportedGranularity && wrappedParagraphs > 0) {
    warnings.push(
      `wrapped-paragraphs: ${wrappedParagraphs} 个段落被折成多条视觉行（违反导入 visual-line 契约；` +
        `可能原因：TextBox 宽度小于 Σadvance）`
    );
  }
  if (!input.enforceImportedGranularity && multiParagraphTextBoxes > 0) {
    warnings.push(
      `multi-paragraph-text-box: ${multiParagraphTextBoxes} 个 TextBox 含 >1 段落（编辑新增段落所致，` +
        `**不视为粒度违规**；Core 会从 textBox.y 起按 lineHeight 累加，纵向位置可能漂移）`
    );
  }
  if (metricsWithoutAdvance > 0) {
    warnings.push(
      `advance-coverage: ${metricsWithoutAdvance}/${metricsWithAdvance + metricsWithoutAdvance} 个 glyph 未命中 PDF advance（advanceSource=canvas 的部分横向可能不保真）`
    );
  }

  // C5-D-B：Core image 投影（Binding 合并层）。文本 glyph 保持纯净（Core 只产
  // drawGlyph）；屏幕 image 命令在此追加，去重发生在 mergeCoreRenderCommands。
  // fail-closed：投影异常 → 跳过（legacy image 命令保留），绝不中断整页。
  let coreImageCommands: DrawImageCommand[] = [];
  try {
    coreImageCommands = buildCoreImageRenderCommands(editorDocument);
  } catch (error) {
    warnings.push(`core-image-projection-failed: ${describe(error)} → 图片由 legacy 路径兜底`);
  }
  commands.push(...coreImageCommands);

  return {
    ok: true,
    commands,
    styles,
    editorDocument,
    layouts,
    /** 第一个 TextBox 的帧（诊断用；`visual-line` 粒度下每 TextBox 恰 1 行） */
    frame: frames[0],
    stats: {
      pages: editorDocument.pages.length,
      textBoxes: textBoxes.length,
      layoutLines,
      glyphs: glyphCount,
      wrappedParagraphs,
      metricsWithAdvance,
      metricsWithoutAdvance,
      advanceSourceHistogram,
      metricsInjectedTextBoxes,
      metricsFallbackTextBoxes,
      multiParagraphTextBoxes,
      elapsedMs:
        (typeof performance !== "undefined" ? performance.now() : 0) - startedAt,
    },
    warnings: dedupe(warnings),
  };
}

// ─────────────────────────────────────────────────────────────────────
//  生产开关 + 成对切换（A4 / A6）
// ─────────────────────────────────────────────────────────────────────

/**
 * 读取生产开关。
 *
 * ── F3B-6.18-D.1 通过后的新默认（本轮启用）────────────────────────────
 *
 *     ON  是 production default（Core = 唯一**文本** renderer truth）
 *     OFF 是 emergency rollback（**只有显式 `=== false` 才关闭**）
 *
 * ```text
 * __coreRender === false  ⇒ Legacy 文本 renderer（rollback）
 * otherwise（缺省 / true / 其它） ⇒ Core 文本 renderer
 * ```
 *
 * 与 `readCoreTextEditInputFlag` 同契约（default ON + explicit-false rollback）。
 * SSR / 无宿主时返回 false（保守：无宿主不启用 Core 渲染）。
 *
 * ⚠️ Core **只接管文本 glyph**；mask / rect / image 属 PDF Binding / coverage，
 *    仍由 legacy 提供（见 `mergeCoreRenderCommands`，011-A ownership 决策）——
 *    即「Core = Text rendering truth，Legacy = 其余视觉兼容层」。
 * ⚠️ Core 不可用（投影失败 / 无 TextBox）时 `selectRenderSource` **自动回退 legacy**，
 *    绝不让 Core 渲染失败导致白屏。
 */
export function readCoreRenderFlag(scope?: { [CORE_RENDER_FLAG]?: unknown }): boolean {
  const target = scope ?? (typeof window !== "undefined" ? (window as unknown as object) : undefined);
  if (!target) return false;
  return (target as Record<string, unknown>)[CORE_RENDER_FLAG] !== false;
}

/**
 * 合并 Core 的 glyph 命令与 legacy 的非 glyph 命令。
 *
 * Core 只产出 `drawGlyph`；`drawLine{mask}` / `drawRect` / `drawImage` 属
 * PDF Binding / coverage 的产物（011-A ownership 决策），必须继续由 legacy 侧提供，
 * **不能被 Core 吞掉**（否则签名 mask、背景 patch、图片会消失）。
 * 顺序：Core glyph 在前，legacy 非 glyph 在后（`groupCommands` 按类型分组，交错无影响；
 * 而 glyph 之间的相对顺序被完整保留，`selectedGlyphIds` 的下标语义不变）。
 */
export function mergeCoreRenderCommands(
  coreCommands: readonly RenderCommand[],
  legacyCommands: readonly RenderCommand[]
): RenderCommand[] {
  // C5-D-B：Core 已产出屏幕 image 命令时，按 blockId 去重 legacy 同 id 的
  // drawImage（Core 优先），避免同一张图重复上屏。Core 未产出的图（解析失败 /
  // 无 registry）其 legacy drawImage 原样保留（回退安全，绝不白屏）。
  const coreImageBlockIds = new Set<string>();
  for (const cmd of coreCommands) {
    if (isImageRenderCommand(cmd)) coreImageBlockIds.add(cmd.blockId);
  }
  return [
    ...coreCommands,
    ...legacyCommands.filter((cmd) => {
      if (cmd.type === "drawGlyph") return false;
      if (cmd.type === "drawImage" && coreImageBlockIds.has(cmd.blockId)) return false;
      return true;
    }),
  ];
}

export interface RenderSourceSelection {
  commands: RenderCommand[];
  styles: EditableStyle[];
  /** 实际生效的来源（诊断 / 断言用） */
  source: "legacy" | "core";
  /** 未启用或 Core 失败时的原因 */
  reason: string | null;
}

/**
 * **成对**选择渲染源。
 *
 * ⚠️ `commands` 与 `styles` 必须同时切换：`styleRef` 指向的是
 * `buildRenderCommands` 自己产出的 styles 表，只换 commands 会让 styleRef 指错表。
 *
 * - `enabled === false`：返回 **legacy 的原引用** → 与 flag 关闭前逐字节等价
 * - `enabled === true` 且 `core.ok === true`：Core 接管 glyph，legacy 继续提供非 glyph
 * - `enabled === true` 但 Core 失败/未提供：**回退 legacy**（生产安全）
 */
export function selectRenderSource(
  enabled: boolean,
  legacy: { commands: readonly RenderCommand[]; styles: readonly EditableStyle[] },
  core: CoreRenderSourceOutcome | null
): RenderSourceSelection {
  if (!enabled) {
    return {
      commands: legacy.commands as RenderCommand[],
      styles: legacy.styles as EditableStyle[],
      source: "legacy",
      reason: "flag-off",
    };
  }
  if (!core || !core.ok) {
    return {
      commands: legacy.commands as RenderCommand[],
      styles: legacy.styles as EditableStyle[],
      source: "legacy",
      reason: core ? core.reason : "core-source-unavailable",
    };
  }
  return {
    commands: mergeCoreRenderCommands(core.commands, legacy.commands),
    styles: core.styles,
    source: "core",
    reason: null,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  内部工具
// ─────────────────────────────────────────────────────────────────────

/** `blockId\u0001lineId` 与纯 `lineId` 双键索引（`lineId` 冲突时先到先得） */
function buildLegacyLineIndex(legacy: EditableDocument): Map<string, EditableLine> {
  const index = new Map<string, EditableLine>();
  for (const page of legacy.pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        const composite = `${block.id}\u0001${line.id}`;
        if (!index.has(composite)) index.set(composite, line);
        if (!index.has(line.id)) index.set(line.id, line);
      }
    }
  }
  return index;
}

function lookupLegacyLine(
  index: ReadonlyMap<string, EditableLine>,
  blockId: string | undefined,
  lineId: string | undefined
): EditableLine | null {
  if (lineId === undefined) return null;
  if (blockId !== undefined) {
    const composite = index.get(`${blockId}\u0001${lineId}`);
    if (composite) return composite;
  }
  return index.get(lineId) ?? null;
}

/**
 * legacy 行缺失时的兜底度量：不配置任何来源 → 走 Core 的兜底估算，
 * `advanceSource` 会如实标成 `"canvas"`（可观测，不冒充权威度量）。
 */
function createFallbackMetrics() {
  return createFontMetricsProvider({});
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
