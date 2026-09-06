/**
 * SampleStore — Sprint38 · S38-5（PDF Sample Manager）
 *
 * 管理原始样本（PDF/图片/OCR/期望值）。
 *
 * 【S38-0 架构调整】SampleStore 只负责 sample：
 *   - 知道 pdfRef / thumbnail / ocrRef / page
 *   - 【不知道】Failure / Trace / Replay（那些属于 EvidencePackage / EvidenceStore）
 *
 *   Failure + Sample + Trace 的绑定由 EvidencePackage 承担（evidence-package.ts）。
 *
 * 【S38-5】Mutable 层，纯数据管理，不依赖 Runtime。
 */

/**
 * Sample — 一个原始样本（不含 Failure/Trace 关联）。
 */
export interface Sample {
  /** 样本 id（Replay 引用） */
  id: string;
  /** PDF 引用 */
  pdfRef: string;
  /** 缩略图引用（可选） */
  thumbnail?: string;
  /** 图片引用（可选） */
  imageRef?: string;
  /** OCR 结果引用（可选） */
  ocrRef?: string;
  /** 页码 */
  page: number;
  /** 期望结果（角度/多边形等） */
  expected: { angle: number };
}

/**
 * SampleStore — 样本存储契约（只管 sample）。
 */
export interface SampleStore {
  /** 添加样本 */
  add(sample: Sample): void;
  /** 按 id 获取样本 */
  get(id: string): Sample | undefined;
  /** 全部样本 */
  samples(): readonly Sample[];
  /** 样本数 */
  size(): number;
}

/**
 * 从文档 id + 页码创建 Sample（S38-1 Runtime Hook 使用）。
 */
export function createSample(
  documentId: string,
  page: number,
  expectedAngle: number,
): Sample {
  return {
    id: `sample-${documentId}-${page}`,
    pdfRef: `samples/${documentId}/page-${page}.pdf`,
    page,
    expected: { angle: expectedAngle },
  };
}

/**
 * 默认 SampleStore 实现（内存存储，Mutable）。
 */
export class DefaultSampleStore implements SampleStore {
  private readonly items = new Map<string, Sample>();

  add(sample: Sample): void {
    this.items.set(sample.id, sample);
  }

  get(id: string): Sample | undefined {
    return this.items.get(id);
  }

  samples(): readonly Sample[] {
    return [...this.items.values()];
  }

  size(): number {
    return this.items.size;
  }
}
