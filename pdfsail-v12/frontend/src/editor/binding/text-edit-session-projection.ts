/**
 * editor/binding/text-edit-session-projection.ts — F3B-6.17-3C-10C.3A
 *
 * **EditSession 提交投影**（纯模块，中立层）。
 *
 * 把「旧行文本 → session 最终文本」投影成**变更跨度**：
 *
 *     lineText ──LCP/LCS（**码点域**）──▶ { 码点跨度, 替换文本, kind }
 *
 * ── 为什么单独成模块 ─────────────────────────────────────────────────
 * 这个投影有**两个**消费方，且分属不同的层：
 *
 *   · `text-edit-input-shadow.ts`（观察层）：如实记录 Legacy commit 的落点（C.2）
 *   · `text-edit-core-commit.ts`（提交层）：作为 Core 提交的**输入跨度**（C.3A）
 *
 * 把它放在任一消费方内部都会造成「production 依赖 shadow」或反之的错层依赖。
 *
 * ── 单位口径（重要，不得修改）────────────────────────────────────────
 * 刻意**只在码点域**计算：Legacy `findDeletedGlyphRange` 就是这样把码点跨度
 * 当作 glyph 区间交给 `applyTextOperation` 的（3C-10C.1 已钉死的单位混用）。
 * 本模块**如实建模**，绝不修正它；Core 侧的 UTF-16 换算由 Adapter 负责。
 */

export interface LegacyLineEditProjection {
  readonly kind: "replace" | "insert" | "delete" | "none";
  /** 变更跨度（**码点**、半开区间） */
  readonly codepointStart: number;
  readonly codepointEnd: number;
  /** Legacy 会把它当作 **glyph 区间**（含端）；纯插入 = `end === start - 1` */
  readonly glyphStartInclusive: number;
  readonly glyphEndInclusive: number;
  /** 新文本片段（替换内容；删除 = ""） */
  readonly replacementText: string;
}

/**
 * 把「旧行 → 新行」投影成 Legacy commit 口径的变更跨度（LCP/LCS over **码点**）。
 */
export function projectLegacyLineEdit(input: {
  readonly lineText: string;
  readonly newText: string;
}): LegacyLineEditProjection {
  const oldChars = Array.from(input.lineText);
  const newChars = Array.from(input.newText);
  if (input.lineText === input.newText) {
    return {
      kind: "none",
      codepointStart: 0,
      codepointEnd: 0,
      glyphStartInclusive: 0,
      glyphEndInclusive: -1,
      replacementText: "",
    };
  }

  let prefix = 0;
  const maxPrefix = Math.min(oldChars.length, newChars.length);
  while (prefix < maxPrefix && oldChars[prefix] === newChars[prefix]) prefix += 1;

  let suffix = 0;
  const maxSuffix = Math.min(oldChars.length - prefix, newChars.length - prefix);
  while (
    suffix < maxSuffix &&
    oldChars[oldChars.length - 1 - suffix] === newChars[newChars.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const codepointStart = prefix;
  const codepointEnd = oldChars.length - suffix; // 半开
  const replacementText = newChars.slice(prefix, newChars.length - suffix).join("");

  if (codepointEnd - codepointStart === 0) {
    // 纯插入：Legacy 用 end = start - 1 的空区间表达
    return {
      kind: "insert",
      codepointStart,
      codepointEnd,
      glyphStartInclusive: codepointStart,
      glyphEndInclusive: codepointStart - 1,
      replacementText,
    };
  }
  const kind: "replace" | "delete" = replacementText.length === 0 ? "delete" : "replace";
  return {
    kind,
    codepointStart,
    codepointEnd,
    glyphStartInclusive: codepointStart,
    glyphEndInclusive: codepointEnd - 1,
    replacementText,
  };
}
