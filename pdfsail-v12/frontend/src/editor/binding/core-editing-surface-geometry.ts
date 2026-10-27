/**
 * core-editing-surface-geometry.ts — 编辑面**纯几何**契约（F3B-6.27 Step 1）
 *
 * 目标：一个逻辑编辑面覆盖**连续的多个 Core paragraph**。
 * 注意：不是"一个 paragraph 的多个视觉行" —— 实测 `layoutGranularity = "visual-line"`，
 * 一个 paragraph 当前就是一个视觉行，`ParagraphLayout.lines[]` 恒为长度 1。
 *
 * ★ 本层严格边界（全部为 0，无一例外）：
 *   · 不碰 DOM（无 document / Range / getComputedStyle）
 *   · 不碰 `segment.text` / legacy 文档 / `EditableTextNode`
 *   · 不碰 commit / mutation / undo
 *   · 不判定 A′ 文本同步资格（`segmentCountForCoreLine` 守卫**不属于**本层，见 G8：
 *     多 paragraph surface **不得**自动解除既有 multi-segment fail-open）
 *   · 缩进只来自 **Core geometry**，绝不由 DOM 测量反推（Core 保持几何权威）
 *
 * Geometry Gate 实测依据（gd-swim-2026.pdf）：
 *   · Core 段落 p1 = 32 字符 / 行宽 515.6px；p2 = 7 字符
 *   · 宽度修正为 515.6 后浏览器自然换行仍落在 offset 33（Core 边界是 32，差 1）
 *     ⇒ 浏览器换行**不可**作为 Core line-break 的权威来源
 *   · 故用 synthetic `\n` 显式表达段落边界；`\n` 属于 boundary，**不属于任何 paragraph**
 *   · 悬挂缩进 p1.x=164.2 / p2.x=121.1（差 43.1px）可由 `text-indent` 精确表达
 */

/** 只读矩形（Page Canvas Space，与 Core layout 同坐标系） */
export interface SurfaceRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 编辑面覆盖的**一个视觉行**（Core layout 的一行） */
export interface CoreSurfaceLineInput {
  readonly paragraphId: string;
  /** Core 段落文本（唯一真值；DOM 文本绝不可反向写入这里） */
  readonly text: string;
  /** Core layout 算好的行盒 —— 几何唯一来源 */
  readonly box: SurfaceRect;
  /**
   * 该行**之前**是否为硬段落边界。
   *
   * 缺省 `false` = **软折行**（Core `runLiveReflow` 对超宽段落做的自动折行）：
   * 同一 paragraphId 的第 2..N 行，DOM 文本**直接相接、不插 `\n`**，offset 连续。
   *
   * `true` = **硬边界**（真正的 paragraph 边界）：DOM 文本插入 synthetic `\n`，
   * 映射表产生 `kind: "paragraph-boundary"` 段。
   *
   * ⚠️ 两者语义不同，绝不可混为一谈：
   *   · 软折行的换行位置是 **Core 算出来的**，不是数据里的字符 ⇒ 不占 offset
   *   · 硬边界是 **Core 段落边界**，需要一个显式的 DOM 表示（`\n`）⇒ 占 1 个 offset
   *
   * 实测依据（gd-swim-2026.pdf）：
   *   · `coreRenderSource.layouts[i].paragraphs[j].lines[k].box` 是 **reflow 后**的行盒
   *     （`PDFEditor.tsx:4700-4702` 注释明写"含折行"）⇒ 同一段落**可以**有多行
   *   · 现有 `coreMaskGeometry` 已支持单段落多行 union（其 G3 断言 height === 42）
   */
  readonly breakBefore?: boolean;
  /**
   * 本行在**其所属段落内**的起始 offset。
   * 缺省时由本函数按「同 paragraphId 依次递进」自动推导（软折行的常规情形）。
   */
  readonly coreStart?: number;
}

export interface CoreEditingSurfaceInput {
  /**
   * 已按 **Core 顺序** 排列的连续段落。
   * ⚠️「在 Core 文档中确实相邻」由调用方保证并断言；本纯函数不做文档查询（保持零依赖）。
   *   它只做可自证的校验：paragraphId 不重复、generation 一致、textBoxId 同源。
   */
  readonly lines: readonly CoreSurfaceLineInput[];
  readonly textBoxId: string;
  readonly generation: number;
  readonly currentGeneration: number;
}

