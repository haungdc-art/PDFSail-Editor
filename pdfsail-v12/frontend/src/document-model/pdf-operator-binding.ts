/**
 * pdf-operator-binding.ts — M7.5-005E-C2A · Text Operator Binding MVP
 *
 * 目标：建立「一组 EditableGlyph → 原始 PDF 文本算子（showText/Tj/TJ）」的安全绑定。
 *
 * 输入（鸭子类型，生产侧来自 pdf.js page.getOperatorList()）：
 *   operatorList = { fnArray: number[]; argsArray: unknown[][] }
 *   ops          = pdf.js OPS 枚举（仓库以 (pdfjsLib as any).OPS 获取）
 *
 * 范围（005E-C2A 只读层）：
 *   ✅ Import 侧新增算子提取 + Glyph/Operator Strong Match → binding
 *   ❌ 不修改 Export
 *   ❌ 不删除任何 Tj
 *   ❌ 不做 content stream 字节级重写（005E-C2B）
 *   ❌ 不做完整 PDF operator parser / Mutation / Undo / Editor 改造
 *
 * 关键简化（MVP）：
 *   - 只跟踪 Tf（setFont）与 showText；不重建完整 Tm —— 第一版不要求字节 offset。
 *   - operator index 来自 fnArray 中 showText 的绝对序号（权威，供 005E-C2B 定位删除）。
 *   - 文本解码通过注入的 codec（ASCII=latin1，CID=utf16be）。不依赖字体字典解析。
 *   - Strong Match = text 相等 + fontRef 相等；多候选时用 bbox 重叠消歧；仍歧义 → weak（安全拒绑）。
 */

import type { BBox, OriginalTextBinding, TransformMatrix } from "./types";

/** pdf.js OPS 枚举中我们用到的算子 id */
export interface OpCodes {
  /** 设置字体 Tf */
  setFont: number;
  /** 显示文本 Tj / TJ */
  showText: number;
}

/** 最小 getOperatorList 输出形状（封面不同 pdf.js 版本的返回） */
export interface OperatorListLike {
  fnArray: number[];
  argsArray: unknown[];
}

/** 文本运算子（未解码） */
export interface TextOperator {
  /** fnArray 中该 showText 的绝对序号（权威，005E-C2B 据此定位） */
  operatorIndex: number;
  /** Tj = 单串；TJ = 带字距调整数组（据 args 是否含负数判定） */
  op: "Tj" | "TJ";
  /** showText 时刻由 Tf 设置的字体资源 key，如 "F1" */
  fontRef: string;
  fontSize: number;
  /** 该算子对应的 glyph 信息（新式含 unicode/width；旧式仅 code） */
  charInfos: GlyphCharInfo[];
}

/** 已解码的文本运算子（追加 text + 几何） */
export interface DecodedTextOperator extends TextOperator {
  /** 该算子解码后的 Unicode 文本 */
  text: string;
  /** 近似原点（PDF pt，bottom-left origin）；MVP 可空，用于歧义消解 */
  origin: { x: number; y: number } | null;
  /** 该算子对应的文本 bbox（PDF pt）；可空 */
  bbox: BBox | null;
}

/**
 * 文本解码器：把某字体（fontRef）下的字符码序列解码为 Unicode。
 * 由调用方按字体语义注入：ASCII→latin1，CID（Identity-H）→utf16be。
 * 仅旧式 pdf.js（showText args = 纯数字码）需要；新式（args = glyph 对象）自带 unicode。
 */
export type OperatorCodec = (fontRef: string, charCodes: number[]) => string;

/** latin1 解码（适用范围：Type1 / 简单 TrueType 的 WinAnsi/Latin 字符码） */
export const latin1Codec: OperatorCodec = (_fontRef, codes) =>
  codes.map((c) => String.fromCharCode(c & 0xff)).join("");

/** utf16be 解码（适用范围：CIDFont / Identity-H 的 16-bit Unicode 码） */
export const utf16beCodec: OperatorCodec = (_fontRef, codes) =>
  codes.map((c) => String.fromCharCode(c & 0xffff)).join("");

/**
 * 单个 glyph 的信息（新式 pdf.js 在 showText args 中直接暴露）。
 * 老式（纯数字码）经 normalize 后 code 非空、unicode 为空。
 */
