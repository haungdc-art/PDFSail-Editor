/**
 * ReplayStatus — Sprint38 · S38-2（统一类型定义，已 Freeze）
 *
 * 单一来源的 Replay 状态枚举，供 ReplayResult / ReplayPolicy / ReplayEngine 共享。
 *
 * 独立文件的原因：避免循环依赖。
 *   - replay-result.ts  依赖 replay-status.ts
 *   - replay-policy.ts  依赖 replay-status.ts
 *   - replay-engine.ts  依赖 上述二者
 *
 * 【Freeze】ReplayStatus 枚举已 Freeze。
 */

/**
 * Replay Status — 一次重放的判定。
 *
 * 说明：
 *   - PASS      ：重放成功，判定在容差内。
 *   - FAIL      ：重放成功，判定超过容差（且未回归）。
 *   - REGRESSION：重放成功，但比第一次实验更差（如 afterDelta > beforeDelta）。
 *   - ERROR     ：重放执行时抛错（Runtime Crash）。
 *   - SKIPPED   ：无法重放（如无 Sample）。
 *   - UNKNOWN   ：状态未知。
 */
export type ReplayStatus =
  | "PASS"
  | "FAIL"
  | "REGRESSION"
  | "ERROR"
  | "SKIPPED"
  | "UNKNOWN";
