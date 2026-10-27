/**
 * editor/components/core-editing-surface-sync.ts — F3B-6.27-G6（Step 2 契约原语）
 *
 * E2-EXCEPTION 的**纯判定**部分：决定「是否把 Core 段落文本同步进 active editing
 * surface 的 textContent，以及同步后 caret 应落在哪」。
 *
 * ── 为什么是纯函数 ────────────────────────────────────────────────────
 * 例外的全部风险都在「什么时候**允许**写」。把它做成**无副作用、无 DOM、无 segment**
 * 的判定函数 ⇒ 以下三条由**结构**保证而非纪律保证：
 *   · 拿不到 `segment` ⇒ 不可能改 `seg.text`
 *   · 拿不到 `originalText` ⇒ 不可能改它
 *   · 不碰 `setSegments` ⇒ 不产生 Legacy ownership 反写
 *
 * ── 触发源（唯一）──────────────────────────────────────────────────────
 *   EditorTransaction / Core after ──▶ Binding ──▶ 本函数
 *   ⚠️ **不以 `segment.text` 变化为触发**（实测 Core mutation 后 Legacy segment 恒不变）。
 *
 * ── 三层 ownership ─────────────────────────────────────────────────────
 *   Core owns text · Binding owns relationship · DOM owns input/caret mechanics
 */

export interface CoreEditingSurfaceSyncInput {
  /** 本段是否处于编辑态（contentEditable） */
  isEditing: boolean;
  /** 本段是否为当前 active editing surface */
  isActiveSegment: boolean;
  /** 本段是否已被 Core 接管（semantic ownership） */
  isCoreOwned: boolean;
  /** Core transaction 产出的该段 current paragraph text；null/undefined = 尚无 Core 文本 */
  coreText: string | null | undefined;
  /** 当前 DOM 上的文本（只读；用于「已同步」判定，避免无意义写入） */
  domText: string;
  /** 本次 Core mutation 的 generation 令牌 */
  generation: number;
  /** 当前已知的最新 generation（< 则本 mutation 已陈旧） */
  currentGeneration: number;
  /** 当前 caret 在 DOM 文本中的 UTF-16 offset；null = 未知 */
  caretOffset: number | null;
  /**
   * 该 **Core 段落**对应的 Legacy segment 数量（由 Binding 用**已验证的解析器**统计，
   * **不得**用裸 `source.lineId` 比较 —— lineId 不是稳定 identity）。
   *
   * ⚠️ 真实结构：`1 Core paragraph → N Legacy segment`（实测 l5→2、l13/l16/l20→3）。
   *
   * ★ **方案 A 语义**：`N >= 1` 都允许把 Core 段落文本写进 active editing surface
   *   （该 surface 承载的是**整段**文本；兄弟 segment 的 DOM 文本透明，不会重复）。
   *   只有 `N === 0`（行→段落映射不可用）才 fail-open。
   *
   * ⚠️ 由此**调用方义务**：`N !== 1` 时，surface 的几何必须也按 **paragraph** 给
   *   （见 `core-input-visual` 的 `editingSurface`），且 caret 换算**不得再减 segment base**
   *   （DOM offset ≡ Core paragraph offset）。这两条在 `PDFEditor` 的 A′ effect 内落实。
   */
  segmentCountForCoreLine: number;
  /**
   * 本次 Core mutation 的 range 是否**跨越多个 run**（由 Binding 用权威 offset 计算）。
   *
   * ⚠️ 实测证据：跨段时「before 区间 + delta」算法会**算错**（插入 Q 于 r1:1→r2:3，
   * 预测值比真值少 1 字符）⇒ 必须 fail-open。
   * 该检测的正反两面均已验证（跨段 ⇒ true；单段/整段替换/段拆分 ⇒ false）。
   */
  isCrossRun: boolean;
  /**
   * 本次 Core mutation 的命令类别。
   *
   * ⚠️ 实测证据：`Enter` 产生 `split-paragraph`，会**新增段落** ⇒ 段→段落映射改变，
   * 上述算法语义不适用 ⇒ 非文本命令一律 fail-open。
   */
  commandKind: "insert" | "delete" | "replace" | "other" | "split-paragraph";
}

