/**
 * core-input-visual.ts — EDITOR-CORE-012-E2（方案 B）
 *
 * **一个极小的外部 store**：声明「Core 输入模式下，哪个 segment 的 DOM 文本必须让位于
 * Core glyph 层」。
 *
 * ── 为什么需要它（而不是 props）────────────────────────────────────
 * `EditableTextNode` 由 **`PDFCanvas`** 渲染（`PDFCanvas.tsx:1646`）。要把"该段由 Core 接管"
 * 传给它，走 props 必须连带改 `PDFCanvas`（012-E2 的允许清单里没有它）。
 * 因此用一个 12 行的外部 store：`PDFEditor`（Core session 的持有者）写入，
 * `EditableTextNode` 通过 `useSyncExternalStore` 订阅。
 *
 * ── 它**不是** document state ──────────────────────────────────────
 * 只承载 **UI presentation 的开关**：
 *   · `enabled`        —— 生产开关 `window.__coreInput === true`
 *   · `ownedSegmentId` —— 当前被 Core session 接管的 segment（无 = null）
 *
 * **不保存文本、不保存 document、不保存 history、不做投影**。
 * 与 012-C6 确立的「不反写 legacy」边界一致：本模块没有任何文本字段。
 *
 * ── 依赖 ───────────────────────────────────────────────────────────
 * 零依赖（不 import React，也不 import Core）。订阅方自行用 React 粘合。
 */

/**
 * F3B-6.27 Step 2 · 编辑面几何（**纯几何，不是文本**）。
 *
 * 几何唯一来源是 Core（`runLiveReflow` 后 `layouts[].paragraphs[].lines[].box`
 * 的 union），**不得**由 DOM 测量反推。`null` = 无多行编辑面 ⇒ 消费方走原路径。
 */