export interface CoreEditingSurfaceLine {
  readonly paragraphId: string;
  readonly box: SurfaceRect;
  /** 相对 `geometry.box.x` 的缩进；仅首行由 CSS `text-indent` 表达 */
  readonly textIndent: number;
  readonly domStart: number;
  readonly domEnd: number;
  readonly length: number;
  /** 本行首字符在其所属段落内的 offset（软折行的第 2..N 行 > 0） */
  readonly coreStart: number;
}

/** DOM 连续 offset ⇄ Core 段落映射的一段 */
export interface DomOffsetMapping {
  readonly domStart: number;
  readonly domEnd: number;
  /** `kind === "text"` 时为所属段落；`"paragraph-boundary"` 时为 null */
  readonly paragraphId: string | null;
  readonly coreStart: number;
  readonly coreEnd: number;
  readonly kind: "text" | "paragraph-boundary";
}

export interface CoreEditingSurfaceGeometry {
  /** 所有行盒的 union */
  readonly box: SurfaceRect;
  readonly lines: readonly CoreEditingSurfaceLine[];
  /** 首行缩进（= lines[0].box.x − box.x），供 DOM `text-indent` 使用 */
  readonly firstLineIndent: number;
  /**
   * 编辑面**必须**具备的最小宽度：≥ 每一行宽。
   * ⚠️ 否则浏览器会额外换行 —— Gate 实测宽度 450.5 < Core 515.6 时 `lineCount` = 3
   *   （宽度换行 1 次 + synthetic `\n` 1 次），几何随即失效。
   */
  readonly requiredWidth: number;
}

export interface CoreEditingSurface {
  /** `p1 + "\n" + p2 + ...` */
  readonly text: string;
  readonly paragraphIds: readonly string[];
  readonly geometry: CoreEditingSurfaceGeometry;
  readonly domToCore: readonly DomOffsetMapping[];
  readonly textBoxId: string;
  readonly generation: number;
}

/** DOM offset 落点；boundary 处**不假装**属于任何段落 */
export type DomOffsetCoreLocation =
  | { readonly kind: "text"; readonly paragraphId: string; readonly localOffset: number }
  | {
      readonly kind: "paragraph-boundary";
      readonly domOffset: number;
      readonly beforeParagraphId: string;
      readonly beforeLocalOffset: number;
      readonly afterParagraphId: string | null;
      readonly afterLocalOffset: number | null;
    };

export type CreateSurfaceResult =
  | { readonly ok: true; readonly surface: CoreEditingSurface }
  | { readonly ok: false; readonly reason: string };

function unionRect(boxes: readonly SurfaceRect[]): SurfaceRect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    if (b.x < x0) x0 = b.x;
    if (b.y < y0) y0 = b.y;
    if (b.x + b.width > x1) x1 = b.x + b.width;
    if (b.y + b.height > y1) y1 = b.y + b.height;
  }
  // ⚠️ 2 位归一：这些值会**直接**喂给 DOM style（left/width/top/height）与
  //   源码守卫断言；浮点残差（如 558.6999999999999）会让两者都不稳定。
  return { x: round2(x0), y: round2(y0), width: round2(x1 - x0), height: round2(y1 - y0) };
}

/**
 * ★ R3：行几何的**两种合法状态**（Binding / P0-C 层语义；**Core 契约不变**）。
 *
 *   · `inked`     ：width > 0 && height > 0（既有）
 *   · `empty-line`：width === 0 && height > 0
 *     空 paragraph 的真实 Core layout 事实（实测 `cases/gd-swim-2026.pdf`）：
 *       line box = {x:135, y:452.829, **width:0**, **height:23.925**}，baseline=471.969
 *     ⇒ **垂直几何完整可用**（y/height/baseline 与非空行逐字节相同），缺的只是墨迹宽。
 *
 * 语义纪律（用户裁决）：
 *   · empty-line **参与** union / `coreBottom` 求交（它确实占据垂直空间）
 *   · empty-line **不参与** `requiredWidth`（`maxLineWidth` 从 0 起取 max，零宽不拉低它）
 *   · 绝不把 `isUsableRect` 泛化成 `width >= 0`（负宽仍 fail-closed）
 *   · height === 0 / 非有限 ⇒ 仍然 fail-closed（「无垂直几何」与「零宽」是不同类）
 */
