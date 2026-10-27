/**
 * export-redraw-verify.ts — F3B-6.28 · D-3B-4（第 4 步）：重绘前的**清除完整性核验**。
 *
 * 用户裁决（第 4 步决策三）：
 *   「mask 是遮盖手段，不是清除完整性证明。不能出现原始文字没有被完整移除、
 *     又在其上方重绘的情况。」
 *
 * 因此重绘命令**落笔之前**必须逐行证明：该行原始 baseline 附近的内容流 showText
 * 算子已全部为空串（原算子已被剥离）。任一行不满足 ⇒ **整体拒绝导出**
 * （抛 `ExportRedrawGateError`），绝不「先画 mask 盖住、再重绘」。
 *
 * 顺序保证：`exportEditableDocument` 先执行 `stripReplacedTextOperators`，
 * 再 `writeExportCommandsToPDF`；核验放在 Pass 1.5（重绘）最前面 ⇒ 此刻内容流里
 * 只有「已剥离的原始算子」，任何非空算子都只能是**没剥干净**的原文（重绘尚未落笔，
 * 不会与其它行的重绘算子混淆 —— 这是把核验放在重绘之前的决定性理由）。
 */

import { tokenizeContentStream } from "./content-stream-resolver";

/** 重绘资格门失败（导出必须整体拒绝，不产出 PDF） */
export class ExportRedrawGateError extends Error {
  readonly code:
    | "clear-incomplete"
    | "glyph-missing-source"
    | "line-not-drawn"
    | "unclaimed-target-lines";
  readonly details: Readonly<Record<string, unknown>>;
  constructor(
    code: ExportRedrawGateError["code"],
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ExportRedrawGateError";
    this.code = code;
    this.details = details;
  }
}

export interface StreamOpLike {
  /** 该算子所属的最近一个 Tm 的 y（PDF pt）；无法判定时为 null */
  readonly y: number | null;
  /** showText 载荷（hex/字面量均已去空白） */
  readonly text: string;
}

/** 参与核验的重绘行（只需要原始 baseline 与行标识） */
export interface RedrawClearTarget {
  readonly lineId: string;
  readonly originalBaselinePt: number | null;
}

/** y 容差：同一视觉行的原始算子 baseline 完全一致；重绘前的流里不会有别的行抢这个 y */
const CLEAR_BAND_PT = 0.6;

/**
 * F3B-6.28 · D-3B-4（clear-incomplete **坐标系修复**）：从单段内容流文本提取全部
 * showText 算子，y 为 **CTM 合成后的有效 PDF 空间 y**。
 *
 * 为什么必须合成：重绘行的 `originalBaselinePt` 来自 Sidecar 的
 * `glyph.metrics.pdfTransform[5]`（= pdf.js 报告的**有效**基线，已含页面 CTM）。
 * 旧实现（export-renderer 内）直接取原始 Tm 的 f 分量 —— 页面带 y 翻转 cm
 * （如 `1 0 0 -1 0 841.9 cm`，gd-swim 全页皆然）时二者差一个镜像
 * （effY = flipBase − rawY）⇒ 核验在**镜像位置**找残留：实测第 2 页 baseline
 * 561.291 的算子实际在 raw 280.609（已剥离），而 raw 561.409 是属于有效 y
 * 280.49 的**另一行**的 35 个未剥离算子 ⇒ 假阳性 clear-incomplete ⇒ E-01。
 *
 * 合成口径与 `content-stream-resolver` 的 `finalTmY` 逐行同式：
 *   · `cm` 为**左乘**（CTM ← cm × CTM）；
 *   · `q`/`Q` 维护 CTM 栈；
 *   · `Tm` 记录文本原点，`Td`/`TD` 相对平移；
 *   · 有效 y = ctm[1]·e + ctm[3]·f + ctm[5]（Tm 原点经 CTM 后的 y）。
 *
 * 算子识别与 strip 路径同源（同一 tokenizer）：literal/hex 紧跟 Tj/TJ，
 * 以及 TJ 数组（拼接内部全部 literal/hex）。剥离后的算子形如 `() Tj`
 * ⇒ 文本为空 ⇒ 不计残留。
 *
 * @param text 单段内容流文本（已解码为 latin1 字符串）
 */
