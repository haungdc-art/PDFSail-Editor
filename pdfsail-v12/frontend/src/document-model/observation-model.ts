/**
 * observation-model.ts — 统一 Observation Model（Sprint45 · Validation Baseline）
 *
 * layer: Core（Sprint45 Architecture Freeze 冻结）
 *
 * 目的：所有 Validation Tool（Importer / pdf.js / extractPdfText / OCR / Renderer）
 *       都输出统一的 Observation，可逐项对比、可追踪。
 *
 * 设计：Observation 定义"一份 PDF 的可观测事实"，并携带结构化 trace
 *       （block / item 级定位），使 Diff 能追踪到具体对象。
 */
import type { EditableDocument } from "./types";

/** 单页观察（含结构化 trace） */
export interface PageObservation {
  page: number;
  /** 该页所有文本（原始拼接，保留空白差异） */
  text: string;
  /** 单词数 */
  wordCount: number;
  /** 第一个单词（词级归一化） */
  firstWord: string;
  /** 文本块数（bbox 数） */
  bboxCount: number;
  /** 结构化 trace：各 block/item 的文本（Importer 用 blockId，pdf.js 用 index） */
  items: Array<{ id: string; text: string }>;
}

/** 整份 PDF 的统一观察 */
export interface Observation {
  /** 观察来源（importer / pdfjs / extract / ocr / renderer / ground-truth） */
  source: string;
  /** PDF 标识（文件名或哈希） */
  documentId: string;
  /** 总页数 */
  pageCount: number;
  /** 每页观察 */
  pages: PageObservation[];
  /** 全文（跨页，空格连接） */
  fullText: string;
  /** 全文单词数 */
  totalWordCount: number;
}

/** 从 EditableDocument 生成 Observation（Importer 视角，带 block trace） */
export function observeFromDocument(doc: EditableDocument, documentId: string): Observation {
  const pages: PageObservation[] = doc.pages.map((p, i) => {
    const items: Array<{ id: string; text: string }> = [];
    const texts: string[] = [];
    let bboxCount = 0;
    for (const b of p.blocks) {
      if (b.type !== "text") continue;
      bboxCount += 1;
      const blockTexts: string[] = [];
      for (const l of b.lines) {
        const glyphs = l.glyphs.map((g) => g.char).join("");
        if (glyphs) blockTexts.push(glyphs);
      }
      const blockText = blockTexts.join(" ");
      if (blockText) {
        items.push({ id: b.id, text: blockText });
        texts.push(blockText);
      }
    }
    const text = texts.join(" ").trim();
    const words = text.match(/[A-Za-z0-9]+/g) || [];
    return {
      page: i + 1,
      text,
      wordCount: words.length,
      firstWord: words[0] ?? "",
      bboxCount,
      items,
    };
  });
  const fullText = pages.map((p) => p.text).join(" ").trim();
  return {
    source: "importer",
    documentId,
    pageCount: pages.length,
    pages,
    fullText,
    totalWordCount: pages.reduce((n, p) => n + p.wordCount, 0),
  };
}

/**
 * 从 pdf.js / extractPdfText 的原始输出生成 Observation（带 item trace）。
 * @param rawPages 每页的文本 item 列表（{ text }[]）
 */
export function observeFromExtracted(
  source: string,
  rawPages: Array<Array<{ text: string }>>,
  documentId: string,
): Observation {
  const pages: PageObservation[] = rawPages.map((itemsRaw, i) => {
    const items = itemsRaw.map((it, idx) => ({ id: `item${idx + 1}`, text: it.text }));
    const text = items.map((it) => it.text).join("").trim();
    const words = text.match(/[A-Za-z0-9]+/g) || [];
    return {
      page: i + 1,
      text,
      wordCount: words.length,
      firstWord: words[0] ?? "",
      bboxCount: items.length,
      items,
    };
  });
  const fullText = pages.map((p) => p.text).join(" ").trim();
  return {
    source,
    documentId,
    pageCount: pages.length,
    pages,
    fullText,
    totalWordCount: pages.reduce((n, p) => n + p.wordCount, 0),
  };
}
