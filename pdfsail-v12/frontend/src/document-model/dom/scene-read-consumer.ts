/**
 * scene-read-consumer.ts — SceneReadConsumer（Sprint-121 · Task-4 · Pilot）
 *
 * ADR-045 · Consumer Architecture。
 *
 * ## 第四个 Consumer：Scene Read Consumer（Pilot）
 *
 *   Builder → Page（唯一事实来源）
 *     ├──► ValidatorConsumer（是否合法）
 *     ├──► BenchmarkConsumer（是否完整）
 *     ├──► ReplayConsumer（是否一致）
 *     └──► SceneReadConsumer.consume(DomDocument) → SceneSnapshot（本文件）
 *
 * ## 范围（PM 收紧，Pilot 只做 Scene Read）
 *
 * 只负责：`consume(Page) → Scene Snapshot`。
 * **不允许**：
 *   - Scene → Painter（渲染）
 *   - Scene → Bitmap
 *   - Scene → Canvas
 *   - Scene Build / Scene Optimize / Scene Cache
 *
 * ## 无损表达（Lossless Representation，PM 新增退出条件）
 *
 * Scene 必须是 DOM 的**无损表达**。Page → Scene → Replay Fingerprint 应与 Page → Fingerprint 一致。
 * 若丢失 Annotation / Form / BaseLayer / RuntimeRef / Anchor 任一，Task-4 不结束。
 *
 * 验证方式：复用 ReplayConsumer 的 Deterministic Fingerprint 作为回归工具（不重设计比较机制）。
 *
 * ## 规范（Consumer Architecture）
 * - 实现统一 `Consumer<T,R>`，唯一入口 consume(DomDocument)，稳定 id
 * - 只消费 DOM，**禁止 EditableDocument**
 * - 与 Validator/Benchmark/Replay 平行，不调用其他 Consumer
 * - 纯消费，只读快照，不修改输入
 *
 * 纯函数（ADR-005），Node 可测。
 */

import { Consumer } from "./consumer";
import { DomDocument, DomPage } from "./types";

/** Scene Snapshot 单页（DomPage 的无损快照，五层 + runtime） */
export type ScenePage = DomPage;

/** Scene Snapshot：DOM 的无损表达（只读快照） */
export interface SceneSnapshot {
  readonly pages: readonly ScenePage[];
}

/**
 * 从 DomDocument 构建 Scene Snapshot（无损表达）。
 * ScenePage = DomPage 的无损快照（metadata + 五层 + runtime），**浅拷贝**保证快照独立，
 * 后续修改原 document 不影响 snapshot。只读快照：不反写 DOM，不产生渲染对象（无 bitmap/canvas）。
 */
export function buildSceneSnapshot(document: DomDocument): SceneSnapshot {
  return {
    pages: document.pages.map((page) => ({
      metadata: { ...page.metadata },
      layers: {
        base: [...page.layers.base],
        content: [...page.layers.content],
        interaction: [...page.layers.interaction],
        overlay: [...page.layers.overlay],
      },
      runtime: { ...page.runtime },
    })),
  };
}

/**
 * 无损验证：Scene Snapshot 是否完整承载 DOM 信息。
 * 通过对比 DOM 与 Scene 的确定性指纹是否一致。
 * @param document 原 DOM
 * @param snapshot Scene Snapshot
 * @param fingerprintOf 指纹函数（注入 ReplayConsumer.fingerprintOf 作为回归工具）
 * @returns 是否无损
 */
export function isLossless(
  document: DomDocument,
  snapshot: SceneSnapshot,
  fingerprintOf: (d: DomDocument) => string,
): boolean {
  return fingerprintOf(document) === fingerprintOf(snapshot as unknown as DomDocument);
}

/**
 * SceneReadConsumer：Pilot，只做 Page → Scene Snapshot（只读，无损）。
 * 不渲染（无 Painter/Bitmap/Canvas），不构建/优化/缓存。
 */
export class SceneReadConsumer implements Consumer<DomDocument, SceneSnapshot> {
  /** Consumer Identity（稳定身份，为 Registry 准备） */
  readonly id = "scene-read";
  consume(document: DomDocument): SceneSnapshot {
    return buildSceneSnapshot(document);
  }
}

/** 便捷工厂 */
export function createSceneReadConsumer(): SceneReadConsumer {
  return new SceneReadConsumer();
}
