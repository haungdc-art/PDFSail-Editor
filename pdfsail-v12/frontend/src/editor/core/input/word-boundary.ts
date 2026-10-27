/**
 * editor/core/input/word-boundary.ts — E-C5-2 Word Boundary Primitive（F3B-6.21-F2）
 *
 * ── 职责（只做一件事）────────────────────────────────────────────────
 *   给定「段落纯文本 + 段落内 UTF-16 offset + 方向」⇒ 返回该方向上的
 *   **一个 Word 的 UTF-16 半开区间 `[start, end)`**。
 *
 * ── 契约来源（不新发明语义）─────────────────────────────────────────
 *   `docs/Word-Boundary-Design.md`：
 *     · `:11-14` 最高原则 —— 目标不是语言学正确，而是**编辑行为符合用户预期**；
 *       不做 NLP / Unicode / ICU 分词。
 *     · `:88`   `你好世界` → CJK **连续段**（V1）。（6.21-F 裁决 A：采用连续段，
 *       **不对齐** Chromium 的 ICU 分词 —— 浏览器原生只删 `世界`，见 F1 §8。）
 *     · `:50`   内部连接符只有**两侧紧邻词字符**时才并入同一 Word。
 *     · `:39-47` Word 清单：`can't` / `PDF-Editor` / `10.5MB` / `10%` / `$100` /
 *       `￥100` / `€100` / `hello@example.com` / `https://example.com`。
 *     · `:56-58` 一定断开：space / tab / newline / `, ; : ( ) [ ] { }`。
 *
 * ── 与浏览器的关系（F1 的结论）──────────────────────────────────────
 *   浏览器只提供 **event intent**（`deleteWordBackward` / `deleteWordForward`），
 *   **不提供** `[startUtf16, endUtf16)`。因此这里**不是**复刻 Chromium 的分词结果，
 *   而是把 intent 交给**本仓库自己的 Word Boundary 契约**判定。
 *
 * ── 代理对 / emoji 安全（裁决 2 的直接收益）─────────────────────────
 *   所有位移一律走 `stepBack` / `stepForward`（`code-point.ts` 的**唯一实现**），
 *   分类也按 **code point**（而非 UTF-16 unit）进行
 *   ⇒ 区间端点**永远落在 code point 边界**，不可能切出 lone surrogate。
 */

import { stepBack, stepForward } from "./code-point";

/** 字符分类（docs/Word-Boundary-Design.md:97） */
export type WordCharClass =
  /** 词字符：LETTER / DIGIT / MARK（含 CJK，见 `:97` 与 `:88`） */
  | "word"
  /** 连接符：`- ' . _ : / @ %` 与货币符号 —— **条件性**并入 */
  | "connector"
  /** 边界符：space / tab / newline / `, ; ( ) [ ] { }` / 引号 / emoji … */
  | "boundary";

