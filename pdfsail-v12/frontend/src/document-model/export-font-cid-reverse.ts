/**
 * document-model/export-font-cid-reverse.ts — F3B-6.28 · D-3B-7（编辑字符**原字体**一致性）
 *
 * 背景（用户 2026-10-19 报告：导出 PDF 中修改后的文本字体与原文不相同）：
 *   重绘管线对**新增字符**（编辑插入/替换来的字符，原 PDF 无对应字形）此前只能走
 *   `tryDrawNonWinAnsiAsCid` 的兜底字体链（LiberationSans → NotoSansSC）。
 *   对 CJK 文档（如 gd-swim 的 FangSong_GB2312）这是**结构性**的：原字体是
 *   CID-keyed 子集字体（Type0 /Identity-H，无 Unicode cmap），fontkit 解析后
 *   `font.cmap` 为 undefined ⇒ `hasGlyphForCodePoint` 抛错 ⇒ 原字体源被丢弃
 *   ⇒ 编辑字符用拉丁/兜底字体绘制 ⇒ 视觉不一致（用户截图："16 天" 的 "1"、
 *   "1500"/"800" 的数字与原文字形明显不同）。
 *
 * 做法（**不猜 CID**，用字体自己的权威映射）：
 *   原字体的 `/ToUnicode` CMap 就是 `CID → Unicode` 的权威表（bfchar + bfrange，
 *   解析复用 `parseToUnicodeCMap`，5C-A2 已修多块解析）。把它**反向**成
 *   `Unicode → CID`，新增字符即可用原字体资源 raw-CID 直发（`emitRawCidGlyphs`），
 *   与原文完全同字体。
 *
 * 歧义纪律（fail-closed）：
 *   · 只有**单字符** Unicode 且**唯一 CID** 才入表；一个字符对应多个 CID
 *     （不同字形变体）⇒ 不入表 ⇒ 调用方回退既有兜底链（绝不猜一个变体）；
 *   · 无 /ToUnicode / 解析失败 ⇒ null（调用方保持既有行为）。
 */

import type { PDFDict, PDFDocument } from "pdf-lib";
import { parseToUnicodeCMap } from "./content-stream-resolver";

/**
 * 构建字体的 `Unicode → CID` 反查表（源自该字体自己的 /ToUnicode CMap）。
 *
 * @param fontDict 页面 /Font 资源下的字体字典
 * @param doc      PDFDocument（解析 /ToUnicode 流引用）
 * @returns 反查表；无 /ToUnicode / 解析失败 / 无可用条目 ⇒ null
 */
export function buildReverseToUnicodeMap(
  fontDict: PDFDict | undefined,
  doc: PDFDocument,
): Map<string, number> | null {
  const forward = parseToUnicodeCMap(fontDict, doc);
  if (!forward) return null;
  const reverse = new Map<string, number>();
  for (const [cid, uni] of forward) {
    // 只接受单字符 Unicode（CJK / 数字 / 标点均单字符）；多字符条目不是单字形映射
    if ([...uni].length !== 1) continue;
    if (reverse.has(uni)) {
      // 歧义：同一字符对应多个 CID ⇒ 移除并标记不可用（fail-closed，不猜变体）
      reverse.set(uni, -1);
      continue;
    }
    reverse.set(uni, cid);
  }
  for (const [ch, cid] of [...reverse.entries()]) {
    if (cid < 0) reverse.delete(ch);
  }
  return reverse.size > 0 ? reverse : null;
}

/**
 * 反查单个字符的 CID。
 *
 * @returns CID（≥ 0）；字符不在表中 / 表不可用 / 歧义 ⇒ null
 */
export function reverseCidOf(
  reverse: Map<string, number> | null | undefined,
  char: string,
): number | null {
  if (!reverse) return null;
  if ([...char].length !== 1) return null; // 只处理单码点字符（代理对等不入表）
  const cid = reverse.get(char);
  return typeof cid === "number" && cid >= 0 ? cid : null;
}
