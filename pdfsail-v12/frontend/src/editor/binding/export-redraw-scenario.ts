/**
 * export-redraw-scenario.ts — F3B-6.28 · **D-3B-5**：重绘**场景授权**判定（纯函数）。
 *
 * 背景（用户 2026-10-14 裁决）：批准开启生产 gate（`__exportRedraw` 缺省 ON，
 * 显式 `false` 回滚），但**只限已验证的 D1 段落末尾追加场景**；替换 / 删除 /
 * 合并 / 多段落流动 / 跨页推挤**未授权**，必须继续走未经重绘 gate 放行的既有路径。
 *
 * ── 为什么需要场景判定 ────────────────────────────────────────────────
 *   D-3B-4 的写入资格门（gate + 计划在效 + 投影完整 + 清除证明 + 重绘完整）
 *   只回答「**这次重绘能不能安全完成**」，不回答「**这次编辑属不属于已验证场景**」。
 *   后者必须由**事务本身**（UnitTransactionCommand.operations）+ 位移行的页面
 *   归属判定，且判定必须发生在计划登记时（PDFEditor），因为：
 *     · operations 是事务身份的一部分（不是文本/几何反推）；
 *     · 导出侧拿不到事务（只剩 lineId 身份 + 事务水位）。
 *
 * ── D1 授权判据（全部满足才授权）──────────────────────────────────────
 *   ① 事务**恰 1 条** operation（>1 ⇒ 跨段/合并/多段落流动，未授权）；
 *   ② 该 op 区间**折叠**（start === end ⇒ 纯插入；非折叠 ⇒ 替换/删除，未授权）；
 *   ③ replacement 非空（折叠 + 空 ⇒ 无意义编辑，防御性拒绝）；
 *   ④ 插入点 = 该段落**当前末尾**（`start === 段长 - replacement.length`；
 *      段长取自提交后的 Core 文档，UTF-16 口径与 op 一致）；
 *   ⑤ 位移行与 unit 成员行**同页**（跨页推挤未授权；成员行页面不可判定 ⇒
 *      fail-closed）。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *   · 本模块**零依赖**（无 Core / 无 PDF / 无 DOM），只做判定；
 *   · 判定只信「事务身份 + 结构位置」，**绝不**用最终文本/diff/几何反推场景
 *     （那会把模型误差误判成用户编辑，与 D-3B-0 的 changedLineIds 同纪律）；
 *   · 不满足 ⇒ `unsupported` + 明确 reason（调用方必须整体不登记计划，
 *     导出侧随之回到既有路径，绝不半授权）。
 */

/**
 * 重绘场景分类（封闭集合）
 *
 * D-3B-6（2026-10-15）：新增 `d2-paragraph-middle-insertion`（段落内部插入）。
 * ★ 2026-10-19（用户缺陷「导出 PDF 中修改过的段落都是空白」）：新增
 *   `replaced-range`（区间替换 / 删除）。此前替换/删除落 unsupported ⇒ 计划
 *   不参与重绘，但 **drop 投影（before/after diff）仍会剥离被编辑 run 的原算子**
 *   ⇒ 导出 PDF「清了却没人画」⇒ 修改过的段落整段空白（用户截图实测）。
 *   flow 管线（computeFlowLayout + LCS 身份投影）对任意行内替换/删除均可计算
 *   ⇒ 授权扩大到本场景；**真实 PDF 验收见 dlv.spec（"16 天"替换场景逐字验证）**。
 */
export type ExportRedrawScenario =
  | "d1-paragraph-append"
  | "d2-paragraph-middle-insertion"
  | "replaced-range"
  | "unsupported";

/**
 * 唯一被授权进入「原算子清除 + 重绘」链的场景（历史契约，单测 S4/S25 钉住）。
 *
 * ⚠️ 新增场景（如删除/替换）必须**各自通过真实 PDF 验收**后才能加入，
 *    且必须同步更新本常量 + 单测 + 案例文档；禁止为「让测试绿」而放宽。
 */
export const EXPORT_REDRAW_AUTHORIZED_SCENARIO: ExportRedrawScenario = "d1-paragraph-append";

