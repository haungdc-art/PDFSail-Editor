/**
 * bridge-slice-integrity.ts — REENTER-SPLIT-01 最小修复（导出投影 glyph 唯一归属）
 *
 * 背景：拆段 + 新增字符场景中，layoutTextBox（空 provider）产出的相邻 visual line
 * slices 在段落 offset 轴上重叠（实测 112 glyph > 段落 72 字符 ⇒ 40 个「长」各被
 * 两个行 slice 携带），bridge 忠实投影 ⇒ 导出重复绘制。
 *
 * 本模块实现「段落级互斥账本」：
 *   - 身份轴：段落级 UTF-16 code unit offset（与 String.slice / runStartOffset 同轴；
 *     GlyphLayout 契约保证代理对 length=2、绝不拆开）。
 *   - 归属：每个 code unit 只归首个（行序 × 行内序）声明它的 visual line；
 *     后续重复声明被裁剪（计数，不视为错误）。
 *   - 身份校验：item 覆盖区间必须完整落在其 run 的段落区间内 ⇒ 保证 emitRunGlyphs
 *     的 runOffset 内容提取正确（即内容-身份一致性的充分条件）。
 *   - fail-closed：覆盖缺失（去重后仍有 code unit 无任何行声明）或身份校验失败 ⇒
 *     返回明确错误，由调用方中止导出（安全回退 legacy），不得产出缺字 PDF。
 *
 * ⚠️ 不改 layoutTextBox；不改 scale/metrics；不碰 mask 与 Legacy 同步。
 */
import type { Rect } from "../core/layout/types";

export interface SliceItem {
  textIndex: number;
  length: number;
  box: Rect;
}

export interface RunSlice {
  runId: string;
  glyphs: SliceItem[];
}

/** 各 visual line 的 run slices：visualLines[行号] = 该行的 RunSlice[] */
export type VisualLineSlices = RunSlice[][];

export interface RunInfo {
  /** run 在段落中的 UTF-16 起点（runStartOffset 语义） */
  start: number;
  /** run 文本长度（UTF-16 code units） */
  length: number;
  /** run 文本（用于裁剪边界落在代理对中间时的字符边界校正） */
  text: string;
}

export interface SliceIntegrityInput {
  /** 段落全文（runs 拼接，UTF-16） */
  paragraphText: string;
  /** runId → run 信息 */
  runs: Map<string, RunInfo>;
  /** 各 visual line 的 run slices（行序） */
  visualLines: VisualLineSlices;
}

export interface SliceIntegrityOk {
  ok: true;
  /** 互斥后的各行 run slices（结构与输入同构：lines[行号] = 该行 RunSlice[]） */
  lines: VisualLineSlices;
  /** 被裁剪掉的重复声明 code unit 总数（可证明的重复，非错误） */
  duplicateUnits: number;
  /** 被整体丢弃的重复 item 数 */
  duplicateItems: number;
  /**
   * ★ 2026-10-25（用户缺陷「修改后导出 PDF 失败」）：布局引擎在软折行点**省略行尾
   * 空白**（不产 glyph）⇒ 该空白 code unit 无任何 visual line 声明是**合法状态**
   * （无墨迹；用户编辑使折行点移动后必然出现）。此类缺失不计入失败，仅计数供
   * 调用方告警观测；非空白缺失仍 fail-closed（可见缺字）。
   */
  omittedWhitespaceUnits: number;
}

export type SliceIntegrityFailure = {
  ok: false;
  reason: "coverage-gap" | "content-mismatch" | "invalid-range" | "surrogate-split";
  details: string;
};

export type SliceIntegrityResult = SliceIntegrityOk | SliceIntegrityFailure;

/** 该 offset 处的字符是否为代理对的 low surrogate（即边界落在 pair 中间） */
function isLowSurrogateAt(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const code = text.charCodeAt(offset);
  return code >= 0xdc00 && code <= 0xdfff;
}