export interface GlyphCharInfo {
  /** 旧式字符码；或新式 originalCharCode（0..65535） */
  code: number | null;
  /** 新式直接 unicode；旧式为空（需 codec 解码） */
  unicode: string;
  /** 新式 glyph 宽度（PDF pt * 1000 scale，pdf.js 已归一化）；旧式无 */
  width: number | null;
}

/** 从 showText args 提取 glyph 信息，兼容两种 pdf.js shape */
function extractCharInfos(args: unknown): GlyphCharInfo[] {
  if (!Array.isArray(args)) return [];
  const out: GlyphCharInfo[] = [];
  const inner = Array.isArray(args[0]) ? args[0] : args; // 兼容 [ [glyphs...] ] 与 [glyphs...]
  for (const v of inner) {
    if (typeof v === "number") {
      // 旧式：纯字符码；负数（TJ 字距）跳过
      if (v >= 0 && v <= 0xffff) out.push({ code: v, unicode: "", width: null });
    } else if (v && typeof v === "object") {
      const g = v as { originalCharCode?: number; unicode?: string; width?: number };
      out.push({
        code: typeof g.originalCharCode === "number" ? g.originalCharCode : null,
        unicode: typeof g.unicode === "string" ? g.unicode : "",
        width: typeof g.width === "number" ? g.width : null,
      });
    }
  }
  return out;
}

/** utf16 双字节字符串（CID）逐字拼接（多 glyph 时） */
function codesToUtf16(codes: number[]): string {
  return codes.map((c) => String.fromCharCode(c & 0xffff)).join("");
}

/** 判定算子是否来自 TJ 数组（args 中出现负字距号） */
function detectOpKind(args: unknown): "Tj" | "TJ" {
  if (Array.isArray(args)) {
    for (const v of args) {
      if (typeof v === "number" && v < 0) return "TJ";
    }
  }
  return "Tj";
}

/**
 * 步骤 1：从 getOperatorList 提取文本运算子（含 operatorIndex / fontRef / op / charCodes）。
 *
 * @param operatorList pdf.js getOperatorList() 输出
 * @param ops pdf.js OPS 枚举
 */
export function extractTextOperators(
  operatorList: OperatorListLike,
  ops: OpCodes,
): TextOperator[] {
  const { fnArray, argsArray } = operatorList;
  const out: TextOperator[] = [];
  let currentFont = "";
  let currentSize = 16;
  for (let i = 0; i < fnArray.length; i++) {
    const id = fnArray[i];
    const args = argsArray[i] as unknown;
    if (id === ops.setFont) {
      const a = args as unknown[];
      currentFont = String(a[0] ?? currentFont);
      const size = Number(a[1]);
      if (Number.isFinite(size) && size > 0) currentSize = size;
    } else if (id === ops.showText) {
      const charInfos = extractCharInfos(args);
      out.push({
        operatorIndex: i,
        op: detectOpKind(args),
        fontRef: currentFont,
        fontSize: currentSize,
        charInfos,
      });
    }
  }
  return out;
}

/** 由 glyph 信息列解码文本：新式用 unicode，旧式用 codec(code) */
function decodeGlyphText(charInfos: GlyphCharInfo[], fontRef: string, codec: OperatorCodec): string {
  const codes = charInfos.map((c) => c.code).filter((n): n is number => n !== null);
  const hasUnicode = charInfos.length > 0 && charInfos.every((c) => c.unicode !== "");
  if (hasUnicode) return charInfos.map((c) => c.unicode).join("");
  if (codes.length > 0) return codec(fontRef, codes);
  return "";
}

/** 步骤 2：解码算子文本，并可选地补充几何（bbox/origin）。 */
export function decodeTextOperators(
  operators: TextOperator[],
  codec: OperatorCodec,
  textItems?: Array<{ transform: number[]; width: number; height: number; str: string }>,
): DecodedTextOperator[] {
  const pair = textItems && textItems.length === operators.length;
  return operators.map((op, idx) => {
    const text = decodeGlyphText(op.charInfos, op.fontRef, codec);
    let origin: { x: number; y: number } | null = null;
    let bbox: BBox | null = null;
    if (pair && textItems[idx]) {
      const it = textItems[idx];
      const tm = it.transform || [1, 0, 0, 1, 0, 0];
      const x = tm[4] ?? 0;
      const y = tm[5] ?? 0;
      const w = it.width ?? it.str.length * op.fontSize * 0.5;
      const h = it.height ?? op.fontSize;
      origin = { x, y };
      bbox = { x, y, width: w, height: h };
    }
    return { ...op, text, origin, bbox };
  });
}

