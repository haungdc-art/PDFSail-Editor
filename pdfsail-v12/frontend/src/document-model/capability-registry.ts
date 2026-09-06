/**
 * CapabilityRegistry — 能力注册表 Contract（Task-011A.7 收紧）
 *
 * Registry 是纯 IOC：Name → Command 映射。不知道 Replace/Delete/Rewrite，甚至不知道这是 Edit。
 * 未来可以有 AnnotationCommand / CommentCommand / ExportCommand / AICommand，全部一样。
 *
 * EditTool 只依赖 Registry（resolve(name) → Command.execute()），不 switch 具体命令。
 */
import type { CapabilityName, CapabilityCommand } from "./edit-capability";

export interface CapabilityRegistry {
  /** 按名称解析命令；未注册返回 undefined */
  resolve(name: CapabilityName): CapabilityCommand | undefined;
}