export function enforceExclusiveSlices(input: SliceIntegrityInput): SliceIntegrityResult {
  const { paragraphText, runs, visualLines } = input;
  const paraLen = paragraphText.length;

  /** offset → 已归属的行号 */
  const allocated = new Map<number, number>();
  const lines: VisualLineSlices = [];
  let duplicateUnits = 0;
  let duplicateItems = 0;

  for (let li = 0; li < visualLines.length; li++) {
    const outRuns: RunSlice[] = [];
    for (const slice of visualLines[li] ?? []) {
      const run = runs.get(slice.runId);
      if (!run) {
        return {
          ok: false,
          reason: "content-mismatch",
          details: `行 ${li} 引用不存在的 run ${slice.runId}`,
        };
      }
      const outGlyphs: SliceItem[] = [];
      for (const item of slice.glyphs ?? []) {
        const { textIndex, length } = item;
        if (!Number.isFinite(textIndex) || !Number.isFinite(length) || length <= 0) {
          return {
            ok: false,
            reason: "invalid-range",
            details: `行 ${li} run=${slice.runId} 非法 item textIndex=${textIndex} length=${length}`,
          };
        }
        const end = textIndex + length;
        // 身份校验①：item 必须完整落在其 run 的段落区间内（保证内容提取正确）
        if (textIndex < run.start || end > run.start + run.length) {
          return {
            ok: false,
            reason: "content-mismatch",
            details: `行 ${li} run=${slice.runId} item [${textIndex},${end}) 超出 run 段落区间 [${run.start},${run.start + run.length})`,
          };
        }
        // 身份校验②：段落全文与 run 文本在该区间一致（run 拼接一致性由调用方保证；
        // 这里再验一次 item 区间不落在代理对中间 —— layout 契约保证，违反即不可证明身份）
        if (isLowSurrogateAt(paragraphText, textIndex)) {
          return {
            ok: false,
            reason: "surrogate-split",
            details: `行 ${li} run=${slice.runId} item 起点落在代理对中间 textIndex=${textIndex}`,
          };
        }
        if (isLowSurrogateAt(paragraphText, end)) {
          return {
            ok: false,
            reason: "surrogate-split",
            details: `行 ${li} run=${slice.runId} item 终点落在代理对中间 end=${end}`,
          };
        }

        // 互斥分配：切出未被本行之前行占用的连续子区间
        let kept = 0;
        while (kept < length) {
          const off = textIndex + kept;
          if (!allocated.has(off)) {
            // 连续未分配段
            let run0 = 0;
            while (
              kept + run0 < length &&
              !allocated.has(textIndex + kept + run0)
            ) {
              run0 += 1;
            }
            if (run0 > 0) {
              // 代理对完整性：切出的子区间边界不得落在 pair 中间
              if (isLowSurrogateAt(paragraphText, off) || isLowSurrogateAt(paragraphText, off + run0)) {
                return {
                  ok: false,
                  reason: "surrogate-split",
                  details: `行 ${li} run=${slice.runId} 互斥切分 [${off},${off + run0}) 落在代理对中间`,
                };
              }
              // 均分 box：按 code unit 等分原 item.box（与 codePointItems 的等分语义一致）
              const w = item.box.width / length;
              outGlyphs.push({
                textIndex: off,
                length: run0,
                box: {
                  ...item.box,
                  x: item.box.x + w * kept,
                  width: w * run0,
                },
              });
              for (let k = 0; k < run0; k++) allocated.set(textIndex + kept + k, li);
              kept += run0;
            }
          } else {
            // 重复声明：跳过已分配 unit（计数）
            let skip = 0;
            while (
              kept + skip < length &&
              allocated.has(textIndex + kept + skip)
            ) {
              skip += 1;
            }
            duplicateUnits += skip;
            kept += skip;
          }
        }
        if (outGlyphs.length === 0) duplicateItems += 1;
      }
      if (outGlyphs.length > 0) outRuns.push({ runId: slice.runId, glyphs: outGlyphs });
    }
    lines.push(outRuns);
  }

  // fail-closed 终检：每个段落 code unit 都必须被某个行声明。
  // ★ 2026-10-25（用户缺陷「修改后导出 PDF 失败」）：布局引擎在软折行点会**省略行尾
  //   空白**（不产 glyph）⇒ 该空白 code unit 无任何行声明是**合法状态**（不可见、
  //   无墨迹；用户编辑使折行点移动后必然出现）。仅当缺失含**非空白**字符（可见缺字）
  //   才 fail-closed；纯空白缺失计入 omittedWhitespaceUnits 由调用方告警观测。
  const missing: number[] = [];
  for (let i = 0; i < paraLen; i++) {
    if (!allocated.has(i)) missing.push(i);
  }
  if (missing.length > 0) {
    const visibleMissing = missing.filter((i) => !/\s/.test(paragraphText.slice(i, i + 1)));
    if (visibleMissing.length > 0) {
      return {
        ok: false,
        reason: "coverage-gap",
        details: `段落（${paraLen} units）有 ${visibleMissing.length} 个可见 code unit 无任何 visual line 声明：[ ${visibleMissing
          .slice(0, 12)
          .map((i) => `${i}:"${paragraphText.slice(i, i + 1)}"`)
          .join(", ")}${visibleMissing.length > 12 ? " …" : ""} ]（另有 ${
          missing.length - visibleMissing.length
        } 个布局省略空白）`,
      };
    }
    return { ok: true, lines, duplicateUnits, duplicateItems, omittedWhitespaceUnits: missing.length };
  }

  return { ok: true, lines, duplicateUnits, duplicateItems, omittedWhitespaceUnits: 0 };
}
