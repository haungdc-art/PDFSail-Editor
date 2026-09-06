/**
 * CurrentSelectionProvider — CurrentSelection Contract（Task-011A.5）
 *
 * 谁负责提供当前 Selection（Edit 的上下文）。这是一个 Contract（非 Store / 非 React Context）。
 *
 * 未来真正实现 SelectionStore 时，只需实现本 Provider 接口，EditTool 一行不用改。
 * Toolbar / Shortcut / AI / API 统一通过本接口获取 CurrentSelection。
 */
import type { CurrentSelection } from "./current-selection";

export interface CurrentSelectionProvider {
  /** 返回当前选中内容；无选中时返回 null */
  current(): CurrentSelection | null;
}
