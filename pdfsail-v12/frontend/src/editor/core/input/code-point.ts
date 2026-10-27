/**
 * editor/core/input/code-point.ts — UTF-16 code point 步进（**单一实现**）
 *
 * F3B-6.21-F2：从 `keyboard.ts` 提取为独立模块，原因只有一个 ——
 *
 *   裁决 2（6.21-F / F1）：**步进原语必须导出并复用，不得出现第二套实现**。
 *
 *   ```
 *   keyboard.ts      previousPosition / nextPosition   ─┐
 *                                                       ├─▶ code-point.ts（唯一实现）
 *   word-boundary.ts 词边界扩展                        ─┘
 *   ```
 *
 * 若把 resolver 的步进内联或复制到 `word-boundary.ts`，emoji / surrogate 的行为
 * 就会在两条 primitive 之间分叉（这正是裁决要杜绝的）。
 */

/** 前一个 code point 的起点（代理对整体后退一步） */
export function stepBack(text: string, offset: number): number {
  if (offset <= 0) return 0;
  if (offset >= 2) {
    const code = text.codePointAt(offset - 2);
    if (code !== undefined && code > 0xffff) return offset - 2;
  }
  return offset - 1;
}

/** 后一个 code point 的起点（代理对整体前进一步） */
export function stepForward(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  const code = text.codePointAt(offset);
  const step = code !== undefined && code > 0xffff ? 2 : 1;
  return Math.min(text.length, offset + step);
}
