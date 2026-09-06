/**
 * validator-consumer.ts — ValidatorConsumer（Sprint-121 · Task-1）
 *
 * ADR-045 · Document Object Model (DOM) for AI Documents。
 *
 * ## 这是第一个真正消费 DOM 的 Consumer
 *
 * Sprint-120 建立了 Builder → Page 的生产链。Sprint-121 Task-1 建立第一个 Consumer：
 *
 *   Builder
 *       │
 *       ▼
 *   Page（唯一事实来源）
 *       │
 *       ▼
 *   ValidatorConsumer.consume(DomDocument) → validateDom → PASS/FAIL
 *
 * ## 方向性（PM 强调）
 *
 * **Consumer 主动消费 Builder，而不是 Builder 主动调用 Consumer。**
 * 因此 Validator 不在 Builder 内部调用；Builder 保持零改动。
 *
 * ## 约束
 * - ValidatorConsumer 只依赖 DOM（DomDocument / DomPage），**禁止 EditableDocument**。
 * - 纯消费层，不生产、不改 Builder、不影响 Runtime。
 *
 * 纯类型 + 纯函数（ADR-005），Node 可测。
 */

import { Consumer } from "./consumer";
import { DomDocument } from "./types";
import { validateDom, DomValidationResult } from "./dom-validator";

/** ValidatorConsumer：校验 DOM 文档结构合法性 */
export class ValidatorConsumer implements Consumer<DomDocument, DomValidationResult> {
  /** Consumer Identity（稳定身份，为 Registry 准备） */
  readonly id = "validator";
  /**
   * 消费一个 DOM 文档，返回校验结果。
   * 只依赖 DOM（DomDocument），不依赖 EditableDocument。
   * @param document DOM 文档（Builder 产出）
   * @returns 校验结果（pass/issues）
   */
  consume(document: DomDocument): DomValidationResult {
    return validateDom(document.pages);
  }
}

/** 便捷工厂：创建 ValidatorConsumer */
export function createValidatorConsumer(): ValidatorConsumer {
  return new ValidatorConsumer();
}