export interface EditingSurfaceGeometry {
  /**
   * ★ F3B-6.27-STEP①：本编辑面承载的 **Core paragraph** 身份。
   *
   *   编辑面是 **paragraph 级**的（文本 / 几何 / caret offset 全部是段落的），
   *   `segmentId` 只回答「谁触发了编辑」，不回答「编辑的是谁」——后者是 paragraphId。
   *
   *   实测（tests/e2e/f3b627-step1-paragraph-identity.spec.ts /
   *   f3b627-acceptance-strict.spec.ts，多段行）：**legacy 行 ≠ Core 段落**。
   *   · legacy 侧该视觉行被切成 **3 个** segment 节点：
   *     「日期：」(3字) + 「2026 年 9-12 月（竞赛天数 6 天，具体日期以补」(29字)
   *     + 「充通知为准）；」(7字)
   *   · Core 侧只有 **2 个** paragraph：
   *     `para_43` =「日期：2026 年 9-12 月（竞赛天数 6 天，具体日期以补」(32字)
   *     `para_44` =「充通知为准）；」(7字)
   *
   *   ⇒ 前两个 segment 同属 `para_43`，第三个属 `para_44`（**另一个段落**）。
   *   编辑面只承载 `para_43`，且进入瞬间它的 textContent 是**触发 segment 的陈旧切片**
   *   （实测 29 字，缺「日期：」前缀），由「日期：」兄弟节点补上那 3 字的视觉。
   *   DOM 上**没有任何字段**能表达 legacy segment ↔ Core paragraph 的这个映射，
   *   此前只能靠**矩形相交**推断同段关系。
   *
   *   ⚠️ 更正两处曾写在这里的**错误/未复现**说法（勿再据以改动代码）：
   *   ① 「该段落被切成 3 个 segment 节点、三个同属一段」——**错**：第三个属 para_44。
   *   ② 「`[data-segment-id]` 在编辑过的行上会同时命中遮罩层与编辑面 ⇒ F2 歧义」
   *      ——**未复现**：`sameIdCount=1` 且 `querySelector` 命中的就是面本身
   *      （遮罩走 canvas 绘制，并不带该属性）⇒ 该歧义不存在。
   */
  readonly paragraphId: string;
  /**
   * ★★ Core 坐标系的段落 union **上**边界（= 首个 Core 视觉行 top）。
   *   几何 authority 在 Core；`top`/`height` 是同一数值经 `round2` 后的显示值。
   */
  readonly coreTop: number;
  /**
   * ★★ Core 坐标系的段落 union **下**边界（= 末个 Core 视觉行 bottom，
   *   **已与紧随其后的 Core 段落首行 top 求交**）。
   *
   *   **段落边界的判据必须用这个字段**（B2 裁决）：
   *   `coreBottom <= nextCoreParagraphTop`。
   *   刻意**不**用 DOM 两个 rect 的像素间隙判定 —— 那混入 Core↔DOM 的 Y 配准偏移
   *   （G9-YREG，独立问题）；也**不**允许用 DOM 实测下一段落顶反向裁剪（B3 已否决）。
   */
  readonly coreBottom: number;
  /** 是否因「下一 Core 段落」而裁剪过下边界（可观测，便于验收区分「裁剪生效」与「本来就齐」） */
  readonly clippedToNextParagraph: boolean;
  readonly left: number;
  readonly top: number;
  /** 宽度下限：必须 ≥ Core 最宽行，否则浏览器会额外折行 */
  readonly width: number;
  /** 覆盖全部视觉行的总高 */
  readonly height: number;
  /** 首行缩进（Core 悬挂缩进；CSS text-indent 只作用首行） */
  readonly textIndent: number;
  /**
   * ★★ P0-F1：当前面承载的是**显式 EditingUnit**（跨多个 Core paragraph）。
   *
   * 缺省 `undefined` = **单 paragraph 面**（既有行为，逐字节不变）。
   * 有值时：`paragraphId` 仍保留（= 首个 paragraph，兼容旧消费者），
   * 而 unit 的结构身份由 `unitId` + `paragraphIds` 表达。
   *
   * ★ 本模块**不保存任何文本**（见文件头纪律）：unit 的文本由 DOM surface
   *   自身拥有（PDFEditor 写入），store 只承载 identity + geometry。
   */
  readonly unitId?: string;
  /** unit 内全部 paragraph 的结构身份（顺序即文档顺序）。单 paragraph 面时缺省。 */
  readonly paragraphIds?: readonly string[];
  /**
   * ★★ 4B-4D-3：Core **logical flow 的自然高度**（Σ 各 flow line 的 lineHeight，
   *   含 separator 行；**不是** Core absolute Y，也**不是** DOM scrollHeight）。
   *
   * 缺省 `undefined` = 单 paragraph 面（既有行为，逐字节不变）。
   * 有值时：`coreBottom` 已被抬升到 **至少覆盖** `unitTop + flowHeight`
   *   ⇒ `EditableTextNode` 的既有公式 `coreBottom − alignedTop` 自然得到
   *   「覆盖整个 Core logical flow」的面高度。
   *
   * ★ 契约：**只保证** `height >= flowHeight`，**不保证** `height >= scrollHeight`。
   *   DOM 因字体度量差异可能排得更高（实测 172 vs 128.7），那是独立的
   *   visual-line fidelity 问题，**不**由本字段补偿。
   */
  readonly flowHeight?: number;
  /**
   * ★★ 2026-10-18（用户缺陷「编辑框内两行行距太近，没有与原文行间距相等」）：
   *   unit 面的 **CSS 行距** = 成员行原始行距（相邻成员行 Core 行盒 y 差，
   *   与 legacy bbox 同一空间、同一口径 —— 提交层 flow 的 `usedLineGap` 同源）。
   *
   *   背景：`baseStyle.lineHeight = 1`（M7.8-014F，单行面冻结不动）被 unit 多行面
   *   继承 ⇒ 行距 = 字号 21.46px，而原文行距实测 41.97px ⇒ 两行挤在一起。
   *
   * 缺省 `undefined` / 0 = 不覆盖（单段面或度量缺失 ⇒ 逐字节保持既有行为）。
   * 有值时：`EditableTextNode` 的 unit 面把 `line-height` 设为该值，并以
   *   **半 leading 补偿** `marginTop = −(lineGap − fontSize)/2` 上移，使首行基线
   *   仍落在 `alignedTop + cssAscent`（M7.8-014F 语义在 unit 面重建，2.55px
   *   配准不回归）；同时面高至少覆盖 `N × lineGap − 半leading`（适配层抬升
   *   coreBottom，`surfaceHeight = coreBottom − alignedTop` 公式不变）。
   */
  readonly lineGap?: number;
}

/**
 * 编辑面提交上下文（**transport，不是 range 的 authority**）。
 *
 * authority 永远是 Binding 的 `SegmentRangeOwnership`（`segmentRangeOf`）；
 * 本类型只是把「当前 owned editing surface 的投影上下文」投递给 UI 消费方，
 * 使 UI **不必也不得**自行推算 range。
 *
 * ⚠️ 用 discriminated union（而非 `range | null`）是必要的：`null` 无法区分
 *   ①「本面不是整段面」（正常，⇒ passthrough）
 *   ②「本面是整段面但 range 缺失」（**内部契约异常**，⇒ 必须 fail-closed）
 * 这两种情况在收口语义上完全相反（见 `binding/segment-commit-slice.ts`）。
 */
