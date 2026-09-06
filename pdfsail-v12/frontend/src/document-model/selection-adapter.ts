/**
 * SelectionAdapter — Selection 适配 Contract（Task-011A.6 收紧）
 *
 * 泛型 Contract：把"各种 Selection 来源"（Legacy Segment / OCR / Search / AI Highlight / Annotation）
 * 统一转换为 CurrentSelection（Glyph 上下文）。
 *
 * Contract 固定的是 SelectionAdapter，不是 Legacy。
 * LegacySelectionAdapter 只是第一个实现（Migration Layer）。
 *
 * 本文件仅定义 Contract（不实现 Mapping / 不接线 / 不 Mutation）。
 * CurrentSelection 完全不知道 Legacy 世界（无 segmentId / startOffset / fullText）。
 */
import type { CurrentSelection } from "./current-selection";

/** 泛型 Selection 适配 Contract */
export interface SelectionAdapter<From> {
  toCurrentSelection(source: From): CurrentSelection;
}

/** Legacy Segment Selection 的输入形态（字符级：segment + 字符偏移） */
export interface LegacySelection {
  segmentId: string;
  selectedText: string;
  startOffset: number;
  endOffset: number;
  fullText: string;
  lineId: string;
}

/**
 * LegacySelectionAdapter — SelectionAdapter 的第一个实现（Migration Layer）。
 * 把 Legacy Segment Selection → CurrentSelection。
 * 映射实现（segment 字符 offset → glyph index）在 Task-011B/011C 及后续完成。
 */
export interface LegacySelectionAdapter extends SelectionAdapter<LegacySelection> {}