function lineGeometryKind(
  b: SurfaceRect | null | undefined,
): "inked" | "empty-line" | null {
  if (!b) return null;
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return null;
  if (!Number.isFinite(b.width) || !Number.isFinite(b.height)) return null;
  if (b.height <= 0) return null; // 无垂直几何 ⇒ 不可用（与零宽不同类）
  if (b.width > 0) return "inked";
  if (b.width === 0) return "empty-line";
  return null; // 负宽 ⇒ fail-closed
}

function isUsableRect(b: SurfaceRect | null | undefined): b is SurfaceRect {
  return lineGeometryKind(b) !== null;
}

/**
 * 构建编辑面。**fail-closed**：任何不自证的输入都返回 `{ ok: false }`，
 * 绝不"猜"一个面出来（错的换行几何比没有编辑面更糟）。
 */
export function createCoreEditingSurface(
  input: CoreEditingSurfaceInput
): CreateSurfaceResult {
  // G7 — generation 守卫：陈旧 Core mutation 不得建面
  if (input.generation !== input.currentGeneration) {
    return { ok: false, reason: "stale-generation" };
  }
  if (!input.textBoxId) return { ok: false, reason: "no-text-box" };
  const lines = input.lines ?? [];
  // N >= 1；空 ⇒ 无面（G1/G2）
  if (lines.length === 0) return { ok: false, reason: "no-lines" };

  const seen = new Set<string>();
  for (const l of lines) {
    if (!l.paragraphId) return { ok: false, reason: "line-without-paragraph-id" };
    seen.add(l.paragraphId);
    if (typeof l.text !== "string") return { ok: false, reason: "line-without-text" };
    if (!isUsableRect(l.box)) return { ok: false, reason: "line-without-usable-box" };
  }

  const box = unionRect(lines.map((l) => l.box));
  const mappings: DomOffsetMapping[] = [];
  const outLines: CoreEditingSurfaceLine[] = [];
  let domCursor = 0;
  let text = "";
  // 每个段落已消费的字符数 —— 同一 paragraphId 的后续行（软折行）由此递推 coreStart
  const consumedByPara = new Map<string, number>();
  // 段落首次出现时是否应插入硬边界 `\n`
  const firstSeen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const len = l.text.length;
    const isNewPara = !firstSeen.has(l.paragraphId);
    // coreStart：显式给出优先；否则同段落递推，首行从 0 起
    const autoStart = consumedByPara.get(l.paragraphId) ?? 0;
    const coreStart = typeof l.coreStart === "number" ? l.coreStart : autoStart;
    // fail-closed：软折行的 coreStart 必须正好接在上一行之后，否则映射会自相矛盾
    if (!isNewPara && coreStart !== autoStart) {
      return { ok: false, reason: "non-contiguous-core-start" };
    }

    // 硬边界：显式 breakBefore，或该段落的**首个**视觉行且不是编辑面的第一行
    const needBreak = i > 0 && (l.breakBefore === true || isNewPara);

    if (needBreak) {
      // synthetic `\n` —— 属于 boundary，**不属于任何 paragraph**
      mappings.push({
        domStart: domCursor,
        domEnd: domCursor + 1,
        paragraphId: null,
        coreStart: 0,
        coreEnd: 0,
        kind: "paragraph-boundary",
      });
      text += "\n";
      domCursor += 1;
    }

    outLines.push({
      paragraphId: l.paragraphId,
      box: l.box,
      textIndent: round2(l.box.x - box.x),
      domStart: domCursor,
      domEnd: domCursor + len,
      length: len,
      coreStart,
    });
    mappings.push({
      domStart: domCursor,
      domEnd: domCursor + len,
      paragraphId: l.paragraphId,
      coreStart,
      coreEnd: coreStart + len,
      kind: "text",
    });
    text += l.text;
    domCursor += len;
    consumedByPara.set(l.paragraphId, coreStart + len);
    firstSeen.add(l.paragraphId);
  }

  return {
    ok: true,
    surface: {
      text,
      paragraphIds: lines.map((l) => l.paragraphId),
      geometry: {
        box,
        lines: outLines,
        firstLineIndent: round2(lines[0]!.box.x - box.x),
        // 编辑面宽度下限 = union 宽（已含各行）；额外要求 ≥ 最大行宽（防 extra wrap）
        requiredWidth: round2(Math.max(box.width, maxLineWidth(lines))),
      },
      domToCore: mappings,
      textBoxId: input.textBoxId,
      generation: input.generation,
    },
  };
}

