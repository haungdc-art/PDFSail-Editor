/**
 * logical-paragraph-contract.ts — F3B-6.28 · P0 段落身份与边界契约（contract-only，未接生产）
 *
 * ── 立项背景（F3B-6.27 段落重排 P1 根因定位，2026-10-12）──────────────────
 *
 *   PDF import 粒度 = 1 视觉行 = 1 独立 TextBox（Core paragraph），Core 布局
 *   `layoutTextBox` 按 textBox 独立排版 ⇒ 「跨 textBox 的段落流重排」不存在。
 *   用户编辑 para_43 使其折 2 行后，para_46（下一视觉行）在 Core 布局 / 渲染命令 /
 *   canvas 原字三个层面全部钉死原位置（取证：tests/e2e/_out/para-reflow-forensics/）。
 *
 *   本模块定义 P0 交付物：**哪些 TextBox 属于同一逻辑段落（EditingUnit）** 的
 *   归属契约与边界判定规则。它是 A（跨 textBox 流布局）→ B（EditingUnit 事务）→
 *   C（reconciliation）→ D（导出）共同遵循的唯一段落识别来源——各阶段不得再
 *   发明各自的段落识别规则（用户裁决）。
 *
 * ── 三个概念（用户裁决冻结）──────────────────────────────────────────
 *
 *   · 视觉行（Visual Line）        ：PDF 原始内容流识别出的一行文字。
 *   · 底层编辑单元（TextBox/Paragraph）：当前数据模型的独立布局与编辑对象。
 *   · 逻辑段落（EditingUnit）      ：用户期望一次选中、修改、换行、重排的完整文本范围。
 *
 *   三者不再被视为同一对象。底层 TextBox / paragraphId **保持独立**；逻辑段落是
 *   横跨它们的**归属关系**，不是合并后的新数据结构。
 *
 * ── 判定纪律（用户裁决）──────────────────────────────────────────────
 *
 *   1. **不能仅凭相邻位置合并**。必须有可信归属证据；证据不足 ⇒ `unknown`。
 *   2. **fail-closed**：`unknown` 的行组**不得**开放跨 TextBox 编辑——调用方必须
 *      退回现行单段落（单视觉行）编辑模式。漏合并（保持单行）优于错合并
 *      （把表格单元 / 标题 / 双栏内容错误拼成一段）。
 *   3. 判定必须**可观测**：每个决定都携带 evidence（规则名 + 数值），供 A–D
 *      各阶段与验收复用，不允许黑盒布尔。
 *   4. `paragraphId` 仍是底层结构身份；`lineId` 仅是来源信息。本契约产出的是
 *      **组**（logical paragraph 候选），不是新 id 权威；unit 的持久身份由
 *      B 阶段（EditingUnit 事务）在此基础上定义。
 *   5. 跨页 = 硬边界（本契约不做跨页归属）。
 *
 * ── 证据基础（真实样本 gd-swim-2026.pdf 页 1，p0-block-line-evidence.json）──
 *
 *   页 1 共 21 行（单一页级 block `pdf_p1_block0`），字体 g_d0_f1(标题)/f2(节标题)/f3(正文)：
 *     l3 「广东省体育局、广东省教育厅」      x=183.06 f3
 *     l4 「二、竞赛日期和地点」              x=183.06 f2   ← 节标题（编号+字体变化）
 *     l5 「日期：2026 年 9-12 月（…具体日期以补」x=183.06 f3   ← 行尾无终止标点
 *     l6 「充通知为准）；」                  x=135.00 f3   ← 悬挂续行（x 左移 48px），行尾"；
 *     l7 「地点：茂名市。」                  x=183.06 f3   ← 行尾句号（段终）
 *     l9 「获得规定成绩的…学校、体」          x=183.06 f3
 *     l10「育类校外培训机构等。」             x=135.00 f3   ← 悬挂续行
 *     l13「（一）A 组（20 项）:」             x=183.06
 *     l14「1.男子（10 项）：自由泳（…400」     x=135.00      ← "1." = 新列表项（不同段）
 *     l15「米、1500 米）、…200 米个人混」      x=135.00      ← l14 的悬挂续行
 *     l16「合泳、400 米个人混合泳。」          x=183.06      ← 右移回段首位 ⇒ 证据不足（unknown）
 *
 *   ★ **行距不可作为本样本的判定证据**：软换行行距（l5→l6 gap 46.8px）与段落间距
 *     （l6→l7 gap 48.6px）仅差 3.8% ⇒ 记录观测但不参与判定（见 GAP 声明）。
 */

