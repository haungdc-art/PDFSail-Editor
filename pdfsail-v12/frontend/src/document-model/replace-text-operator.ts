/**
 * replace-text-operator.ts — M7.5-005E-C2B-2B · Replace Single Tj/TJ
 *
 * 目标：把 C2B-2A 的安全补丁引擎升级为「真正的文本替换」：
 *   ResolvedTextObject + replacement text → 生成新 Tj/TJ 算子 → 安全替换旧算子。
 *
 * 范围（C2B-2B 允许层）：
 *   ✅ ResolvedTextObject + replacement → 新 Tj/TJ 算子字节 → patchContentStream 替换
 *   ✅ 三种编码：simple literal `(PDF) Tj` / TJ 数组重建 `[(PDF)] TJ` / CID hex `<hex> Tj`
 *   ✅ 复用 005D 的 encodeTextAsCidHex（Identity-H：Unicode → UTF-16BE hex）
 *   ✅ 复用 C2B-2A 的三重安全（checksum / round-trip / fail-safe）
 *   ❌ 不删除 mask / 不改 Export renderer / 不自动合并 runs / 不多 glyph reflow / 不接 Undo
 *
 * 位置/矩阵保真：只替换「操作数 + 算子」所在字节区间，BT/Tm/Td/Tf 等定位指令全部保留在
 *   区间之外 → 视觉位置（Tm/matrix）天然不变（由验收的 Visual Identity 逐字节证明）。
 *
 * 编码约定（kind）：
 *   - "simple"：简单字体（WinAnsi/latin1），literal 字符串
 *   - "cid"   ：Type0/Identity-H（CID 字体），<UTF-16BE hex> 字符串（字符码 = Unicode 码元）
 */
import { encodeTextAsCidHex } from "./export-cid-writer";
import {
  patchContentStream,
  computeRangeChecksum,
  type ContentStreamPatchTarget,
} from "./content-stream-patch";
import type { ResolvedTextObject } from "./content-stream-resolver";

export type TextOperatorKind = "simple" | "cid";

export interface ReplaceTextOperatorInput {
  /** C2B-1 解析到的目标算子 */
  resolved: ResolvedTextObject;
  /** 解码后的内容流文本（latin1，与 resolved.byteStart/byteEnd 对齐） */
  streamText: string;
  /** 替换文本 */
  replacement: string;
  /** 编码模式：simple=literal，cid=hex（缺失时按是否有非 latin1 字符推断） */
  kind?: TextOperatorKind;
  /** M7.7-004A：CID 编码器（fontRef + Unicode → CID hex；字符无 CID 返回 null → 整批回退 overlay）。
   *   kind="cid" 时优先使用；缺省回退 encodeTextAsCidHex（Identity-H 下 CID=Unicode 的假设）。 */
  cidEncode?: (fontRef: string, text: string) => string | null;
}

export interface ReplaceTextOperatorResult {
  /** 替换后的内容流文本 */
  contentText: string;
  /** 写入的新算子片段（调试/审计） */
  newOperator: string;
  /** 实际采用的编码模式 */
  kind: TextOperatorKind;
  /** 三重安全校验结果 */
  checks: { checksumMatched: boolean; oldTextGone: boolean; parseOk: boolean };
}

/** PDF literal 字符串转义（simple 字体用） */
export function escapePdfLiteral(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c === 0x5c) out += "\\\\";
    else if (c === 0x28) out += "\\(";
    else if (c === 0x29) out += "\\)";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else out += String.fromCharCode(c & 0xff);
  }
  return out;
}

/** 推断编码模式：含非 latin1（>0x7F 的 BMP 外或 CJK）字符 → cid */
function inferKind(text: string): TextOperatorKind {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c > 0x7f) return "cid";
  }
  return "simple";
}

/** 生成新算子内容（不含离屏换行，调用方负责夹在 BT/ET 之间的定位指令中） */
export function composeReplacementOperator(
  kind: TextOperatorKind,
  op: "Tj" | "TJ",
  replacement: string,
  /** M7.7-004A：可选 CID hex（Unicode → CID 编码结果）；提供时优先于 encodeTextAsCidHex */
  cidHex?: string,
): { operator: string; text: string } {
  if (kind === "cid") {
    const hex = cidHex ?? encodeTextAsCidHex(replacement);
    if (op === "Tj") return { operator: `<${hex}> Tj`, text: hex };
    return { operator: `[<${hex}>] TJ`, text: hex };
  }
  const lit = escapePdfLiteral(replacement);
  if (op === "Tj") return { operator: `(${lit}) Tj`, text: replacement };
  return { operator: `[(${lit})] TJ`, text: replacement };
}

/**
 * 主入口：ResolvedTextObject + replacement → 替换旧算子。
 * 返回 null = fail-safe（与 C2B-2A 一致，调用方回退 overlay）。
 */
export function replaceTextOperator(input: ReplaceTextOperatorInput): ReplaceTextOperatorResult | null {
  const { resolved, streamText, replacement } = input;
  const kind: TextOperatorKind = input.kind ?? inferKind(replacement);

  // M7.7-004A：CID 字体用 ToUnicode 感知的编码器（Unicode → CID hex）；任一字符无 CID → null（整批回退 overlay）
  let cidHex: string | undefined;
  if (kind === "cid" && input.cidEncode) {
    const hex = input.cidEncode(resolved.fontResource.resourceName, replacement);
    if (hex === null) return null;
    cidHex = hex;
  }

  const composed = composeReplacementOperator(kind, resolved.operator.op, replacement, cidHex);
  const newOperatorBytes = new TextEncoder().encode(composed.operator);

  const target: ContentStreamPatchTarget = {
    byteStart: resolved.byteStart,
    byteEnd: resolved.byteEnd,
    checksum: computeRangeChecksum(streamText, resolved.byteStart, resolved.byteEnd),
    oldText: resolved.operator.raw,
  };

  const patched = patchContentStream(streamText, target, newOperatorBytes);
  if (!patched) return null;

  return {
    contentText: patched.contentText,
    newOperator: composed.operator,
    kind,
    checks: patched.checks,
  };
}