export type SegmentCommitContext =
  | {
      /** 本面**不**承载完整 Core 段落（DOM 本来就是段切片）⇒ 提交原样透传 */
      readonly wholeParagraph: false;
    }
  | {
      /** 本面承载完整 Core 段落文本（A′ 方案 A）⇒ 提交前必须按 range 降回切片 */
      readonly wholeParagraph: true;
      readonly paragraphId: string;
      readonly segmentId: string;
      readonly startUtf16: number;
      readonly endUtf16: number;
      /** Core document generation —— stale fence */
      readonly generation: number;
    };

/** UI presentation 开关状态 */
export interface CoreInputVisualState {
  /**
   * 当前编辑段所属 Core 段落被 reflow 折成**多行**时的编辑面几何；
   * 单行场景恒为 `null`（⇒ 行为逐字节不变）。仅 `isEditing` 态消费。
   */
  editingSurface: EditingSurfaceGeometry | null;
  /**
   * ★ F3B-6.27 · S2（UNIT-MEMBER-VISIBILITY，V1）：当前活动 EditingUnit 的
   * **成员行 lineId 集合**（Core `run.source.lineId` 命名空间，如
   * `pdf_p1_block0_l5`）。
   *
   * ── 为什么独立于 `editingSurface`（S1 插桩实证）──────────────────────
   *   `editingSurface`（几何通道）在「提交后第二成员入口重开」时序下会被发布为
   *   `null`，而 unit 编辑会话（遮罩 / A′ / partition）仍然活跃 ⇒ 成员身份**不得**
   *   挂在几何字段上，否则抑制会随几何一起消失（S2 缺陷复现）。
   *
   * ── 契约（用户 2026-10-17 锁定）────────────────────────────────────
   *   · **只存身份**（lineId 数组），不存文本 / 几何 / 历史 segment 状态。
   *   · 发布源 = `explicitUnitSurface.unit.lines[].lineId`（与遮罩同源同调度），
   *     不经过 `editingSurface` / `corePresentationActive`。
   *   · `null` = 无活动 unit 面（单段 / legacy / 退出态）⇒ 成员判据不生效
   *     ⇒ 既有行为逐字节不变。
   *   · replace 语义：换 unit / 关闭 ⇒ 整体替换或置 null，新旧会话不残留。
   *   · fail-closed：合成 lineId（`syn:<paragraphId>`）匹配不上任何 legacy
   *     segment 的 `source.lineId` ⇒ 该成员 simply 不被抑制（不猜测、不误抑制）。
   */
  unitMemberLineIds: readonly string[] | null;
  /** Core 输入模式是否启用（`window.__coreInput === true`） */
  enabled: boolean;
  /** 已被 Core session 接管的 segment id；`null` = 尚无（DOM 仍按 legacy 显示） */
  ownedSegmentId: string | null;
  /**
   * ★ F3B-6.27：提交收口上下文（transport）。
   * 默认 `null` = 本面不是整段面 ⇒ 提交路径逐字节保持既有行为。
   */
  segmentCommitContext: SegmentCommitContext | null;
}

const DISABLED: CoreInputVisualState = {
  enabled: false,
  ownedSegmentId: null,
  editingSurface: null,
  segmentCommitContext: null,
  unitMemberLineIds: null,
};

let state: CoreInputVisualState = DISABLED;
const listeners = new Set<() => void>();

