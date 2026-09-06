/**
 * frontend/src/adobe-fidelity/index.ts — Sprint-80 · Adobe Fidelity Closing
 *
 * Mission：开始真正提升 Fidelity（PM Rule-048：本次修改让 Adobe Fidelity 提升了多少）。
 * 冻结纪律：不修改 Renderer / Painter / Dispatcher / Registry / Layout / Semantic / OCR。
 *
 * 模块：
 *   failure-analyzer.ts   Task-001：Failure → Root Cause → Fix Suggestion
 *   fix-suggestion.ts     Task-001：根因 → 修复目标
 *   failure-report.ts     Task-001：整批失败聚合（Top Failure）
 *   trend-analyzer.ts     Task-002：Fidelity 收敛趋势预测
 *   corpus-inspector.ts   Task-003：Corpus 质量自动分析
 *   replay-model.ts       Task-004：统一 Failure Replay 数据模型
 *
 * Sprint-81：
 *   failure-prioritizer.ts Task-001：FailureReport → Top Root Cause（PM Rule-049）
 */
export * from "./failure-analyzer";
export * from "./fix-suggestion";
export * from "./failure-report";
export * from "./trend-analyzer";
export * from "./corpus-inspector";
export * from "./replay-model";
export * from "./failure-prioritizer";
