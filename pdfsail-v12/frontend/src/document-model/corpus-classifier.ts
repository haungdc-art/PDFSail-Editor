/**
 * CorpusClassifier — Sprint40-M1/M2（Real Corpus 建立与分类）
 *
 * 扫描 PDF 目录，用 Product Import（parsePdfToEditableDocument）分类：
 *   - text-corpus：有文本层 → Edit Text Baseline 样本
 *   - scan-corpus ：无文本层 → OCR 样本
 *
 * 【职责】
 *   - 只调 Product Import（parsePdfToEditableDocument），不实现 Import/Export。
 *   - 输出分类清单 + 每个 PDF 的页数/文本量（供 Runner/QA 选样本）。
 *   - 符合 Responsibility Matrix：Import 允许知道 PDF/EditableDocument。
 *
 * 【纪律】不修改任何冻结模块。
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parsePdfToEditableDocument } from "./pdf-importer";

/** 单个 PDF 的分类结果 */
export interface CorpusItem {
  /** 文件名 */
  file: string;
  /** 页数 */
  pages: number;
  /** 文本 glyph 总数 */
  glyphs: number;
  /** 是否有文本层 */
  hasTextLayer: boolean;
  /** text-corpus / scan-corpus / error */
  type: "text-corpus" | "scan-corpus" | "error";
  /** 错误信息（type=error 时） */
  error?: string;
}

/** Corpus 分类结果 */
export interface CorpusClassification {
  /** 扫描总数 */
  total: number;
  /** text-corpus 数 */
  textCorpusCount: number;
  /** scan-corpus 数 */
  scanCorpusCount: number;
  /** error 数 */
  errorCount: number;
  /** 全部条目 */
  items: CorpusItem[];
  /** 仅 text-corpus（Edit Text 样本） */
  textCorpus: CorpusItem[];
  /** 仅 scan-corpus（OCR 样本） */
  scanCorpus: CorpusItem[];
}

/**
 * 扫描目录中的 PDF 并分类。
 *
 * @param dir PDF 目录
 * @returns CorpusClassification
 */
export async function classifyCorpusDir(dir: string): Promise<CorpusClassification> {
  const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".pdf"));
  const items: CorpusItem[] = [];

  for (const file of files) {
    try {
      const bytes = new Uint8Array(await readFile(join(dir, file)));
      const doc = await parsePdfToEditableDocument(bytes, file);
      const glyphs = doc.pages.reduce(
        (s, p) => s + p.blocks.reduce(
          (b, blk) => b + blk.lines.reduce((l, ln) => l + ln.glyphs.length, 0),
          0,
        ),
        0,
      );
      const hasTextLayer = glyphs > 0;
      items.push({
        file,
        pages: doc.pages.length,
        glyphs,
        hasTextLayer,
        type: hasTextLayer ? "text-corpus" : "scan-corpus",
      });
    } catch (e) {
      items.push({
        file,
        pages: -1,
        glyphs: -1,
        hasTextLayer: false,
        type: "error",
        error: String(e).slice(0, 100),
      });
    }
  }

  return {
    total: items.length,
    textCorpusCount: items.filter((i) => i.type === "text-corpus").length,
    scanCorpusCount: items.filter((i) => i.type === "scan-corpus").length,
    errorCount: items.filter((i) => i.type === "error").length,
    items,
    textCorpus: items.filter((i) => i.type === "text-corpus"),
    scanCorpus: items.filter((i) => i.type === "scan-corpus"),
  };
}

/**
 * 从分类中选出 Edit Text Baseline 样本（text-corpus，优先多页/多文本）。
 *
 * @param classification 分类结果
 * @param max 最多选几个
 */
export function selectEditTextSamples(
  classification: CorpusClassification,
  max: number,
): CorpusItem[] {
  return classification.textCorpus
    .sort((a, b) => b.glyphs - a.glyphs)
    .slice(0, max);
}
