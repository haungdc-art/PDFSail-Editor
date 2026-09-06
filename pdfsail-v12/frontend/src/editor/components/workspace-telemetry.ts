/**
 * Workspace Telemetry — Document Workspace 交互埋点（B-3）
 *
 * 只记录，不影响业务（沿用 RuntimeTelemetry 的 Observability 纪律）：
 *   - 不修改 Document / Workspace / 编辑核心。
 *   - 只把交互事件写到 console 日志，未来可接入分析后端。
 *
 * 埋点漏斗（B-3）：
 *   selection       用户点击文字（Selection Count）
 *   workspace_open  右侧 Workspace 出现
 *   update_click    Update Text 被点击
 *   translate_click Translate 被点击
 *   explain_click   Explain 被点击
 *   save            编辑保存
 *   cancel          编辑取消
 *
 * 以后可以据此回答：
 *   "92% 用户点 Update，5% 点 Translate，3% 点 Explain"
 *   "Explain 很多人点，但没人继续"
 *   再决定功能优先级，而不是凭感觉。
 */

export type WorkspaceEvent =
  | "selection"
  | "workspace_open"
  | "update_click"
  | "translate_click"
  | "explain_click"
  | "save"
  | "cancel";

export interface WorkspaceEventEntry {
  event: WorkspaceEvent;
  blockId?: string;
  /** 选中文字长度（粗粒度，帮助判断选区大小，不含文本内容） */
  textLen?: number;
  timestamp: string;
}

/** 记录一条 Workspace 交互事件（纯埋点，不影响业务） */
export function recordWorkspaceEvent(
  event: WorkspaceEvent,
  meta?: { blockId?: string; textLen?: number },
): void {
  const entry: WorkspaceEventEntry = {
    event,
    blockId: meta?.blockId,
    textLen: meta?.textLen,
    timestamp: new Date().toISOString(),
  };
  console.log("[WorkspaceTelemetry]", JSON.stringify(entry));
}