/** 供 strong-match 输入的最小 glyph run（来自模型一个连续段落/一行） */
export interface GlyphRunInput {
  /** 该 run 的原始文本（编辑前），用于与算子文本比对 */
  text: string;
  /** 该 run 的字体资源 key（EditableGlyph.metrics.fontRef） */
  fontRef?: string;
  /** 该 run 的 bbox（CSS 显示坐标；PDF pt bbox 由调用方换算后传入，消歧用） */
  bbox?: BBox;
}

export interface BindingParams {
  pageIndex: number;
  ops: OpCodes;
  operatorList: OperatorListLike;
  runs: GlyphRunInput[];
  codec: OperatorCodec;
  /** 可选：getTextContent().items，用于补充算子 bbox 以增强几何消歧 */
  textItems?: Array<{ transform: number[]; width: number; height: number; str: string }>;
  /** bbox 重叠阈值（PDF pt 矩形面积，判定两 bbox 是否重叠消歧） */
  overlapThreshold?: number;
}

/** 两 bbox（PDF pt）是否重叠（阈值门限） */
function bboxOverlap(a: BBox, b: BBox, threshold: number): boolean {
  const ix = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const iy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const inter = ix > 0 && iy > 0 ? ix * iy : 0;
  const area = Math.max(a.width, 1) * Math.max(a.height, 1);
  return inter / area >= threshold;
}

/**
 * 步骤 3（主入口）：Glyph/Operator Strong Match → OriginalTextBinding[]
 *
 * Strong Match 规则（MVP，第一版不追求 100%）：
 *   candidate = operators 中 fontRef 相等 && text 相等；
 *   - 0 候选                        → 拒绑（返回 null，保持 mask fallback）
 *   - 1 候选                        → strong
 *   - >1 候选：若均有 bbox，则取与 run bbox 重叠最大且唯一最优者 → strong；否则 → weak
 *
 * glyphStart/glyphEnd：MVP 以 run 整体为单位（glyphStart=0, glyphEnd=run.text.length）。
 */
export function bindGlyphRuns(params: BindingParams): OriginalTextBinding[] {
  const decoded = decodeTextOperators(
    extractTextOperators(params.operatorList, params.ops),
    params.codec,
    params.textItems,
  );
  const threshold = params.overlapThreshold ?? 0.5;

  const results: OriginalTextBinding[] = [];
  for (const run of params.runs) {
    // 候选：text 相等 + fontRef 相等（fontRef 缺失时仅按 text 匹配）
    const candidates = decoded.filter((op) => {
      if (op.text !== run.text) return false;
      if (run.fontRef && op.fontRef !== run.fontRef) return false;
      return true;
    });

    let binding: OriginalTextBinding | null = null;
    if (candidates.length === 1) {
      const c = candidates[0];
      binding = {
        pageIndex: params.pageIndex,
        fontRef: c.fontRef,
        operatorIndex: c.operatorIndex,
        op: c.op,
        rawText: c.text,
        glyphStart: 0,
        glyphEnd: run.text.length,
        transform: [1, 0, 0, 1, 0, 0],
        confidence: "strong",
      };
    } else if (candidates.length > 1 && run.bbox) {
      // 歧义：用 bbox 重叠消解
      const withBBox = candidates.filter((c) => c.bbox);
      if (withBBox.length > 0) {
        let best: Array<{ idx: number; score: number }> = [];
        let bestScore = -Infinity;
        for (const c of withBBox) {
          if (!c.bbox) continue;
          const score = bboxOverlap(run.bbox, c.bbox, 0)
            ? run.bbox.width * run.bbox.height
            : -1;
          if (score > bestScore) {
            bestScore = score;
            best = [{ idx: candidates.indexOf(c), score }];
          } else if (score === bestScore && score >= 0) {
            best.push({ idx: candidates.indexOf(c), score });
          }
        }
        if (best.length === 1) {
          const c = candidates[best[0].idx];
          binding = {
            pageIndex: params.pageIndex,
            fontRef: c.fontRef,
            operatorIndex: c.operatorIndex,
            op: c.op,
            rawText: c.text,
            glyphStart: 0,
            glyphEnd: run.text.length,
            transform: [1, 0, 0, 1, 0, 0],
            confidence: "strong",
          };
        }
      }
    }
    // 无强绑定 → 拒绑（null，调用方保持 mask fallback）
    if (binding) results.push(binding);
  }
  return results;
}