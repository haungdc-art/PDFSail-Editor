/**
 * benchmark-consumer.ts — BenchmarkConsumer（Sprint-121 · Task-2）
 *
 * ADR-045 · Consumer Architecture。
 *
 * ## 第二个 Consumer：BenchmarkConsumer
 *
 *   Builder → Page（唯一事实来源）
 *     ├──► ValidatorConsumer.consume(DomDocument)   ✅ Task-1
 *     ├──► BenchmarkConsumer.consume(DomDocument)   ← 本文件
 *     └──► ReplayConsumer / SceneConsumer ...（未来）
 *
 * ## 职责
 * 测量 DOM 文档的**完整性/结构健康度**（非 PDF vs Painter 渲染 fidelity，
 * 后者需要 PNG 对照，不适合纯 DOM Consumer）。
 * BenchmarkConsumer 从 DomPage 提取各层对象数量，度量 Page 是否完整。
 *
 * ## 规范（Consumer Architecture）
 * - 实现统一 `Consumer<T, R>` 接口，唯一入口 consume(DomDocument)
 * - 只消费 DOM（DomDocument），**禁止依赖 EditableDocument**
 * - 与 ValidatorConsumer **平行**，不调用 ValidatorConsumer
 * - 纯消费，不修改输入
 *
 * 纯函数（ADR-005），Node 可测。
 */

import { Consumer } from "./consumer";
import { DomDocument } from "./types";
import { DomPage } from "./page";

/** 单页 DOM 完整性指标 */
export interface DomPageBenchmark {
  readonly page: number;
  /** ContentLayer Glyph 对象数 */
  readonly glyphCount: number;
  /** ContentLayer 对象总数 */
  readonly contentObjectCount: number;
  /** BaseLayer 对象数 */
  readonly baseObjectCount: number;
  /** BaseLayer 是否含 PdfFallback（PDF Builder Contract） */
  readonly hasPdfFallback: boolean;
  /** 结构约束是否满足（五层 + BaseLayer 有内容） */
  readonly structuralPass: boolean;
}

/** DOM 完整性 Benchmark 结果 */
export interface DomBenchmarkResult {
  readonly pass: boolean;
  readonly pageCount: number;
  readonly totalGlyphs: number;
  readonly completenessScore: number;
  readonly pages: readonly DomPageBenchmark[];
}

/** 单页指标 */
function measurePage(page: DomPage): DomPageBenchmark {
  const glyphCount = page.layers.content.filter((o) => o.type === "Glyph").length;
  const contentObjectCount = page.layers.content.length;
  const baseObjectCount = page.layers.base.length;
  const hasPdfFallback = page.layers.base.some((o) => o.type === "PdfFallback");
  // 结构约束：BaseLayer 有内容 + ContentLayer 容器存在（内容可为空，空白页合法）
  const structuralPass = baseObjectCount >= 1;
  return {
    page: page.metadata.index,
    glyphCount,
    contentObjectCount,
    baseObjectCount,
    hasPdfFallback,
    structuralPass,
  };
}

/**
 * BenchmarkConsumer：测量 DOM 文档完整性。
 * 只消费 DomDocument，不依赖 EditableDocument，不调用其他 Consumer。
 */
export class BenchmarkConsumer implements Consumer<DomDocument, DomBenchmarkResult> {
  /** Consumer Identity（稳定身份，为 Registry 准备） */
  readonly id = "benchmark";
  consume(document: DomDocument): DomBenchmarkResult {
    const pages = document.pages.map(measurePage);
    const pageCount = pages.length;
    const totalGlyphs = pages.reduce((s, p) => s + p.glyphCount, 0);
    // 完整性得分：结构满足的页占比 × 100
    const structuralPassCount = pages.filter((p) => p.structuralPass).length;
    const completenessScore = pageCount > 0 ? Math.round((structuralPassCount / pageCount) * 100) : 0;
    const pass = completenessScore === 100 && pageCount > 0;
    return { pass, pageCount, totalGlyphs, completenessScore, pages };
  }
}

/** 便捷工厂 */
export function createBenchmarkConsumer(): BenchmarkConsumer {
  return new BenchmarkConsumer();
}
