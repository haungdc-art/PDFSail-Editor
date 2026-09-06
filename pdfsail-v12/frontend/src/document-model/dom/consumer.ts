/**
 * consumer.ts — DOM Consumer 统一接口（Sprint-121 · Task-1）
 *
 * ADR-045 · Document Object Model (DOM) for AI Documents。
 *
 * ## Consumer Adoption 核心原则（PM）
 *
 * Consumer 主动消费 Builder，而不是 Builder 主动调用 Consumer。
 * Builder 只产出 Page 就结束；各 Consumer（Validator/Benchmark/Replay/Scene/Painter/Workspace）
 * 通过统一接口 consume(PageDocument)。
 *
 *   Builder
 *       │
 *       ▼
 *   Page（唯一事实来源）
 *       │
 *  ┌─────┼─────────┐
 *  ▼     ▼         ▼
 * Validator Benchmark Replay
 *
 * ## 为什么必须统一接口
 *
 * 否则 Builder 会不断被塞入 Validator/Benchmark/Replay/Scene...，
 * Builder 又重新知道所有 Consumer，违反 Sprint-120 建立的方向。
 *
 * ## 约定
 * - 所有 Consumer 只依赖 DOM（Page / Document），**禁止依赖 EditableDocument**。
 * - Consumer 是纯消费层，不生产、不改 Builder、不影响 Runtime。
 * - 每个 Consumer 有**稳定身份**（Consumer Identity），为未来 Consumer Registry 准备。
 *   不是为了动态加载/插件，而是所有 Consumer 都有稳定 id。
 *
 * 纯类型 + 纯函数（ADR-005），Node 可测。
 */

/**
 * 统一 Consumer 接口。
 * @param T 消费的模型（DOM：DomPage / DomDocument）
 * @param R 消费结果
 */
export interface Consumer<T, R> {
  /** Consumer 稳定身份（如 "validator" / "benchmark" / "replay"），为 Registry 准备 */
  readonly id: string;
  /** 消费模型，返回结果 */
  consume(model: T): R;
}

/** 空实现（默认 Consumer，不做任何事） */
export class NoopConsumer<T, R> implements Consumer<T, R> {
  constructor(
    private readonly defaultValue: R,
    readonly id: string = "noop",
  ) {}
  consume(_model: T): R {
    return this.defaultValue;
  }
}
