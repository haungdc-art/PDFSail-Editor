/**
 * EditTool — 编辑工具统一入口（Task-011A · Capability Adapter）
 *
 * 依赖方向（Principle-12）：
 *   Toolbar / Shortcut / Context Menu / AI / API
 *        ↓
 *   EditTool.execute(intent)
 *        ↓
 *   CapabilityRegistry.resolve(name)
 *        ↓
 *   Capability.execute()
 *        ↓
 *   Mutation（011C 接入）
 *
 * EditTool 只知道 Registry，不知道具体能力（replace/rewrite/delete）。
 * 未来新增能力只加 Registry 条目，EditTool 不改。
 * 无 Button / 无 React UI / 无 Mutation。
 */
import type { EditIntent } from "./edit-intent";
import type { CapabilityRegistry } from "./capability-registry";
import type { CurrentSelectionProvider } from "./current-selection-provider";
import { currentToDocument } from "./glyph-selection-adapter";

export class EditTool {
  constructor(
    private registry: CapabilityRegistry,
    private selectionProvider: CurrentSelectionProvider,
  ) {}

  /** 唯一入口：执行编辑意图。无选中或能力未注册则忽略。 */
  async execute(intent: EditIntent): Promise<void> {
    const selection = this.selectionProvider.current();
    if (!selection || selection.isEmpty) return;

    // ── M5-IMPLEMENT-001: 多行 mutation safety ──
    // 当前 Mutation 仍为单行 Precise Range。跨行选区（ranges.length > 1）暂不支持 mutation，
    // 在此安全拒绝（NO MUTATION），绝不"只改 first range / last range"或压缩成单行。
    // 单行（ranges 缺失或 length<=1）正常走既有 M4 路径。
    if (selection.ranges && selection.ranges.length > 1) return;

    const capability = this.registry.resolve(intent.capability);
    if (!capability) return;

    // M4-IMPL-002A：Provider 仍返回 CurrentSelection（Glyph 通道），
    // 经 GlyphSelectionAdapter 规范化成统一 DocumentSelection 后进入 Command。
    await capability.execute(currentToDocument(selection), intent.payload);
  }
}