/**
 * 授权**集合**（D1 段末追加 + D2 段内插入 + 区间替换/删除），供调用方判等。
 *
 * ⚠️ 与上面的单数常量**并存**：单数常量是 D-3B-5 的历史契约，不得删除；
 *    调用方一律用本集合判等。
 * ⚠️ 合并（multi-operation）/ 跨页推挤 / 无意义编辑仍不授权。
 */
export const EXPORT_REDRAW_AUTHORIZED_SCENARIOS: readonly ExportRedrawScenario[] = [
  "d1-paragraph-append",
  "d2-paragraph-middle-insertion",
  "replaced-range",
];

/** 拒绝原因（可观测；detail 给人，reason 给程序/测试） */
export type ExportRedrawScenarioRejectReason =
  | "member-page-unresolved"
  | "cross-page-displacement"
  | "no-operation"
  | "multi-operation"
  | "replaced-range"
  | "empty-replacement"
  | "paragraph-length-unknown"
  | "not-at-paragraph-end"
  | "paragraph-not-member"
  | "insertion-not-inside-paragraph";

/** 事务 op 的结构投影（与 Core `UnitTransactionOperation` 同形，刻意解耦） */
export interface ExportRedrawScenarioOperation {
  readonly paragraphId: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly replacement: string;
}

export interface ExportRedrawScenarioInput {
  /** 事务的**全部** operations（顺序即 Core 执行顺序） */
  readonly operations: readonly ExportRedrawScenarioOperation[];
  /**
   * 段落当前（提交后）UTF-16 长度。
   * 查不到 ⇒ null ⇒ fail-closed（`paragraph-length-unknown`）。
   */
  readonly paragraphLengthOf: (paragraphId: string) => number | null;
  /** unit 成员行 lineId（页面归属判定的基准） */
  readonly memberLineIds: readonly string[];
  /**
   * unit 成员段落 ID（契约 §3 条件 5：`paragraph-not-member` 判定所需）。
   * D-3B-6 步骤 1 新增；调用方（PDFEditor）接入属步骤 3 —— 本步骤不改调用方，
   * 因此在步骤 3 之前 PDFEditor 调用点会缺该必填字段（预期的中间态）。
   */
  readonly memberParagraphIds: readonly string[];
  /** 被流推进的位移行 lineId（必须与成员同页） */
  readonly displacedLineIds: readonly string[];
  /** lineId → legacy 页码（0-based）；不可判定 ⇒ null ⇒ fail-closed */
  readonly pageIndexOf: (lineId: string) => number | null;
}

export interface ExportRedrawScenarioResult {
  readonly scenario: ExportRedrawScenario;
  /** scenario === "unsupported" 时的原因码；授权时为 null */
  readonly reason: ExportRedrawScenarioRejectReason | null;
  /** 人可读细节（日志/取证用） */
  readonly detail: string;
  /** 授权时被追加文本的段落；否则 null */
  readonly appendParagraphId: string | null;
}

function unsupported(
  reason: ExportRedrawScenarioRejectReason,
  detail: string,
): ExportRedrawScenarioResult {
  return { scenario: "unsupported", reason, detail, appendParagraphId: null };
}

/** 页面归属判定：成员行必须同页且可判定；位移行必须落在成员页 */
function checkPageScope(input: ExportRedrawScenarioInput): ExportRedrawScenarioResult | null {
  const memberPages = new Set<number | null>();
  for (const id of input.memberLineIds) memberPages.add(input.pageIndexOf(id));
  if (memberPages.size === 0) {
    return unsupported("member-page-unresolved", "unit 无成员行（页面归属无从判定）");
  }
  if (memberPages.size > 1 || memberPages.has(null)) {
    return unsupported(
      "member-page-unresolved",
      `unit 成员行页面归属不唯一或不可判定（pages=${[...memberPages].join(",")}）⇒ fail-closed`,
    );
  }
  const memberPage = [...memberPages][0] as number;
  for (const id of input.displacedLineIds) {
    const p = input.pageIndexOf(id);
    if (p !== memberPage) {
      return unsupported(
        "cross-page-displacement",
        `位移行 ${id} 在第 ${p ?? "?"} 页，unit 成员在第 ${memberPage} 页 ⇒ 跨页推挤未授权`,
      );
    }
  }
  return null;
}

/**
 * 判定本次 unit 事务是否属于**已授权**的 D1 段落末尾追加场景。
 *
 * 顺序固定（便于归因）：先页面归属，再事务形态，最后段落末尾校验。
 * 纯函数：同样输入永远同样输出；不读写任何外部状态。
 */
