/**
 * corpus-inspector.ts — Corpus Inspector（Sprint-80 Task-003）
 *
 * 自动生成 Corpus Report：让 Benchmark 真正可信。
 * 分析 Golden Corpus 的质量分布：
 *   - 扫描 / 数字件数量
 *   - 平均 DPI
 *   - 平均旋转
 *   - 字体分布
 *   - Signature / Stamp 数量
 *   - OCR 引擎
 *
 * 输入：GoldenSample[]（含 metadata）
 * 输出：CorpusReport
 *
 * 纯逻辑（ADR-005），不依赖 Renderer。Node 可测。
 */

/** Golden 样本的最小输入契约（本模块自包含，避免耦合 tests/benchmark） */
export interface GoldenSampleInput {
  readonly id: string;
  readonly category: string;
  readonly metadata?: {
    readonly scanned?: boolean;
    readonly digital?: boolean;
    readonly dpiX?: number;
    readonly resolution?: number;
    readonly rotation?: number;
    readonly fontType?: string;
    readonly ocrEngine?: string;
    readonly containsSignature?: boolean;
    readonly containsStamp?: boolean;
    readonly containsTable?: boolean;
    readonly containsImage?: boolean;
    readonly containsHandwriting?: boolean;
    readonly containsOCRNoise?: boolean;
  };
}

/** 字体统计条目 */
export interface FontStat {
  readonly fontType: string;
  readonly count: number;
}

/** Corpus Report */
export interface CorpusReport {
  readonly total: number;
  readonly byCategory: Readonly<Record<string, number>>;
  /** 扫描 / 数字件数量 */
  readonly scannedCount: number;
  readonly digitalCount: number;
  /** 平均 DPI（仅统计有 dpiX 的样本） */
  readonly avgDpi: number | null;
  /** 平均旋转角（度） */
  readonly avgRotation: number;
  /** 字体分布 */
  readonly fonts: readonly FontStat[];
  /** 含签名 / 印章 / 表格 / 图片 / 手写 / OCR 噪点 的数量 */
  readonly signatureCount: number;
  readonly stampCount: number;
  readonly tableCount: number;
  readonly imageCount: number;
  readonly handwritingCount: number;
  readonly ocrNoiseCount: number;
  /** OCR 引擎分布 */
  readonly ocrEngines: Readonly<Record<string, number>>;
  /** 数据完整性：多少样本有 metadata */
  readonly withMetadata: number;
}

/** 从 Golden Corpus 生成 Corpus Report */
export function inspectCorpus(samples: readonly GoldenSampleInput[]): CorpusReport {
  let scanned = 0;
  let digital = 0;
  let dpiSum = 0;
  let dpiCount = 0;
  let rotSum = 0;
  let rotCount = 0;
  let signature = 0;
  let stamp = 0;
  let table = 0;
  let image = 0;
  let handwriting = 0;
  let ocrNoise = 0;
  let withMetadata = 0;
  const fontMap = new Map<string, number>();
  const ocrMap = new Map<string, number>();
  const byCategory: Record<string, number> = {};

  for (const s of samples) {
    byCategory[s.category] = (byCategory[s.category] ?? 0) + 1;
    const m = s.metadata;
    if (!m) continue;
    withMetadata++;

    if (m.scanned) scanned++;
    if (m.digital) digital++;

    const dpi = m.dpiX ?? m.resolution;
    if (typeof dpi === "number" && dpi > 0) {
      dpiSum += dpi;
      dpiCount++;
    }

    if (typeof m.rotation === "number") {
      rotSum += Math.abs(m.rotation);
      rotCount++;
    }

    if (m.fontType) fontMap.set(m.fontType, (fontMap.get(m.fontType) ?? 0) + 1);
    if (m.ocrEngine) ocrMap.set(m.ocrEngine, (ocrMap.get(m.ocrEngine) ?? 0) + 1);
    if (m.containsSignature) signature++;
    if (m.containsStamp) stamp++;
    if (m.containsTable) table++;
    if (m.containsImage) image++;
    if (m.containsHandwriting) handwriting++;
    if (m.containsOCRNoise) ocrNoise++;
  }

  return {
    total: samples.length,
    byCategory,
    scannedCount: scanned,
    digitalCount: digital,
    avgDpi: dpiCount > 0 ? Math.round(dpiSum / dpiCount) : null,
    avgRotation: rotCount > 0 ? round2(rotSum / rotCount) : 0,
    fonts: [...fontMap.entries()].map(([fontType, count]) => ({ fontType, count })).sort((a, b) => b.count - a.count),
    signatureCount: signature,
    stampCount: stamp,
    tableCount: table,
    imageCount: image,
    handwritingCount: handwriting,
    ocrNoiseCount: ocrNoise,
    ocrEngines: Object.fromEntries(ocrMap),
    withMetadata,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