const WORD_RE = /[\p{L}\p{N}\p{M}]/u;
const CONNECTOR_RE = /[-'._:/@%\p{Sc}]/u;
const CURRENCY_RE = /\p{Sc}/u;
/**
 * 后缀型连接符：**左侧**是词字符即可并入（右侧可以什么都没有）。
 *   · `%` / `‰` … → `10%`（doc A 清单）
 *   · `.`         → `U.S.A.`（doc C：V1 接受「整体作为一个 Word」的近似）
 */
const SUFFIX_CONNECTORS = new Set(["%", "％", "‰", "‱", "."]);

/** 空白（space / tab / newline …）—— **与标点区分对待**：见 `wordRangeAt` 的规则 */
function isWhitespace(codePoint: number): boolean {
  return /\s/u.test(String.fromCodePoint(codePoint));
}

export function classifyWordChar(codePoint: number): WordCharClass {
  const ch = String.fromCodePoint(codePoint);
  if (WORD_RE.test(ch)) return "word";
  if (CONNECTOR_RE.test(ch)) return "connector";
  return "boundary";
}

/** 一个 Word 的 UTF-16 半开区间（**段落内**坐标） */
export interface WordRange {
  start: number;
  end: number;
}

export type WordDirection = "backward" | "forward";

/** 取 `[start, end)` 处那一个 code point 的分类 */
function classAt(text: string, start: number, end: number): WordCharClass {
  const cp = text.codePointAt(start);
  return cp === undefined ? "boundary" : classifyWordChar(cp);
}

/**
 * 从 `from` 起**跳过连续连接符**，判断该侧是否存在词字符。
 *
 * 用于支持 `https://example.com` 这类「连接符链」：`:` 的右侧不是直接词字符，
 * 而是另一个连接符 `/`，但它们整体仍夹在两个词之间。
 */
function hasWordBeyond(text: string, from: number, direction: WordDirection): boolean {
  let i = from;
  while (direction === "forward" ? i < text.length : i > 0) {
    const start = direction === "forward" ? i : stepBack(text, i);
    const end = direction === "forward" ? stepForward(text, i) : i;
    const cls = classAt(text, start, end);
    if (cls === "word") return true;
    if (cls === "connector") {
      i = direction === "forward" ? end : start;
      continue;
    }
    return false;
  }
  return false;
}

/**
 * 连接符是否并入当前 Word。
 *
 * 三条规则（全部来自 `docs/Word-Boundary-Design.md` 的验收表，非自由发挥）：
 *   1. 两侧都是词字符（`can't` / `10.5MB` / `hello@example.com` / URL 连接符链）
 *   2. **货币符号 + 右侧是词字符**（`$100` / `￥100` / `€100`：前置货币并入）
 *   3. **后缀型（`.` / `%`）+ 左侧是词字符**（`10%` / `U.S.A.`：doc C 明确接受该近似）
 *
 * ⇒ `word - word` 的 `-`（两侧是空格）**不**并入（规则 1 不成立）。
 */
export function isJoinableConnector(text: string, start: number, end: number): boolean {
  const cp = text.codePointAt(start);
  if (cp === undefined || classifyWordChar(cp) !== "connector") return false;
  const right = hasWordBeyond(text, end, "forward");
  const left = hasWordBeyond(text, start, "backward");
  if (left && right) return true;
  const ch = String.fromCodePoint(cp);
  if (CURRENCY_RE.test(ch) && right) return true;
  if (SUFFIX_CONNECTORS.has(ch) && left) return true;
  return false;
}

/** 是否并入当前 Word（`word` 直接并入；`connector` 需满足条件） */
function belongsToWord(text: string, start: number, end: number): boolean {
  const cls = classAt(text, start, end);
  return cls === "word" || (cls === "connector" && isJoinableConnector(text, start, end));
}

/**
 * 段落纯文本 → 指定方向上的一个 Word 区间（UTF-16）。
 *
 * - `backward`：删除**光标之前**的词（跳过紧贴的空白/边界符）
 * - `forward` ：删除**光标之后**的词（跳过紧贴的空白/边界符）
 * - 该方向上没有 Word ⇒ 返回 `null`（调用方应判为 no-op，**不得**猜）
 *
 * ★ CJK 连续段：`你好世界` + backward ⇒ `[0, 4)`（整段），与双击语义一致（裁决 A）。
 * ★ emoji：`hello 😀 world` + backward ⇒ 只删 `world`，emoji 属于**边界符**，
 *   且 emoji 自身是**完整 code point**，端点不会落在代理对中间。
 */
export function wordRangeAt(
  text: string,
  offset: number,
  direction: WordDirection
): WordRange | null {
  return direction === "forward"
    ? forwardWordRange(text, offset)
    : backwardWordRange(text, offset);
}

/**
 * 把 offset 收敛到 **code point 边界**。
 *
 * 正常 caret 不会落在代理对中间，但外部传入的 offset 可能越界/切半；
 * 若不做收敛，`[start,end)` 就会切出 lone surrogate（F2 的硬门之一）。
 */
function snapToCodePoint(text: string, offset: number): number {
  const i = Math.max(0, Math.min(offset, text.length));
  if (i <= 0 || i >= text.length) return i;
  const cp = text.codePointAt(i);
  // 落在 low surrogate 上 ⇒ 处于代理对中间 ⇒ 退到该 code point 起点
  return cp !== undefined && cp >= 0xdc00 && cp <= 0xdfff ? stepBack(text, i) : i;
}

/** 标点（非空白、非词）—— 自成一个删除单元（与 Chromium/ICU 的分段一致） */
function isPunctuation(text: string, start: number, end: number): boolean {
  if (belongsToWord(text, start, end)) return false;
  const cp = text.codePointAt(start);
  return cp !== undefined && !isWhitespace(cp);
}

function forwardWordRange(text: string, offset: number): WordRange | null {
  const original = snapToCodePoint(text, offset);
  let i = original;
  // ① 跳过紧贴的**空白**（这些空白随本次删除一起消失）
  while (i < text.length && belongsToWhitespace(text, i, stepForward(text, i))) {
    i = stepForward(text, i);
  }
  if (i >= text.length) return null;
  // ② 词 → 词 run；标点 → 标点 run（各成一个删除单元）
  if (belongsToWord(text, i, stepForward(text, i))) {
    while (i < text.length && belongsToWord(text, i, stepForward(text, i))) {
      i = stepForward(text, i);
    }
  } else {
    while (i < text.length && isPunctuation(text, i, stepForward(text, i))) {
      i = stepForward(text, i);
    }
  }
  return { start: original, end: i };
}

function backwardWordRange(text: string, offset: number): WordRange | null {
  const original = snapToCodePoint(text, offset);
  let i = original;
  while (i > 0 && belongsToWhitespace(text, stepBack(text, i), i)) {
    i = stepBack(text, i);
  }
  if (i <= 0) return null;
  if (belongsToWord(text, stepBack(text, i), i)) {
    while (i > 0 && belongsToWord(text, stepBack(text, i), i)) {
      i = stepBack(text, i);
    }
  } else {
    while (i > 0 && isPunctuation(text, stepBack(text, i), i)) {
      i = stepBack(text, i);
    }
  }
  return { start: i, end: original };
}

function belongsToWhitespace(text: string, start: number, end: number): boolean {
  const cp = text.codePointAt(start);
  return cp !== undefined && isWhitespace(cp);
}