import type { EditableLine } from "../../document-model/types";
// ★ F3B-6.28：表格行识别（等距列判据）⇒ 表格行不参与跨行合并
import { detectTableCells } from "./table-cell-contract";

// ─────────────────────────────────────────────────────────────────────
// 特征
// ─────────────────────────────────────────────────────────────────────

/** 参与段落归属判定的单行特征（只含判定所需最小字段） */
export interface LogicalLineFeature {
  /** 来源 lineId（仅来源信息，不是身份权威） */
  readonly lineId: string;
  /** 来源 blockId（仅来源信息） */
  readonly blockId: string;
  /** 页序（同文档内；跨页 = 硬边界） */
  readonly pageIndex: number;
  /** 行全文（glyphs 按序拼接；供行尾标点 / 行首结构判定） */
  readonly text: string;
  /** 行盒左缘（悬挂缩进 / 列跳变判定的核心几何证据） */
  readonly x: number;
  /** 行盒顶 y（仅观测记录，不参与判定——见行距 GAP 声明） */
  readonly y: number;
  /** 主字号（px；缩进容差的基准。缺失时回退行高，再回退 12） */
  readonly fontSize: number;
  /** 主字体名（字体变化 = 硬边界证据；缺失时跳过该证据） */
  readonly fontName: string | null;
  /**
   * 行盒宽度（px；可选）。用途：**折断行判定**（行右缘贴本页最大右缘 ⇒ 行尾是
   * 软换行折断点，下一行是续行；行不满且行尾无标点 ⇒ 完整短行（标题/条目行），
   * 下一行不并入）。缺失/0 ⇒ 折断行证据不可用（保守跳过）。
   */
  readonly width?: number;
  /**
   * ★ F3B-6.28：该行是否为**表格行**（行内存在等距列 ⇒ 多 cell）。
   *
   * 缺省 `false`/undefined ⇒ 非表格行（既有全部用法）⇒ **行为逐字节不变**。
   *
   * 表格行**不参与任何跨行合并**（见 `decideParagraphBoundary` 的 table-row 守卫）：
   *   真实缺陷（2026-10-20 用户截图）——附件表格的表头两行因「首字 x 大幅左移」
   *   （l9 x=253.26 → l10 x=98.1）命中悬挂缩进规则被合并成一个 unit ⇒ 编辑面
   *   横跨多行、把整行各 cell 文本拼在一起。表格的语义单位是**格子**，
   *   行与行之间**没有**段落归属关系。
   */
  readonly isTableRow?: boolean;
}

/** 从 legacy EditableLine 提取特征（防御式：缺字段不抛错） */
export function lineFeatureFromEditableLine(
  line: EditableLine,
  blockId: string,
  pageIndex: number,
): LogicalLineFeature {
  const text =
    typeof line.text === "string" && line.text.length > 0
      ? line.text
      : (line.glyphs ?? []).map((g) => g.char ?? "").join("");
  const style = line.style as { fontName?: string; fontSize?: number } | undefined;
  const h = line.bbox?.height;
  const fontSize =
    typeof style?.fontSize === "number" && style.fontSize > 0
      ? style.fontSize
      : typeof h === "number" && h > 0
        ? h
        : 12;
  return {
    lineId: line.id,
    blockId,
    pageIndex,
    text,
    x: line.bbox?.x ?? 0,
    y: line.bbox?.y ?? 0,
    fontSize,
    // 折断行判定输入：行盒宽度（缺失/0 ⇒ 证据不可用，保守跳过）
    width: typeof line.bbox?.width === "number" && line.bbox.width > 0 ? line.bbox.width : undefined,
    // ★ 真实字段 = style.fontFamily（CSS 映射；实测 gd-swim 全行为
    //   "Arial, Helvetica, sans-serif" ⇒ 字体证据在本粒度不可区分标题/正文
    //   ⇒ 相邻判定落 unknown（保守漏合并，方向安全）。
    //   PDF 原始字体（g_d0_f1/f2/f3）在 glyph 级 styleRef，legacy style 未承载
    //   ——恢复该证据属后续改进（不阻塞 B：用户目标段 l5+l6 判定不受影响）。
    fontName:
      typeof style?.fontFamily === "string" && style.fontFamily.length > 0
        ? style.fontFamily
        : typeof (style as any)?.fontName === "string" && (style as any).fontName
          ? (style as any).fontName
          : null,
    // ★ F3B-6.28：表格行识别（行内等距列 ⇒ 多 cell）⇒ 表格行不参与跨行合并
    isTableRow: isTableRowOfLine(line),
  };
}

