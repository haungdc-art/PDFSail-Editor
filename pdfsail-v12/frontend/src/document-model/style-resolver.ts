/**
 * StyleResolver — 文档级样式注册与去重（Task 4 核心）
 *
 * 职责：
 *   管理 EditableDocument.styles 数组，提供 register/dehash 功能。
 *   glyph.styleRef 指向此数组索引，避免每 glyph 复制 style。
 *
 * 使用方式：
 *   const resolver = new StyleResolver();
 *   const ref = resolver.register({ fontFamily: "Helvetica", fontSize: 14 });
 *   // ... 多个 glyph 共用同一 ref
 *   const doc = { pages, styles: resolver.toArray(), metadata };
 *
 * 去重策略：
 *   按 style 的 JSON 序列化字符串做 Map 查找。
 *   相同 style 返回同一索引。
 *
 * 合并策略：
 *   register(base, override) → 合并 base + override 后注册。
 *   用于 OCR 推断：base = 页面统计 style，override = block 特有 fontSize。
 */

import type { EditableStyle } from "./types";

/** Style 去重的序列化键（稳定字段顺序） */
function styleKey(s: EditableStyle): string {
  // 按 key 字母序序列化，保证相同内容相同键
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(s).sort()) {
    const v = (s as any)[k];
    if (v === undefined) continue;
    // transform 是数组，需 JSON 序列化
    ordered[k] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return JSON.stringify(ordered);
}

export class StyleResolver {
  private styles: EditableStyle[] = [];
  private keyToIndex = new Map<string, number>();

  /**
   * 注册一个样式，返回索引（styleRef）。
   * 相同内容自动去重，返回已有索引。
   *
   * @param style 要注册的样式
   * @returns styles 数组中的索引
   */
  register(style: EditableStyle): number {
    const key = styleKey(style);
    const existing = this.keyToIndex.get(key);
    if (existing !== undefined) return existing;

    const idx = this.styles.length;
    // 深拷贝避免外部修改影响已注册样式
    this.styles.push({ ...style });
    this.keyToIndex.set(key, idx);
    return idx;
  }

  /**
   * 注册合并后的样式：base + override。
   * override 中的字段覆盖 base。
   *
   * 用于 OCR 推断：
   *   resolver.merge(pageStatStyle, { fontSize: blockSpecificSize })
   */
  merge(base: EditableStyle, override: Partial<EditableStyle>): number {
    const merged: EditableStyle = { ...base, ...override };
    return this.register(merged);
  }

  /**
   * 按索引获取样式（只读）。
   */
  get(index: number): EditableStyle | undefined {
    return this.styles[index];
  }

  /**
   * 获取所有已注册样式（用于填充 EditableDocument.styles）。
   */
  toArray(): EditableStyle[] {
    return this.styles.map((s) => ({ ...s }));
  }

  /** 已注册样式数量 */
  get size(): number {
    return this.styles.length;
  }
}