/** `paragraphIds` 逐元素比较（引用比较不够：producer 可能每次都新建数组） */
function sameParagraphIds(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * S2：`unitMemberLineIds` 逐元素比较（契约：数组按元素比较，replace 语义）。
 * `null` 与空数组**不相等**（null = 无 unit 面；空数组生产方不产出，但语义上
 * 同样表示"无成员"——此处按契约只做元素级判等，不混淆两者）。
 */
function sameUnitMemberLineIds(
  a: readonly string[] | null,
  b: readonly string[] | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 读取当前状态（同一引用语义：值未变则引用不变，供 `useSyncExternalStore` 比较） */
export function getCoreInputVisualState(): CoreInputVisualState {
  return state;
}

/** 写入状态（值未变则 **不通知**，避免无意义重渲染） */
export function setCoreInputVisualState(next: Partial<CoreInputVisualState>): void {
  const merged: CoreInputVisualState = {
    enabled: next.enabled ?? state.enabled,
    ownedSegmentId: next.ownedSegmentId === undefined ? state.ownedSegmentId : next.ownedSegmentId,
    editingSurface: next.editingSurface === undefined ? state.editingSurface : next.editingSurface,
    segmentCommitContext:
      next.segmentCommitContext === undefined ? state.segmentCommitContext : next.segmentCommitContext,
    // S2：`null` 是**有意义的清除值**（关闭 unit 面）⇒ undefined 才代表"保持"。
    unitMemberLineIds:
      next.unitMemberLineIds === undefined ? state.unitMemberLineIds : next.unitMemberLineIds,
  };
  const sameSurface =
    merged.editingSurface === state.editingSurface ||
    (!!merged.editingSurface &&
      !!state.editingSurface &&
      merged.editingSurface.left === state.editingSurface.left &&
      merged.editingSurface.top === state.editingSurface.top &&
      merged.editingSurface.width === state.editingSurface.width &&
      merged.editingSurface.height === state.editingSurface.height &&
      merged.editingSurface.textIndent === state.editingSurface.textIndent &&
      // ★★ F3B-6.27-H2-C：`paragraphId` 也必须逐字段比较。
      //   实测（__h2cProbe + __editingSurfaceGeometry 判别实验）：H2 的「身份与几何分离」
      //   使 rebind 后的新 surface **几何数值完全不变、只有 paragraphId 变**
      //   （新段落没有行盒，几何恒按 lineId 解析）⇒ 此处若漏比 paragraphId
      //   ⇒ 不通知 ⇒ consumer 的 `data-editing-paragraph-id` 停留旧段落
      //   （`__editingSurfaceGeometry` 已是 para_5g 而 DOM 属性仍是 para_43）。
      //   与下方 unitId/paragraphIds 同一缺陷族（"几何不变但身份变了"）。
      merged.editingSurface.paragraphId === state.editingSurface.paragraphId &&
      // ★★ P0-F1：identity 必须逐字段比较。否则「几何完全相同、但 unit 不同」时
      //   **不通知** ⇒ consumer 读到 stale unitId/paragraphIds ⇒ DOM 写错文本面
      //   （与下面 segmentCommitContext 必须逐字段比较同源：都是"几何不变但身份变了"）。
      merged.editingSurface.unitId === state.editingSurface.unitId &&
      sameParagraphIds(merged.editingSurface.paragraphIds, state.editingSurface.paragraphIds) &&
      // ★ 2026-10-18（行距修复）：lineGap 同样必须逐字段比较 —— 同一 unit 重算
      //   （编辑后成员行距可能变，如折行点数变化）时几何其余字段可不变，
      //   漏比 ⇒ 不通知 ⇒ 编辑面行距停留旧值（与 paragraphId/unitId 同缺陷族）。
      (merged.editingSurface.lineGap ?? 0) === (state.editingSurface.lineGap ?? 0));
  // ★ 必须逐字段比较 segmentCommitContext：**只比几何会让「几何未变而 range 已变」
  //   的情形**不通知** ⇒ consumer 读到 stale range ⇒ 提交时切错位置（比原缺陷更糟）。
  //   identity 用引用比较即可：producer 每次发布新对象；undefined-vs-null 已归一。
  const sameCommitContext = merged.segmentCommitContext === state.segmentCommitContext;
  const sameMembers = sameUnitMemberLineIds(merged.unitMemberLineIds, state.unitMemberLineIds);
  if (
    merged.enabled === state.enabled &&
    merged.ownedSegmentId === state.ownedSegmentId &&
    sameSurface &&
    sameCommitContext &&
    sameMembers
  ) {
    return;
  }
  // 关闭时一并清掉归属、几何与提交上下文，避免残留（flag 来回切换也不会留下"幽灵 suppressed"）
  state = merged.enabled
    ? merged
    : {
        enabled: false,
        ownedSegmentId: null,
        editingSurface: null,
        segmentCommitContext: null,
        unitMemberLineIds: null,
      };
  for (const listener of [...listeners]) listener();
}

/** 订阅（返回退订函数） */
export function subscribeCoreInputVisualState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * **S2（UNIT-MEMBER-VISIBILITY · V1）成员判据**：本 segment 是否为「当前活动
 * EditingUnit 的**非宿主**成员行」上的 segment。
 *
 * ── 语义边界（用户 2026-10-17 锁定契约）────────────────────────────────
 *   · 判据 = `segment.source.lineId`（M7.8-040 binding 命名空间
 *     `pdf_${blockId}_l${lineIdx}`）∈ `unitMemberLineIds`。
 *     **不得**用顶层 `segment.lineId`（`line_${page}_${y}` 显示命名空间）。
 *   · 非宿主成员 `isEditing` 恒 false ⇒ 本判据**独立于 isEditing**成立，
 *     不引入"全局 isEditing 抑制所有段"的宽泛条件。
 *   · 宿主（编辑面）显式排除：宿主文本由 D2 设计保持可见。
 *     ★ 排除依据 = **`isEditing`**（本元素即编辑面的自身身份），**不只**比较
 *       `ownedSegmentId`：S1 缺陷态（editingSurface=null）下 `ownedSegmentId`
 *       可能停留在旧宿主（owned≠当前 editingSegmentId）⇒ 只按 owned 排除会把
 *       真正的编辑面判成成员而误隐（A/B 负对照实测抓到：宿主 color 变透明）。
 *   · fail-closed：`segmentLineId` 缺失 / 合成 lineId 匹配不上 ⇒ 不抑制
 *     （不猜测、不误抑制；宁可漏抑制一帧，不误伤可见性）。
 *   · legacy / 单段路径：`unitMemberLineIds` 为 null ⇒ 恒 false（逐字节不变）。
 */
export function isUnitMemberSegment(
  segmentId: string | null | undefined,
  segmentLineId: string | null | undefined,
  isEditing: boolean
): boolean {
  if (!state.enabled) return false;
  const members = state.unitMemberLineIds;
  if (!members || members.length === 0) return false;
  if (!segmentId || !segmentLineId) return false;
  // 宿主 / 编辑面排除（两个依据都保留：isEditing 为自身身份，ownedSegmentId 为
  //   store 归属；缺陷态下前者才可靠）。
  if (isEditing || segmentId === state.ownedSegmentId) return false;
  return members.includes(segmentLineId);
}

/**
 * **E2.1 的唯一判定**：该 segment 的 DOM 文本是否必须视觉不可见（让位给 Core glyph 层）。
 *
 * 两个判据取**并集**（S2 · V1）：
 *   1. **宿主判据**（原三条件，语义不变）：Core 输入模式已启用 ∧ 该 segment
 *      正处于编辑态 ∧ 该 segment 确实由 Core session 接管（`ownedSegmentId` 匹配）。
 *   2. **成员判据**（S2 新增）：该 segment 位于当前活动 EditingUnit 的成员行上
 *      （`isUnitMemberSegment`）——覆盖非宿主成员，其 original 文本不再叠加在
 *      Core 新布局 / clear 层之上。
 *
 * ⚠️ 条件 1 的 isEditing 不能省：未建模输入（方向键 / Home/End / 词删…）在 Core
 *    模式下仍**交回 legacy**，那些输入依赖 DOM 自身显示；若无条件抑制，用户会
 *    "打了字看不到"。
 * ⚠️ 条件 2 不加 isEditing 门：非宿主成员本就不在编辑态；其抑制完全由 unit
 *    成员身份驱动，与宿主判据解耦（S1 缺陷态下几何通道失效时依然有效）。
 */
export function isDomTextSuppressed(
  segmentId: string | null | undefined,
  isEditing: boolean,
  segmentLineId?: string | null
): boolean {
  if (!state.enabled || !segmentId) return false;
  // 宿主判据（原语义：ownedSegmentId 命中才需要 isEditing）
  if (state.ownedSegmentId === segmentId) {
    return isEditing;
  }
  // ★ S2 成员判据（并集第二支）
  if (segmentLineId && isUnitMemberSegment(segmentId, segmentLineId, isEditing)) return true;
  return false;
}

/**
 * 取「本 segment 当前是否为整段提交面」的上下文。
 *
 * consumer 必须经本函数读取（与 `isDomTextSuppressed` 同款纪律），
 * 以便**只有 owned segment** 能拿到提交上下文 —— 兄弟 segment 的面永不被误判。
 */
export function segmentCommitContextFor(
  segmentId: string | null | undefined
): SegmentCommitContext | null {
  if (!state.enabled || !segmentId) return null;
  if (state.ownedSegmentId !== segmentId) return null;
  const ctx = state.segmentCommitContext;
  if (!ctx) return null;
  // 整段面必须与 owned segment 同 id，否则视为无可用上下文（fail-closed 由消费方处理）
  return ctx.wholeParagraph && ctx.segmentId !== segmentId ? null : ctx;
}

/** 仅测试用：复位到缺省 */
export function resetCoreInputVisualState(): void {
  state = DISABLED;
  listeners.clear();
}