export function collectShowTextOpsFromStream(text: string): StreamOpLike[] {
  const ops: StreamOpLike[] = [];
  const toks = tokenizeContentStream(text);
  let ctm: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
  const ctmStack: [number, number, number, number, number, number][] = [];
  const pendingNums: number[] = [];
  let curTmE: number | undefined;
  let curTmF: number | undefined;
  const effectiveY = (): number | null => {
    if (curTmE === undefined || curTmF === undefined) return null;
    const y = ctm[1] * curTmE + ctm[3] * curTmF + ctm[5];
    return Number.isFinite(y) ? y : null;
  };
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (tok.kind === "number") {
      pendingNums.push(Number(tok.value));
      if (pendingNums.length > 6) pendingNums.shift();
      continue;
    }
    if (tok.kind === "op") {
      if (tok.value === "Tm" && pendingNums.length >= 6) {
        curTmE = pendingNums[4];
        curTmF = pendingNums[5];
      } else if (
        (tok.value === "Td" || tok.value === "TD") &&
        pendingNums.length >= 2 &&
        curTmE !== undefined &&
        curTmF !== undefined
      ) {
        curTmE += pendingNums[0];
        curTmF += pendingNums[1];
      } else if (tok.value === "cm" && pendingNums.length >= 6) {
        const [a1, b1, c1, d1, e1, f1] = pendingNums;
        const [a2, b2, c2, d2, e2, f2] = ctm;
        ctm = [
          a1 * a2 + b1 * c2,
          a1 * b2 + b1 * d2,
          c1 * a2 + d1 * c2,
          c1 * b2 + d1 * d2,
          e1 * a2 + f1 * c2 + e2,
          e1 * b2 + f1 * d2 + f2,
        ];
      } else if (tok.value === "q") {
        ctmStack.push([...ctm]);
      } else if (tok.value === "Q") {
        const prev = ctmStack.pop();
        if (prev) ctm = prev;
      }
      pendingNums.length = 0;
      continue;
    }
    if (
      (tok.kind === "literal" || tok.kind === "hex") &&
      toks[i + 1]?.kind === "op" &&
      (toks[i + 1].value === "Tj" || toks[i + 1].value === "TJ")
    ) {
      ops.push({ y: effectiveY(), text: tok.value.replace(/\s+/g, "") });
      continue;
    }
    if (tok.kind === "array" && toks[i + 1]?.kind === "op" && toks[i + 1].value === "TJ") {
      let tjText = "";
      for (const t of tok.value) {
        if (t.kind === "literal" || t.kind === "hex") tjText += t.value;
      }
      ops.push({ y: effectiveY(), text: tjText.replace(/\s+/g, "") });
      continue;
    }
    pendingNums.length = 0;
  }
  return ops;
}

/**
 * 核验：每条重绘行的原始 baseline 附近**不得有非空** showText 算子。
 *
 * @param ops 该页内容流的全部 showText 算子（剥离后的现状）
 * @param lines 该页上的重绘行（原始 baseline）
 * @returns 未通过的行（空数组 = 全部通过）
 */
export function findIncompletelyClearedLines(
  ops: readonly StreamOpLike[],
  lines: readonly RedrawClearTarget[],
): readonly { lineId: string; residualChars: number; atBaselinePt: number }[] {
  const bad: { lineId: string; residualChars: number; atBaselinePt: number }[] = [];
  for (const line of lines) {
    if (line.originalBaselinePt === null) continue; // 无从核验（新建行，无原位置）
    let residual = 0;
    for (const op of ops) {
      if (op.y === null || !Number.isFinite(op.y)) continue;
      if (Math.abs(op.y - line.originalBaselinePt) > CLEAR_BAND_PT) continue;
      if (op.text.length > 0) residual += op.text.length;
    }
    if (residual > 0) {
      bad.push({ lineId: line.lineId, residualChars: residual, atBaselinePt: line.originalBaselinePt });
    }
  }
  return bad;
}
