/**
 * LoggingGeometryConsumer — Sprint36 · Commit 2D（观察器）
 *
 * GeometryConsumer Port 的 Logging 实现。
 *
 *   GeometryDecisionAdapter → GeometryBatch
 *        ↓
 *   LoggingGeometryConsumer.consume()
 *        ↓
 *   console.log / 记录（证明请求真正驱动 Geometry Consumer）
 *
 * 【唯一目标】证明 GeometryRequest 已经真正开始驱动 Geometry Consumer。
 * 这是一个【观察器（Logging Consumer）】，不是模拟实现，因此不叫 Fake。
 *
 * 【明确禁止】
 *   - 不返回任何 GeometryResult。
 *   - 不做 Rotation / Polygon / Quad / Region Merge / Renderer。
 *
 * 属于 Infrastructure Port 实现（非 Engine / Domain）。
 */

import type { GeometryBatch, GeometryConsumer } from "./document-pipeline";

/**
 * Logging Geometry Consumer — 只记录收到的 Batch，不做任何几何处理。
 */
export const LoggingGeometryConsumer: GeometryConsumer = {
  consume(batch: GeometryBatch): void {
    for (const request of batch.requests) {
      console.log(
        "[GeometryConsumer] consume:", JSON.stringify(request),
      );
    }
  },
};
