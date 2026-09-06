/**
 * content-stream-patch.ts — M7.5-005E-C2B-2A · Safe Content Stream Patch Engine
 *
 * 目标：提供一个「只做内容流字节级补丁」的安全引擎。
 *   patchContentStream(streamText, target, replacement) → 新的内容流文本 / null
 *
 * 范围（C2B-2A 纯安全补丁层）：
 *   ✅ 对「解码后的 content stream 文本」做字节区间替换（latin1，byte offset == char offset）
 *   ✅ 三重安全：Replacement checksum / Parse round-trip / Fail safe
 *   ❌ 不修改 page tree / 不写新 Font resource / 不生成新 Tj（C2B-2B）
 *   ❌ 不改 Export renderer / 不删除 mask（C2B-2C / C3）
 *
 * 安全机制（用户明确要求）：
 *   1. Replacement checksum — resolve 时对原区间 [byteStart,byteEnd) 保存 checksum；
 *      patch 时复验当前区间 hash，防止 resolve 之后字节漂移。
 *   2. Parse round-trip — 替换后重新 tokenize + extractShowTextRecords，
 *      确认旧对象（operatorText === target.raw）已消失，且流仍可被解析。
 *   3. Fail safe — 任何校验失败（越界 / checksum 不符 / 流解析失败 / 旧对象未消失）
 *      一律返回 null，调用方回退 overlay（不落任何半成品修改）。
 *
 * 坐标系约定：byteStart/byteEnd 为「解码后 latin1 文本」的字符偏移
 * （解码前每个字节 1:1 对应 1 个 latin1 字符码），与 C2B-1 resolver 的 byteStart/byteEnd 一致。
 */

import { extractShowTextRecords } from "./content-stream-resolver";

/**
 * Replacement patch 输入，由 C2B-1 的 ResolvedTextObject + 解码后的内容流文本派生。
 * checksum 在 resolve 时刻对原区间一次性计算，patch 时复验。
 */
export interface ContentStreamPatchTarget {
  /** 解码后 latin1 内容流中，目标区间的起止（半开区间 [byteStart, byteEnd)） */
  byteStart: number;
  byteEnd: number;
  /** resolve 时刻对 [byteStart,byteEnd) 计算的 checksum（hex） */
  checksum: string;
  /** 旧操作数文本（用于 round-trip 判断旧对象是否消失），如 "WORLD" */
  oldText: string;
}

export interface ContentStreamPatchResult {
  /** 补丁后的内容流文本（latin1） */
  contentText: string;
  /** round-trip 校验布尔值 */
  checks: { checksumMatched: boolean; oldTextGone: boolean; parseOk: boolean };
}

/** 计算一串字符码的 FNV-1a 32-bit hash，返回小写 hex */
export function computeRangeChecksum(text: string, byteStart: number, byteEnd: number): string {
  let h = 0x811c9dc5;
  for (let i = Math.max(0, byteStart); i < Math.min(text.length, byteEnd); i++) {
    h ^= text.charCodeAt(i) & 0xff;
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Patch 主入口。对解码后的 content stream 文本做区间替换。
 *
 * @param streamText 解码后的 latin1 内容流文本
 * @param target     目标区间 + resolve 时刻 checksum + 旧文本（round-trip 用）
 * @param replacement 替换字节（latin1 编码），由调用方编码（如新字符串的字节）
 *
 * @returns ContentStreamPatchResult | null —— 任何 Fail-safe 触发即返回 null。
 */
export function patchContentStream(
  streamText: string,
  target: ContentStreamPatchTarget,
  replacement: Uint8Array,
): ContentStreamPatchResult | null {
  const { byteStart, byteEnd, checksum, oldText } = target;

  // 边界合法（含半开区间 within bounds）
  if (
    !Number.isInteger(byteStart) ||
    !Number.isInteger(byteEnd) ||
    byteStart < 0 ||
    byteEnd < byteStart ||
    byteEnd > streamText.length
  ) {
    return null;
  }

  // 1. Replacement checksum —— 复验当前区间 hash 与 resolve 时刻一致
  const actual = computeRangeChecksum(streamText, byteStart, byteEnd);
  // 容忍 leading，但必须完全匹配（不校验则关闭该安全机制）
  if (checksum !== actual) {
    return null;
  }

  // 解码 replacement（latin1 字节 → 字符）
  const replText = Array.from(replacement, (b) => String.fromCharCode(b & 0xff)).join("");

  // 执行 splice
  const newText = streamText.slice(0, byteStart) + replText + streamText.slice(byteEnd);

  // 2/3. Parse round-trip —— 重新解析新流：能否解析 + 旧对象是否消失
  let parseOk = false;
  let oldTextGone = false;
  try {
    const records = extractShowTextRecords(newText, "patched", 0);
    parseOk = true;
    // 旧操作数文本不再作为 showText 操作数出现
    if (records.some((r) => r.operatorText === oldText)) {
      oldTextGone = false;
    } else {
      oldTextGone = true;
    }
  } catch {
    parseOk = false;
  }

  if (!parseOk) return null;
  if (!oldTextGone) return null;

  return {
    contentText: newText,
    checks: { checksumMatched: true, oldTextGone, parseOk },
  };
}