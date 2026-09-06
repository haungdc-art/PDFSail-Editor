/**
 * frontend/src/measurement-validator/index.ts — Sprint-84B · Measurement Validator
 *
 * PM Rule-062：Every Failure Must First Pass Measurement Validation。
 * 判断一个 Failure 是真实 Failure 还是 Measurement Artifact。
 * 不是 Prioritizer（Prioritizer 答"哪个最严重"，Validator 答"这个是真的吗"）。
 *
 * Pipeline：Corpus → Benchmark → Measurement Validator → Prioritizer → Root Cause → Fix
 *
 * 模块：
 *   validator.ts          通用校验（real/artifact/unknown）
 *   glyph-validator.ts    glyph-lost 是否伪影（canvas 提取）
 *   geometry-validator.ts 几何类 Failure 校验
 *   pixel-validator.ts    像素类 Failure 校验（对齐前提）
 */
export * from "./validator";
export * from "./glyph-validator";
export * from "./geometry-validator";
export * from "./pixel-validator";
