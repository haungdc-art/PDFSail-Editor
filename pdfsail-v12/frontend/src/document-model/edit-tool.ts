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
 *
 * ── F3B-6.17-3C-10S.3B-2：双轨 selection 的**第二条入口**（Core canonical）────
 * 本文件历史上只有一条 selection 来源：**glyph** 链
 *   `GlyphRenderer → DerivedSelection → CurrentSelection → DocumentSelection`
 * 原生文本（未挂 GlyphRenderer）下该链为 null ⇒ 能力永远不可达（3C-10A 阻塞点）。
 *
 * 3C-10S.3B-1 已建立**并列**的 canonical 链：
 *   `DOM Selection → CanonicalSelection → CanonicalSelectionProvider`
 * 本文件新增**可选注入**的 canonical 入口，仅在 glyph 链**不可用**时被咨询：
 *
 *   glyph 可用   ⇒ 既有路径（**逐字节不变**）
 *   glyph 不可用 ⇒ 有 canonical ⇒ 交 canonical 入口（Core-only，fail-closed）
 *                  无 canonical ⇒ 与既有行为一致（什么都不做）
 *
 * ⚠️ 两条链**不互相转换**：本文件**不**把 canonical 转成 `DocumentSelection`
 *    （那需要 `UTF-16 → glyph` 逆映射，3C-9B / 3C-10S.1 已定案禁止）。
 * ⚠️ canonical 入口**只**在 `document-model` 之外实现（`editor/binding`），
 *    通过结构注入传入 —— 保持 `document-model` 不依赖 `editor/binding` 的方向。
 */
import type { EditIntent } from "./edit-intent";
import type { CapabilityRegistry } from "./capability-registry";
import type { CurrentSelectionProvider } from "./current-selection-provider";
import { currentToDocument } from "./glyph-selection-adapter";

/**
 * canonical 语义选区的**结构投影**（UTF-16）。
 *
 * 刻意在 `document-model` 侧定义结构等价类型（而非 import `editor/binding`），
 * 以保持依赖方向：`editor/binding` → `document-model`，永不反向。
 */
export interface CanonicalSelectionLike {
  readonly blockId: string;
  readonly lineId: string;
  readonly startOffsetUtf16: number;
  readonly endOffsetUtf16: number;
}

/** canonical 选区提供者（生产实现 = `CanonicalSelectionProvider`） */
export interface CanonicalSelectionProviderLike {
  current(): CanonicalSelectionLike | null;
}

export interface CanonicalCoreEntryArgs {
  readonly capability: string;
  readonly selection: CanonicalSelectionLike;
  readonly payload?: Record<string, unknown>;
}

/**
 * Core canonical 入口（由 `editor/binding` 侧装配后注入）。
 *
 * 契约：**Core-only + fail-closed** —— 入口内部自行决定「解析失败 ⇒ 什么都不做」，
 * **不得**回落 Legacy（否则会重新引入 glyph 坐标 bug）。
 */
export interface CanonicalCoreEntry {
  readonly provider: CanonicalSelectionProviderLike;
  execute(args: CanonicalCoreEntryArgs): Promise<void> | void;
}

export class EditTool {
  constructor(
    private registry: CapabilityRegistry,
    private selectionProvider: CurrentSelectionProvider,
    /**
     * 可选：Core canonical 入口（缺省 ⇒ 行为与 3C-10S.3B-2 之前**完全一致**）。
     */
    private canonicalEntry?: CanonicalCoreEntry,
  ) {}

  /** 唯一入口：执行编辑意图。无选中或能力未注册则忽略。 */
  async execute(intent: EditIntent): Promise<void> {
    const selection = this.selectionProvider.current();
    if (!selection) {
      // glyph 链无选区（原生文本 / GlyphRenderer 未挂载）⇒ 咨询 canonical 链
      await this.runCanonicalEntry(intent);
      return;
    }

    // ── M5-IMPLEMENT-001: 多行 mutation safety ──
    // 当前 Mutation 仍为单行 Precise Range。跨行选区（ranges.length > 1）暂不支持 mutation，
    // 在此安全拒绝（NO MUTATION），绝不"只改 first range / last range"或压缩成单行。
    // 单行（ranges 缺失或 length<=1）正常走既有 M4 路径。
    //
    // F3B-6.17-3C-10S.3B-2：折叠 / 多区间同样属「glyph 路径不可用」⇒ 咨询 canonical 链。
    if (selection.isEmpty || (selection.ranges && selection.ranges.length > 1)) {
      await this.runCanonicalEntry(intent);
      return;
    }

    const capability = this.registry.resolve(intent.capability);
    if (!capability) return;

    // M4-IMPL-002A：Provider 仍返回 CurrentSelection（Glyph 通道），
    // 经 GlyphSelectionAdapter 规范化成统一 DocumentSelection 后进入 Command。
    await capability.execute(currentToDocument(selection), intent.payload);
  }

  /**
   * canonical（UTF-16）分支：只在 glyph 路径不可用时运行。
   *
   * 语义（与「双轨 Selection Architecture」一致）：
   *   · 未注入入口 / 无 canonical 选区 / 能力未注册 ⇒ 什么都不做（= 既有 return 行为）
   *   · 有 canonical 选区 ⇒ **canonical 入口为唯一权威**，无论其成功或 fail-closed，
   *     本函数都**不**再走 Legacy（保证 Legacy semantic mutation = 0）
   */
  private async runCanonicalEntry(intent: EditIntent): Promise<void> {
    const entry = this.canonicalEntry;
    if (!entry) return;
    const canonical = entry.provider.current();
    if (!canonical) return;
    if (!this.registry.resolve(intent.capability)) return;
    await entry.execute({
      capability: intent.capability,
      selection: canonical,
      payload: intent.payload,
    });
  }
}