function maxLineWidth(lines: readonly CoreSurfaceLineInput[]): number {
  let m = 0;
  for (const l of lines) if (l.box.width > m) m = l.box.width;
  return m;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** G4 — DOM offset → Core 落点。`\n` 处返回 boundary（不归属任何段落）。 */
export function mapDomOffsetToCore(
  surface: CoreEditingSurface,
  domOffset: number
): DomOffsetCoreLocation | null {
  if (!Number.isInteger(domOffset)) return null;
  const total = surface.text.length;
  if (domOffset < 0 || domOffset > total) return null;
  // ⚠️ 区间一律**半开** [domStart, domEnd)：offset 32 就是那个 synthetic `\n` 本身，
  //   它必须落到 paragraph-boundary，而不是 P1 的"末尾"（否则 `\n` 被吞进段落，
  //   跨段落 caret 定位会错 1 个字符 —— 实测浏览器换行点 33 vs Core 边界 32 的教训）。
  for (const m of surface.domToCore) {
    if (domOffset < m.domStart || domOffset >= m.domEnd) continue;
    if (m.kind === "text") {
      // ⚠️ 必须加 `m.coreStart`：软折行（同一 paragraph 的第 2..N 行）里
      //   `domStart - 0` 不是段落内偏移 —— 不加 coreStart 会让第二行起整体偏移
      //   （实测 k=20 被算成 localOffset 0，正确值 10）。
      return {
        kind: "text",
        paragraphId: m.paragraphId!,
        localOffset: m.coreStart + (domOffset - m.domStart),
      };
    }
    // 命中 boundary 段（domStart..domEnd-1 = `\n` 本身）
    const before = surface.geometry.lines.find((l) => l.domEnd === m.domStart);
    const after = surface.geometry.lines.find((l) => l.domStart === m.domEnd);
    return {
      kind: "paragraph-boundary",
      domOffset,
      beforeParagraphId: before?.paragraphId ?? "",
      beforeLocalOffset: before ? paragraphEndOffset(before) : 0,
      afterParagraphId: after?.paragraphId ?? null,
      afterLocalOffset: after ? 0 : null,
    };
  }
  // 末尾（折叠位置，domOffset === total）：落在**最后一个视觉行所属段落**的末尾
  if (domOffset === total) {
    const last = surface.geometry.lines[surface.geometry.lines.length - 1];
    if (last) {
      return { kind: "text", paragraphId: last.paragraphId, localOffset: paragraphEndOffset(last) };
    }
  }
  return null;
}

/**
 * 该视觉行**所属段落**的末尾 offset（= coreStart + length）。
 * ⚠️ 不可直接用 `length` —— 软折行时那是**行**长度，差整段已折行的长度。
 *   （本函数修的就是同一个错的三处：正向映射、末尾折叠、boundary before。）
 */
function paragraphEndOffset(line: CoreEditingSurfaceLine): number {
  return line.coreStart + line.length;
}

/** G4（反向）— Core 段落局部 offset → DOM offset。支持软折行（同段落多行）。 */
export function mapCoreToDomOffset(
  surface: CoreEditingSurface,
  paragraphId: string,
  localOffset: number
): number | null {
  if (!Number.isInteger(localOffset)) return null;
  if (localOffset < 0) return null;
  // ⚠️ 同一 paragraphId 可能有多个 DOM 区间（软折行）⇒ 必须按 `coreStart` 定位，
  //    不能只查 `geometry.lines.find(paragraphId === …)`（那只会命中第一行）。
  // 区间交界处（上一行 coreEnd === 下一行 coreStart）两个映射都匹配，但算出的
  // DOM offset 相同 ⇒ 无歧义，取首个即可。
  for (const m of surface.domToCore) {
    if (m.kind !== "text" || m.paragraphId !== paragraphId) continue;
    if (localOffset < m.coreStart || localOffset > m.coreEnd) continue;
    return m.domStart + (localOffset - m.coreStart);
  }
  return null;
}

/** 便捷：编辑面总 DOM 文本长度（= sum(len) + (N-1) 个 synthetic `\n`） */
export function coreEditingSurfaceDomLength(surface: CoreEditingSurface): number {
  return surface.text.length;
}
