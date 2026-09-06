/**
 * MapCapabilityRegistry — CapabilityRegistry 的具体实现（Task-011B · Composition Root）
 *
 * 纯 IOC：Name → Command 映射。不知道具体命令，不知道这是 Edit。
 * Composition Root 创建并注入；011C 通过 register() 注册 ReplaceCommand 等。
 */
import type { CapabilityName, CapabilityCommand } from "./edit-capability";
import type { CapabilityRegistry } from "./capability-registry";

export class MapCapabilityRegistry implements CapabilityRegistry {
  private commands = new Map<CapabilityName, CapabilityCommand>();

  register(name: CapabilityName, command: CapabilityCommand): void {
    this.commands.set(name, command);
  }

  resolve(name: CapabilityName): CapabilityCommand | undefined {
    return this.commands.get(name);
  }
}