export function classifyExportRedrawScenario(
  input: ExportRedrawScenarioInput,
): ExportRedrawScenarioResult {
  const pageReject = checkPageScope(input);
  if (pageReject) return pageReject;

  const ops = input.operations;
  if (ops.length === 0) {
    return unsupported("no-operation", "事务没有任何 operation（无法证明改了哪一段）");
  }
  if (ops.length > 1) {
    return unsupported(
      "multi-operation",
      `事务含 ${ops.length} 条 operation（跨段/合并/多段落流动未授权）：${ops
        .map((o) => o.paragraphId)
        .join(",")}`,
    );
  }
  const op = ops[0]!;
  if (op.startUtf16 !== op.endUtf16) {
    // ★ 2026-10-19（用户缺陷「导出 PDF 修改过的段落整段空白」）：区间替换/删除
    //   升格为**正式授权场景**。此前落 unsupported ⇒ 重绘计划不参与 ⇒ drop 投影
    //   仍剥离被编辑 run 的原算子 ⇒ 导出「清了没人画」⇒ 整段空白。flow 管线
    //   （computeFlowLayout + LCS 身份投影）对行内替换/删除均可计算 ⇒ 授权。
    return {
      scenario: "replaced-range",
      reason: null,
      appendParagraphId: op.paragraphId,
      detail: `区间替换/删除 [${op.startUtf16}, ${op.endUtf16}) → "${op.replacement.slice(0, 12)}"（段落 ${op.paragraphId}）⇒ flow 重排授权`,
    };
  }
  if (op.replacement.length === 0) {
    return unsupported("empty-replacement", "折叠区间 + 空 replacement ⇒ 无意义编辑（防御性拒绝）");
  }
  const length = input.paragraphLengthOf(op.paragraphId);
  if (length === null) {
    return unsupported(
      "paragraph-length-unknown",
      `段落 ${op.paragraphId} 当前长度不可判定 ⇒ fail-closed`,
    );
  }
  // ── D-3B-6：D1 / D2 分流 ──────────────────────────────────────────────
  //   原判据把「非段末插入」一律拒为 not-at-paragraph-end；现按契约 §2/§3 分流：
  //   ★ 时点纪律（契约 §2.5、用户 2026-10-15 锁定）：
  //     · op.startUtf16 属**事务发生前**的原始文本坐标；
  //     · length 为**提交后**段长 ⇒ 必须用它反推 originalLength，
  //       **禁止**直接拿 length 与 startUtf16 比较（会把段末误判成段内）。
  if (!input.memberParagraphIds.includes(op.paragraphId)) {
    return unsupported(
      "paragraph-not-member",
      `段落 ${op.paragraphId} 不属于当前 unit 成员段落 ⇒ fail-closed`,
    );
  }

  const originalLength = length - op.replacement.length;

  if (
    !Number.isInteger(originalLength) ||
    originalLength < 0 ||
    !Number.isInteger(op.startUtf16) ||
    op.startUtf16 < 0
  ) {
    return unsupported(
      "insertion-not-inside-paragraph",
      `无法证明插入点位于原始段落范围内（start=${op.startUtf16}, originalLength=${originalLength}）`,
    );
  }

  // D1：原有段末追加判据保持不变。
  if (op.startUtf16 === originalLength) {
    return {
      scenario: "d1-paragraph-append",
      reason: null,
      detail: `段落 ${op.paragraphId} 末尾追加 ${op.replacement.length} 字符（offset ${op.startUtf16}）`,
      appendParagraphId: op.paragraphId,
    };
  }

  // D2：严格位于原始段落内部，不包括段末。
  if (op.startUtf16 < originalLength) {
    return {
      scenario: "d2-paragraph-middle-insertion",
      reason: null,
      detail: `段落 ${op.paragraphId} 内部插入 ${op.replacement.length} 字符（offset ${op.startUtf16}, originalLength=${originalLength}）`,
      appendParagraphId: op.paragraphId,
    };
  }

  return unsupported(
    "insertion-not-inside-paragraph",
    `插入点 ${op.startUtf16} 超出原始段落内部范围（originalLength=${originalLength}）⇒ fail-closed`,
  );
}