/**
 * 该 legacy 行是否为表格行（纯判定；失败 ⇒ false = 非表格行，方向安全）。
 * 判据见 `table-cell-contract`（等距列序列 + 列间隙宽度 ≥ 0.6×行字号）。
 */
function isTableRowOfLine(line: EditableLine): boolean {
  const glyphs = line.glyphs ?? [];
  if (glyphs.length === 0) return false;
  try {
    const style = line.style as { fontSize?: number } | undefined;
    const h = line.bbox?.height;
    const fontSize =
      typeof style?.fontSize === "number" && style.fontSize > 0
        ? style.fontSize
        : typeof h === "number" && h > 0
          ? h
          : undefined;
    return detectTableCells(
      glyphs.map((g) => ({ char: g.char ?? "", bbox: g.bbox })),
      { fontSize },
    ).isTableRow;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 判定
// ─────────────────────────────────────────────────────────────────────

export type BoundaryVerdict = "same-paragraph" | "different-paragraph" | "unknown";

/** 每条判定证据（规则名 + 数值细节），供 A–D 阶段与验收复用 */
export interface BoundaryEvidence {
  readonly rule: string;
  readonly detail: string;
}

export type ParagraphBoundaryDecision =
  | { readonly verdict: "same-paragraph"; readonly evidence: readonly BoundaryEvidence[] }
  | { readonly verdict: "different-paragraph"; readonly evidence: readonly BoundaryEvidence[] }
  | { readonly verdict: "unknown"; readonly evidence: readonly BoundaryEvidence[] };

/** 行尾终止标点：出现 ⇒ 该行结束一个段落（含全角；"；"按本样本语义归终止） */
const TERMINAL_PUNCT = /[。！？；!?…]["」』）)]?$/;
/** 行尾连接标点：出现 ⇒ 强软换行证据（逗号 / 顿号 / 冒号引出下文） */
const CONNECTOR_PUNCT = /[,，、：:]$/;
/** 行首结构分隔符：下一行以这些开头 ⇒ 硬边界（编号 / 中文序号 / 括号序号 / 列表符号） */
const STRUCTURAL_START: RegExp[] = [
  /^\s*\d+(\.\d+)*[.、]\s*/, // "1." / "2.女子" / "1.男子"
  /^\s*[一二三四五六七八九十百]+[、.．]\s*/, // "一、" / "二、"
  /^\s*（\s*[一二三四五六七八九十百]+\s*）\s*/, // "（一）" / "（二）"
  /^\s*\(\s*\d+\s*\)\s*/, // "(1)"
  /^\s*[•·▪‣●○◆]\s*/, // 项目符号
];

function firstMatch(res: RegExp[], s: string): boolean {
  return res.some((re) => re.test(s));
}

/**
 * prev 行尾是否为软换行折断点（排版学判据；2026-10-24 用户缺陷修复）。
 *
 * 判据：**下一行行首的「不可分单元」装不进 prev 行的剩余空间** ⇒ prev 是被
 * 折断的续行上行（贪心换行的定义）。不可分单元 = 含空白文本的首个词 /
 * 无空白文本（CJK）的首个字符。
 *
 * 为何替代旧的「右缘 ≥ 页右缘 − 2×字号」：该容差只覆盖 CJK 逐字折行
 * （剩余 < 1em）；拉丁语系的词宽（5-10 字符 ≈ 3-8×字号）常超 2×字号 ⇒
 * 真实折行行被误判「未排满」⇒ 段落被拆成单行（用户 OCR 简历 PDF 实测：
 * l6 右缘差 10.5px 被拦 ⇒ 3 行段落被拆成 [1 行]+[2 行]，提交后单段路径
 * 的折行/遮罩侵占下一行）。
 *
 * 容差 = max(2×字号, 一个不可分单元宽度)：
 *   · CJK（无空白）⇒ 单字 ≈ 1em ⇒ max = 2em ⇒ 与旧判据**等价**（已验收的
 *     gd-swim 分组行为逐字节保持）；
 *   · 拉丁（有空白）⇒ 首词宽 ⇒ 剩余放不下首词才判「排满」。
 *
 * 宽度估算用 next 行自身平均字宽（契约无 glyph 级度量；缺宽度 ⇒ 回退
 * 字号）。无宽度数据（prev.width 缺失/0、pageRight 缺失、next 空行）⇒
 * `filled=false`（证据不可用，保守跳过——与旧判据 fail-closed 方向一致）。
 */
function prevSoftWrapSlack(
  prev: LogicalLineFeature,
  next: LogicalLineFeature,
  pageRight: number | null,
): { filled: boolean; determinable: boolean; remaining: number; unitWidth: number; tolerance: number } {
  const none = { filled: false, determinable: false, remaining: Number.NaN, unitWidth: 0, tolerance: 0 };
  if (pageRight == null || prev.width == null || prev.width <= 0) return none;
  const remaining = pageRight - (prev.x + prev.width);
  if (!(remaining >= 0)) return none; // NaN 守卫（理论上 remaining ≥ 0：pageRight 为全页最大右缘）
  const nextText = typeof next.text === "string" ? next.text : "";
  const trimmed = nextText.trim();
  if (trimmed.length === 0) return { ...none, remaining };
  const firstWord = trimmed.match(/^\S+/);
  // 不可分单元字符数：含空白 ⇒ 首词；无空白（CJK 逐字折行）⇒ 1 字符
  const unitChars = firstWord && /\s/.test(trimmed) ? [...firstWord[0]].length : 1;
  const avgCharW =
    next.width != null && next.width > 0 && nextText.length > 0 ? next.width / nextText.length : next.fontSize;
  const unitWidth = unitChars * avgCharW;
  const tolerance = Math.max(prev.fontSize * 2, unitWidth);
  return { filled: remaining <= tolerance, determinable: true, remaining, unitWidth, tolerance };
}

/**
 * 文档级悬挂缩进位检测（第二遍全局统计——比成对猜测更强的归属证据）。
 *
 *   真实样本（gd-swim 页 1）：正文段首 x=183.06 出现 12 次；悬挂续行 x=135.00
 *   出现 6 次（l6/l10/l14/l15/…）⇒ 135 是**文档级续行位**。
 *
 * 判定：出现次数 ≥2 且显著小于中位 x（> 0.5×字号）⇒ 悬挂缩进位。
 * ⚠️ 已知保守限制：整列等 x 的简单表格列同样会命中该证据（列 x 与列表续行位
 *    在几何上不可区分）——该歧义如实声明，不做内容级猜测。
 */
export function detectHangingIndentXs(
  features: readonly LogicalLineFeature[],
): number[] {
  if (features.length < 3) return [];
  const xs = features.map((f) => f.x).slice().sort((a, b) => a - b);
  const median = xs[Math.floor(xs.length / 2)]!;
  const tol = Math.max((features[0]?.fontSize ?? 12) * 0.5, 4);
  const counts = new Map<number, number>();
  for (const f of features) {
    const key = Math.round(f.x * 100) / 100;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: number[] = [];
  for (const [x, n] of counts) {
    if (n >= 2 && x < median - tol) out.push(x);
  }
  return out.sort((a, b) => a - b);
}

/**
 * 相邻两行（按阅读顺序 prev → next）是否属于同一逻辑段落。
 *
 * 判定顺序即优先级：任何硬边界证据立即返回 different-paragraph；
 * 任何正向归属证据立即返回 same-paragraph；否则 unknown（fail-closed）。
 *
 * @param opts.hangingXs 文档级悬挂缩进位（`detectHangingIndentXs` 的产出）。
 *   供给后：next 行落在续行位（且不右移于 prev）⇒ same（悬挂缩进链的
 *   中间行——l14→l15 同 x=135——靠该证据合并，紧邻左移规则覆盖不到）。
 */
export function decideParagraphBoundary(
  prev: LogicalLineFeature,
  next: LogicalLineFeature,
  opts?: { readonly hangingXs?: readonly number[]; readonly flushX?: number | null; readonly pageRight?: number | null },
): ParagraphBoundaryDecision {
  const ev: BoundaryEvidence[] = [];

  // 1. 跨页 = 硬边界（不做跨页归属）
  if (prev.pageIndex !== next.pageIndex) {
    ev.push({ rule: "cross-page", detail: `pageIndex ${prev.pageIndex} → ${next.pageIndex}` });
    return { verdict: "different-paragraph", evidence: ev };
  }

  // 2. 下一行行首结构分隔符（编号 / 中文序号 / 括号序号 / 列表符号）
  if (firstMatch(STRUCTURAL_START, next.text)) {
    ev.push({ rule: "structural-marker", detail: `next 行首命中结构分隔符: ${JSON.stringify(next.text.slice(0, 12))}` });
    return { verdict: "different-paragraph", evidence: ev };
  }

  // 3. prev 行尾终止标点 ⇒ 当前段落结束
  if (TERMINAL_PUNCT.test(prev.text)) {
    ev.push({ rule: "terminal-punctuation", detail: `prev 行尾终止标点: ${JSON.stringify(prev.text.slice(-4))}` });
    return { verdict: "different-paragraph", evidence: ev };
  }

  // 4. 字体 / 字号变化（双方都有值时）——标题 vs 正文的强边界（l4 f2 → l5 f3）
  if (prev.fontName !== null && next.fontName !== null && prev.fontName !== next.fontName) {
    ev.push({ rule: "font-change", detail: `fontName ${prev.fontName} → ${next.fontName}` });
    return { verdict: "different-paragraph", evidence: ev };
  }
  if (prev.fontSize > 0 && next.fontSize > 0) {
    const fr = Math.abs(next.fontSize - prev.fontSize) / Math.max(prev.fontSize, next.fontSize);
    if (fr > 0.2) {
      ev.push({ rule: "font-size-change", detail: `fontSize ${prev.fontSize.toFixed(2)} → ${next.fontSize.toFixed(2)}（差 ${(fr * 100).toFixed(1)}%）` });
      return { verdict: "different-paragraph", evidence: ev };
    }
  }

  // 5. x 右移大跳（> 4×字号 ≈ 半栏）⇒ 新列 / 双栏（不能合并）
  const dx = next.x - prev.x;
  if (dx > next.fontSize * 4) {
    ev.push({ rule: "large-x-shift", detail: `next.x - prev.x = ${dx.toFixed(2)} > 4×fontSize(${next.fontSize.toFixed(2)})` });
    return { verdict: "different-paragraph", evidence: ev };
  }

  // 5.5 ★ F3B-6.28：表格行**不参与跨行合并**（表格的语义单位是「格子」，
  //     行与行之间没有段落归属关系）。
  //     真实缺陷（2026-10-20 用户截图）：附件表格的表头两行（l9 x=253.26 →
  //     l10 x=98.1）因「首字 x 大幅左移」命中规则 6 悬挂缩进被合并成一个 unit
  //     ⇒ 编辑面横跨多行、并把整行各 cell 文本拼在一起。
  //     fail-closed：判定为 unknown（拆组）⇒ 表格行走单行编辑路径。
  if (prev.isTableRow === true || next.isTableRow === true) {
    ev.push({
      rule: "table-row-not-merged",
      detail: `表格行不参与跨行合并（prev.isTableRow=${prev.isTableRow === true} / next.isTableRow=${next.isTableRow === true}）`,
    });
    return { verdict: "unknown", evidence: ev };
  }

  // 6. 悬挂续行：next.x 显著左移（真实样本 48px ≈ 2.24×字号）——最强几何归属证据；
  //    或 next 行落在文档级悬挂缩进位（覆盖悬挂链的中间行：l14→l15 同 x=135）。
  //    ★ 2026-10-24（用户缺陷「联系信息行与节标题被误合并」）：**纵向上界**——
  //      两行间距 > 3×字号 ⇒ 中间存在空行/分节间隔，x 左移不再是续行证据。
  //      实测：Gabriel CV 联系行 x=152.2 → 节标题 "|Qualificações" x=114.2
  //      （dx=−38 命中本规则）但 dy=99.7 ≈ 6.2×字号 ⇒ 误合并，编辑面吞掉标题行
  //      （unit 文本 = "联系行\n|Qualificações"，面高 202px）。
  //      **不设下界**：紧排续行（dy ≈ 1.2×字号，Gabriel 第 2 页实测 21.4px/18px）
  //      是合法合并，设下界会将其拆开（新缺陷）。
  //      标定：gd-swim 全量 47 个本规则边界 dy/fs = 1.95–1.96（< 3 ⇒ 零波及）。
  //      超界时本规则**静默跳过**（不 return）⇒ 由 7.5 的同窗口判据兜底拒绝
  //      ⇒ unknown（fail-closed 拆组），绝不伪造 different-paragraph 硬边界。
  //    ★ 2026-10-24 第二轮（用户缺陷「不是一个段落的两行被识别成一段」）：**prev 行
  //      排满前提**——悬挂缩进的排版学定义是「prev 是缩进的首行且文本折行到 next」
  //      ⇒ prev 行必然排满（右缘贴近页右缘）。prev 行**确定未排满**（右缘距页右缘
  //      远超容差）⇒ x 左移不构成续行证据。真实误合并形态（Gabriel CV 实测）：
  //      ① 居中排版：短行 "Brasileiro, solteiro, 25 anos"（x=337.9，右缘 555 距页右缘
  //        765 剩余 210px）→ 居中宽行 "Rua Santa Rita…"（x=158.8）⇒ dx=−179 命中旧规则；
  //      ② 折行尾行后的新段落：短行 "2020."（x=181.6，宽 45px）→ 顶格段首
  //        "Participou…"（x=127.58）⇒ dx=−54 命中旧规则 ⇒ 4 行假段落；
  //      ③ 节标题吞并："● Informática…"（短）→ "|Formação acadêmica"（悬挂位）
  //        ⇒ 6 行假段落（标题+正文+下一标题全部拼接）。
  //      **判定不可用**（prev.width 缺失 / pageRight 缺失）⇒ 保持既有行为（不收紧
  //      ——缺证据时不得改变已验收行为）。与纵向上界同款：拒绝时本规则**静默跳过**
  //      （携带 rejected 证据供观测）⇒ 由 7.5/unknown 兜底，绝不伪造 different。
  const tol = Math.max(next.fontSize * 0.5, 4);
  const hangingXs = opts?.hangingXs ?? [];
  const atHangingX = hangingXs.some((hx) => Math.abs(next.x - hx) <= 2);
  const hangingLinePitchOk = next.y - prev.y <= Math.max(prev.fontSize, next.fontSize) * 3;
  const pageRight = opts?.pageRight ?? null;
  const wrap = prevSoftWrapSlack(prev, next, pageRight);
  const rule6PrevFullOk = !wrap.determinable || wrap.filled;
  const rule6DedentHit = next.x < prev.x - tol && hangingLinePitchOk;
  const rule6PositionHit = atHangingX && next.x <= prev.x + tol && hangingLinePitchOk;
  if ((rule6DedentHit || rule6PositionHit) && !rule6PrevFullOk) {
    ev.push({
      rule: "hanging-indent-rejected-prev-not-full",
      detail: `prev 右缘 ${(prev.x + (prev.width ?? 0)).toFixed(2)} 距页右缘(${pageRight!.toFixed(2)})剩余 ${wrap.remaining.toFixed(2)} > 容差 ${wrap.tolerance.toFixed(2)} ⇒ prev 行确定未排满（非折断行）⇒ x 左移不构成悬挂续行证据`,
    });
  }
  if (rule6DedentHit && rule6PrevFullOk) {
    ev.push({ rule: "hanging-indent", detail: `next.x(${next.x.toFixed(2)}) < prev.x(${prev.x.toFixed(2)}) − ${tol.toFixed(2)}` });
    return { verdict: "same-paragraph", evidence: ev };
  }
  if (rule6PositionHit && rule6PrevFullOk) {
    ev.push({ rule: "hanging-indent-position", detail: `next.x(${next.x.toFixed(2)}) ≈ 文档级悬挂缩进位 [${hangingXs.map((h) => h.toFixed(2)).join(", ")}] 且未右移于 prev.x(${prev.x.toFixed(2)})` });
    return { verdict: "same-paragraph", evidence: ev };
  }

  // 7. prev 行尾连接标点（，、：）⇒ 强软换行证据
  if (CONNECTOR_PUNCT.test(prev.text)) {
    ev.push({ rule: "connector-punctuation", detail: `prev 行尾连接标点: ${JSON.stringify(prev.text.slice(-2))}` });
    return { verdict: "same-paragraph", evidence: ev };
  }

  // 7.5 顶格续行（2026-10-19 用户缺陷「5 行段落只识别出 2 行」）：next 落在**本页顶格位**
  //    （该页行 x 的众数 = 续行统一左缘）+ 同缩进（|Δx| ≤ tol）+ 纵向连续（Δy ∈
  //    [1.4×fontSize, 3×fontSize] 正常行距带，排除空行分段的顶格段）⇒ 同段续行。
  //    中文正文「每段首行缩进、续行顶格」排版下：段落首行已被规则 2（结构分隔符）/
  //    悬挂缩进（规则 6）识别，**连续顶格且 prev 行尾无终止标点**（规则 3 已排除）、
  //    next 行首无结构分隔符（规则 2 已排除）的相邻行几乎必然同段。旧行为此处落
  //    unknown（fail-closed 拆组）⇒ 用户段落被拆成 1 行/段（实测 gd-swim 第 2 页
    //    「4.女子全能」段 5 行 → [2 行] + [1] + [1] + [1]）。
  //    ★ 顶格位 = **单页行 x 众数**（detectFlushX）：第 2 页众数 = 121.1（续行位）⇒
  //      命中；第 1 页众数 = 164.2（首行位，首行数多于续行）⇒ 第 1 页的缩进行
  //      （121.1）**不**命中 ⇒ 已验收的分组行为逐字节保持（回归零波及）。
  //    误合并面：落在顶格位上的独立短行（署名/地址类）——编辑粒度变粗、不丢失
  //    数据，优于按行拆散。
  const dy = next.y - prev.y;
  const flushX = opts?.flushX ?? null;
  // ★ 折断行判定（2026-10-24 用户缺陷修复：拉丁语系文档段落被拆成单行）：
  //   prev 行尾是软换行折断点 ⟺ **下一行行首的「不可分单元」装不进 prev 行的
  //   剩余空间**（贪心换行的排版学定义）。不可分单元 = 含空白文本的首个词 /
  //   无空白文本（CJK）的首个字符。
  //   旧判据「右缘 ≥ 页右缘 − 2×字号」只覆盖 CJK 逐字折行（剩余 < 1em）；
  //   拉丁语系的词宽（5-10 字符 ≈ 3-8×字号）常超 2×字号 ⇒ 真实折行行被误判
  //   「未排满」⇒ 段落被拆成单行（用户 OCR 简历 PDF 实测：l6 右缘差 10.5px
  //   被拦 ⇒「Pretendo inovar…」3 行段落被拆成 [1 行]+[2 行]）。
  //   容差 = max(2×字号（CJK 既有口径）, 一个不可分单元宽度)：
  //   · CJK（无空白）⇒ 单字 ≈ 1em ⇒ max = 2em ⇒ 与旧判据等价（回归零波及）；
  //   · 拉丁（有空白）⇒ 首词宽 ⇒ 剩余放不下首词才判「排满」。
  //   宽度估算用 next 行自身平均字宽（契约无 glyph 级度量；方向保守）。
  //   （wrap 已在规则 6 前计算——两个规则共用同一折断行判定，口径唯一。）
  const prevFilled = wrap.filled;
  if (
    flushX != null &&
    Math.abs(next.x - flushX) <= 2 &&
    Math.abs(dx) <= tol &&
    dy >= next.fontSize * 1.4 &&
    dy <= next.fontSize * 3
  ) {
    if (prevFilled) {
      ev.push({
        rule: "flush-continuation",
        detail: `next.x(${next.x.toFixed(2)}) ≈ 本页顶格位(${flushX.toFixed(2)}) + 同缩进（Δx=${dx.toFixed(2)}）+ 纵向连续（Δy=${dy.toFixed(2)} ∈ 行距带）+ prev 行排满（剩余 ${wrap.remaining.toFixed(2)} ≤ 容差 ${wrap.tolerance.toFixed(2)}，首单元宽 ${wrap.unitWidth.toFixed(2)}）⇒ 折断行续行`,
      });
      return { verdict: "same-paragraph", evidence: ev };
    }
    // prev 行未排满 ⇒ 完整短行（标题/条目行）——即便其余几何全同也不并入
    // （fail-closed 维持 unknown：宁可拆组，不猜合并）。
  }

  // 8. 证据不足 ⇒ unknown（fail-closed：调用方必须退回单段落编辑，不得猜测）
  ev.push({
    rule: "insufficient-evidence",
    detail: `同缩进且行尾无标点（Δx=${dx.toFixed(2)}）；邻接位置本身不构成归属证据`,
  });
  return { verdict: "unknown", evidence: ev };
}

// ─────────────────────────────────────────────────────────────────────
// 分组
// ─────────────────────────────────────────────────────────────────────

/** 一个逻辑段落候选。confirmed=false ⇒ 不得开放跨 TextBox 编辑（fail-closed）。 */
export interface LogicalParagraphGroup {
  /** 组内行（阅读顺序） */
  readonly lines: readonly LogicalLineFeature[];
  /** 全部相邻边界均有正向归属证据（same-paragraph） */
  readonly confirmed: boolean;
  /** 相邻边界判定记录（与 lines 等长减一；单行组为空） */
  readonly boundaries: readonly ParagraphBoundaryDecision[];
  /**
   * 本组与**前一组**之间的边界判定（首个组无此字段）。
   * `unknown` ⇒ 本组首行是「证据不足拆分」产物（可观测：调用方知道这里
   * 本可能合并但证据不足；消费语义仍是单行编辑）。
   */
  readonly separatedFromPrev?: ParagraphBoundaryDecision;
}

/**
 * 顶格位检测（2026-10-19 顶格续行规则的配套输入）：本页行 x 的**众数**（最多行
 * 共享的左缘，2px 聚类）。「每段首行缩进、续行顶格」排版下众数 = 续行统一左缘；
 * 若首行数多于续行（短段落多的页），众数 = 首行位 ⇒ 缩进续行**不**命中
 * ⇒ 已验收页的分组行为保持（回归零波及）。行数 < 2 ⇒ null（无统计意义）。
 */
export function detectFlushX(
  features: readonly LogicalLineFeature[],
): number | null {
  if (features.length < 2) return null;
  const counts = new Map<number, number>();
  for (const f of features) {
    let matched = false;
    for (const k of counts.keys()) {
      if (Math.abs(k - f.x) <= 2) {
        counts.set(k, (counts.get(k) ?? 0) + 1);
        matched = true;
        break;
      }
    }
    if (!matched) counts.set(f.x, 1);
  }
  let best: number | null = null;
  let bestN = 1;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

/**
 * 把同一文档的行序列（按阅读顺序）分组为逻辑段落候选。
 *
 * - different-paragraph / unknown 都会开新组：unknown 组 `confirmed=false`，
 *   调用方必须按 fail-closed 处理（退回单行编辑），绝不猜测合并。
 * - 单行组天然 confirmed（无需跨行证据）。
 */
export function groupLogicalParagraphs(
  features: readonly LogicalLineFeature[],
): LogicalParagraphGroup[] {
  const hangingXs = detectHangingIndentXs(features);
  const flushX = detectFlushX(features);
  // 页右缘 = 全部带宽度行中最大的右缘（折断行判定的基准；无宽度数据 ⇒ null）
  let pageRight: number | null = null;
  for (const f of features) {
    if (!f.width || f.width <= 0) continue;
    const right = f.x + f.width;
    if (pageRight === null || right > pageRight) pageRight = right;
  }
  const groups: LogicalParagraphGroup[] = [];
  let current: LogicalLineFeature[] = [];
  let boundaries: ParagraphBoundaryDecision[] = [];
  let confirmed = true;
  let separatedFromPrev: ParagraphBoundaryDecision | undefined;

  const flush = () => {
    if (current.length === 0) return;
    groups.push(
      separatedFromPrev !== undefined
        ? { lines: current, confirmed, boundaries, separatedFromPrev }
        : { lines: current, confirmed, boundaries },
    );
    current = [];
    boundaries = [];
    confirmed = true;
    separatedFromPrev = undefined;
  };

  for (const f of features) {
    if (current.length === 0) {
      current.push(f);
      continue;
    }
    const prev = current[current.length - 1]!;
    const d = decideParagraphBoundary(prev, f, { hangingXs, flushX, pageRight });
    if (d.verdict === "same-paragraph") {
      boundaries.push(d);
      current.push(f);
      continue;
    }
    // different / unknown ⇒ 开新组。unknown 边界的语义 = **拒绝合并**（退回单行
    // 编辑），因此不产生任何跨行组；新组从单行开始（单行天然 confirmed）。
    // unknown 判定经 `separatedFromPrev` 保留（可观测：调用方知道这里证据不足）。
    flush();
    current.push(f);
    separatedFromPrev = d;
  }
  flush();
  return groups;
}