export interface CoreEditingSurfaceSyncDecision {
  /** 是否允许写入 DOM */
  sync: boolean;
  /** 要写入的文本（仅 sync 时非 null） */
  text: string | null;
  /** 同步后 caret 应落的 offset（仅 sync 时非 null；已按新文本长度合法化） */
  caretOffset: number | null;
  /** 判定理由（可观测，不静默） */
  reason: string;
}

/** caret 合法化：落在新文本范围内则保持，否则夹到末尾；未知则落到末尾。 */
export function legalizeCaretOffset(offset: number | null, textLength: number): number {
  if (!Number.isInteger(offset) || offset === null) return textLength;
  if (offset < 0) return 0;
  return offset > textLength ? textLength : offset;
}

export function decideCoreEditingSurfaceSync(
  input: CoreEditingSurfaceSyncInput
): CoreEditingSurfaceSyncDecision {
  const noSync = (reason: string): CoreEditingSurfaceSyncDecision => ({
    sync: false,
    text: null,
    caretOffset: null,
    reason,
  });

  // ① 非编辑态 —— E2 原规则完全适用（Core→DOM 投影仍禁止）
  if (!input.isEditing) return noSync("not-editing");
  // ② 非 active surface —— 不得写别人的 DOM
  if (!input.isActiveSegment) return noSync("not-active-surface");
  // ③ Core 未接管 —— 无 Core 真值来源
  if (!input.isCoreOwned) return noSync("core-not-owned");
  // ④ Core 尚未产出文本
  if (input.coreText === null || input.coreText === undefined) return noSync("no-core-text");
  // ④' ★ **方案 A（多段面）语义**：多段行**现在允许**同步。
  //
  //   旧语义（Step 2 回归止血）：`N !== 1` ⇒ noSync，理由是「把段落文本灌进单个
  //   segment 会**复制兄弟段文本**」（实测画布出现重复「日期：」）。
  //
  //   该理由在方案 A 下**已不成立**：
  //   · 编辑态由**一个** DOM surface 承载**完整** Core 段落文本（不是某个 segment 的切片）
  //   · 兄弟 segment 的 DOM 文本**本来就是透明的**（`isDomTextSuppressed` 只对
  //     `ownedSegmentId` 生效，canvas 画原字）⇒ 根本不存在"复制"与"重复"
  //   · 编辑期的文字渲染 authority **临时提升到 Core paragraph**（Legacy segment 身份不变）
  //
  //   ⚠️ 仍必须 fail-open 的唯一情形：**段数为 0**（行→段落映射不可用），
  //     此时无法确定这个元素属于哪个 Core paragraph ⇒ 不猜。
  if (input.segmentCountForCoreLine === 0) return noSync("core-line-mapping-unavailable");
  // ④'' ★ 跨段选区 fail-open（实测会算错：预测值比真值少 1 字符）
  if (input.isCrossRun) return noSync("cross-run-range");
  // ④''' ★ 非文本命令 fail-open（实测 split-paragraph 会新增段落 ⇒ 段→段落映射改变）
  if (input.commandKind !== "insert" && input.commandKind !== "delete" && input.commandKind !== "replace") {
    return noSync("non-text-command");
  }
  // ⑤ 陈旧 mutation 不得覆盖新编辑状态
  if (input.generation < input.currentGeneration) return noSync("stale-generation");
  // ⑥ 已同步 ⇒ 不做无意义写入（幂等，避免扰动 caret）
  if (input.coreText === input.domText) return noSync("already-in-sync");

  return {
    sync: true,
    text: input.coreText,
    caretOffset: legalizeCaretOffset(input.caretOffset, input.coreText.length),
    reason: "core-owned-active-surface",
  };
}
