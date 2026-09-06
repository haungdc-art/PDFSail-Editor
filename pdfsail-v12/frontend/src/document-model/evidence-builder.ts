/**
 * Evidence Capture Pipeline — Sprint38 · S38-2
 *
 * 监听 GeometryCompleted Event（DTO），用 Evidence Policy 判定，
 * 组装 EvidencePackage 并存入 EvidenceStore。
 *
 *   GeometryCompleted Event
 *        ↓
 *   EvidenceBuilder（订阅）
 *        ├── EvidencePolicy（evaluate → EvidenceDecision）
 *        ├── create Sample
 *        ├── create FailureRecord
 *        ├── assemble EvidencePackage
 *        ▼
 *   EvidenceStore
 *
 * 【CR-2】Builder 不计算 delta——delta 由 EvidencePolicy.evaluate 计算。
 * 【Freeze 纪律】EvidenceBuilder may assemble, but never interpret.
 *   Builder 只 assemble/bind/aggregate，不 normalize/categorize/infer/filter/compute score。
 */

import type { GeometryCompletedEvent } from "./geometry-events";
import type { EvidenceBuilder, EvidenceStore } from "./evidence-package";
import type { EvidencePolicy } from "./evidence-policy";
import type { SampleStore } from "./sample-store";
import type { FailureRecord } from "./failure-corpus";

/**
 * 从 Event（DTO）创建 FailureRecord。
 *
 * expected angle = sample.expected.angle。
 * actual angle = event.geometryAngle（DTO 已提供）。
 */
function makeFailure(
  event: GeometryCompletedEvent,
  expectedAngle: number,
  delta: number,
): FailureRecord {
  return {
    id: `failure-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    documentId: event.documentId,
    page: event.page,
    traceVersion: event.decisionTrace.version,
    decisionTrace: event.decisionTrace,
    expectedAngle,
    actualAngle: event.geometryAngle,
    delta,
  };
}

/**
 * Evidence Capture Pipeline — 把 GeometryCompleted Event 转为 Evidence。
 *
 * 依赖（注入）：
 *   - policy：Evidence Policy（compute delta + Threshold，Mutable）
 *   - samples：SampleStore（Sample）
 *   - assembler：EvidenceBuilder（组装 Package）
 *   - store：EvidenceStore（保存）
 */
export interface EvidenceCapturePipeline {
  /** 处理一个 GeometryCompleted Event */
  handle(event: GeometryCompletedEvent): void;
}

/**
 * 创建 Evidence Capture Pipeline。
 */
export function createEvidenceCapturePipeline(deps: {
  policy: EvidencePolicy;
  samples: SampleStore;
  assembler: EvidenceBuilder;
  store: EvidenceStore;
}): EvidenceCapturePipeline {
  return {
    handle(event: GeometryCompletedEvent): void {
      const sample = deps.samples.get(`sample-${event.documentId}-${event.page}`);
      if (!sample) return;

      // 【CR-2 + CR-3】delta 由 Policy 计算并返回 Decision（Builder 不计算）
      const decision = deps.policy.evaluate(sample.expected.angle, event.geometryAngle);

      if (!decision.save) return;

      const failure = makeFailure(event, sample.expected.angle, decision.delta);
      const pkg = deps.assembler.assemble(sample, failure);
      deps.store.save(pkg);
    },
  };
}
