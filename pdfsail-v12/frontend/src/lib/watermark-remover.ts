/**
 * watermark-remover.ts — AI Watermark Removal Engine
 *
 * 基于 pdf-lib 的客户端水印检测与移除。
 *
 * 支持类型：
 *   1. Annotation Watermark  — 直接删除 /Annots 中 Subtype=Watermark
 *   2. Text Watermark        — 解析 content stream，移除疑似水印的文本块
 *   3. Image Watermark       — 删除疑似水印的 XObject Image
 *
 * 扫描件检测：
 *   - 页面无文本层 + 仅一张大图覆盖整页 → 判定为扫描件，返回 unsupported
 */

import { PDFDocument, PDFName, PDFRawStream, PDFStream } from "pdf-lib";

export type WatermarkType = "annotation" | "text" | "image";

export interface DetectedWatermark {
  id: string;
  type: WatermarkType;
  content: string;
  pages: number[];
  confidence: number; // 0-1
}

export interface WatermarkAnalysisResult {
  isScanned: boolean;
  scannedReason?: string;
  watermarks: DetectedWatermark[];
}

export interface RemovalResult {
  removed: DetectedWatermark[];
  outputBytes: Uint8Array;
  originalSize: number;
  newSize: number;
}

// 水印关键词匹配
const WATERMARK_KEYWORDS = [
  "confidential", "draft", "sample", "trial", "evaluation",
  "do not copy", "not for distribution", "internal use",
  "watermark", "preview", "demo", "test only",
  "草稿", "样本", "机密", "内部", "测试",
];

/**
 * 分析 PDF，检测水印
 */
export async function analyzeWatermarks(
  pdfBytes: ArrayBuffer | Uint8Array
): Promise<WatermarkAnalysisResult> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = doc.getPages();

  // 1. 扫描件检测：检查所有页面是否都没有文本，且只有一张图片
  let scannedCount = 0;
  for (const page of pages) {
    const textCount = countTextOperators(page);
    const imageCount = countImageXObjects(page);
    if (textCount === 0 && imageCount === 1) {
      scannedCount++;
    }
  }
  // 如果超过 50% 的页面是扫描件样式，判定为扫描件
  if (pages.length > 0 && scannedCount / pages.length > 0.5) {
    return {
      isScanned: true,
      scannedReason:
        "This appears to be a scanned PDF where watermarks are fused into images and cannot be removed losslessly.",
      watermarks: [],
    };
  }

  const watermarks: DetectedWatermark[] = [];
  let idCounter = 0;

  // 2. Annotation 水印检测
  for (let i = 0; i < pages.length; i++) {
    const annots = pages[i].node.Annots();
    if (!annots) continue;
    const annotArray = annots.asArray();
    for (const annot of annotArray) {
      if (annot instanceof PDFStream || annot.toString().includes("Subtype")) {
        const annotStr = annot.toString();
        if (annotStr.includes("/Watermark") || annotStr.includes("/Subtype/Watermark")) {
          const content = extractTextFromAnnot(annotStr);
          watermarks.push({
            id: `annot-${idCounter++}`,
            type: "annotation",
            content: content || "Annotation Watermark",
            pages: [i + 1],
            confidence: 0.99,
          });
        }
      }
    }
  }

  // 3. Text 水印检测（基于关键词 + 文本特征）
  const textMatches: Record<string, number[]> = {};
  for (let i = 0; i < pages.length; i++) {
    const pageText = extractPageText(pages[i]);
    if (!pageText) continue;

    for (const keyword of WATERMARK_KEYWORDS) {
      if (pageText.toLowerCase().includes(keyword.toLowerCase())) {
        if (!textMatches[keyword]) textMatches[keyword] = [];
        textMatches[keyword].push(i + 1);
      }
    }
  }

  for (const [keyword, pages] of Object.entries(textMatches)) {
    // 多页出现同一关键词，置信度高
    const confidence = pages.length >= 3 ? 0.95 : pages.length === 2 ? 0.8 : 0.6;
    watermarks.push({
      id: `text-${idCounter++}`,
      type: "text",
      content: keyword.toUpperCase(),
      pages,
      confidence,
    });
  }

  // 4. Image 水印检测（启发式：页面间重复出现的 XObject 图片）
  // 简化版：扫描页面资源中的 XObject，如果同一资源名出现在多个页面，标记为疑似水印
  const imageUsage: Record<string, number[]> = {};
  for (let i = 0; i < pages.length; i++) {
    const resources = pages[i].node.Resources();
    if (!resources) continue;
    const xObject = resources.lookup(PDFName.of("XObject"));
    if (!xObject) continue;
    // 简单遍历 XObject 名称
    try {
      const xobjDict = xObject.dict;
      if (xobjDict) {
        for (const key of xobjDict.keys()) {
          const name = key.value();
          if (!imageUsage[name]) imageUsage[name] = [];
          imageUsage[name].push(i + 1);
        }
      }
    } catch {}
  }

  for (const [name, pages] of Object.entries(imageUsage)) {
    if (pages.length >= 3) {
      watermarks.push({
        id: `image-${idCounter++}`,
        type: "image",
        content: `Image Object "${name}"`,
        pages,
        confidence: pages.length >= 5 ? 0.91 : 0.75,
      });
    }
  }

  return {
    isScanned: false,
    watermarks,
  };
}

/**
 * 一键移除所有水印
 */
export async function removeAllWatermarks(
  pdfBytes: ArrayBuffer | Uint8Array
): Promise<RemovalResult> {
  const originalBytes = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  const analysis = await analyzeWatermarks(pdfBytes);

  if (analysis.isScanned) {
    throw new Error(analysis.scannedReason || "Scanned PDF not supported");
  }

  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  const removed: DetectedWatermark[] = [];

  // 移除 Annotation 水印
  for (const wm of analysis.watermarks.filter((w) => w.type === "annotation")) {
    for (const pageNum of wm.pages) {
      const page = pages[pageNum - 1];
      if (!page) continue;
      try {
        const annots = page.node.Annots();
        if (!annots) continue;
        const annotArray = annots.asArray();
        const newAnnots = annotArray.filter((a) => {
          const s = a.toString();
          return !(s.includes("/Watermark") || s.includes("/Subtype/Watermark"));
        });
        if (newAnnots.length !== annotArray.length) {
          page.node.set(PDFName.of("Annots"), doc.context.obj(newAnnots));
        }
      } catch {}
    }
    removed.push(wm);
  }

  // Text / Image 水印：通过重写 content stream 移除关键词文本
  // 简化策略：删除包含关键词的 BT..ET 文本块
  for (const wm of analysis.watermarks.filter((w) => w.type === "text")) {
    for (const pageNum of wm.pages) {
      const page = pages[pageNum - 1];
      if (!page) continue;
      try {
        const contents = page.node.Contents();
        if (!contents) continue;
        const newStream = stripTextFromContentStream(doc, contents, wm.content);
        if (newStream) {
          // 流必须是间接对象（ISO 32000-1 §7.3.8）：PDFRawStream.of() 产出的是未注册流，
          // 直接写入 /Contents 会变成内联流 → 解析器判页面损坏 → 整页空白。
          page.node.set(PDFName.of("Contents"), doc.context.register(newStream));
        }
      } catch {}
    }
    removed.push(wm);
  }

  // Image 水印：从 XObject 资源中删除
  for (const wm of analysis.watermarks.filter((w) => w.type === "image")) {
    const match = wm.content.match(/"([^"]+)"/);
    if (!match) continue;
    const xobjName = match[1];
    for (const pageNum of wm.pages) {
      const page = pages[pageNum - 1];
      if (!page) continue;
      try {
        const resources = page.node.Resources();
        if (!resources) continue;
        const xObject = resources.lookup(PDFName.of("XObject"));
        if (!xObject) continue;
        // 删除引用
        const xobjDict = xObject.dict;
        if (xobjDict) {
          xobjDict.delete(PDFName.of(xobjName));
        }
      } catch {}
    }
    removed.push(wm);
  }

  const outputBytes = await doc.save({ useObjectStreams: false });
  return {
    removed,
    outputBytes,
    originalSize: originalBytes.length,
    newSize: outputBytes.length,
  };
}

// ── Helpers ──

function countTextOperators(page: any): number {
  try {
    const contents = page.node.Contents();
    if (!contents) return 0;
    const text = contents.toString();
    // 简单计算 BT..ET 块数量
    const matches = text.match(/BT\s/g);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

function countImageXObjects(page: any): number {
  try {
    const resources = page.node.Resources();
    if (!resources) return 0;
    const xObject = resources.lookup(PDFName.of("XObject"));
    if (!xObject) return 0;
    const xobjDict = xObject.dict;
    return xobjDict ? xobjDict.size() : 0;
  } catch {
    return 0;
  }
}

function extractPageText(page: any): string {
  try {
    const contents = page.node.Contents();
    if (!contents) return "";
    if (contents instanceof PDFRawStream) {
      const bytes = contents.getContents();
      // 简单提取 () 之间的文本
      const text = new TextDecoder("latin1").decode(bytes);
      const matches = text.match(/\(([^)]+)\)/g);
      return matches ? matches.map((m) => m.slice(1, -1)).join(" ") : "";
    } else if (contents instanceof PDFStream) {
      const bytes = contents.getContents();
      const text = new TextDecoder("latin1").decode(bytes);
      const matches = text.match(/\(([^)]+)\)/g);
      return matches ? matches.map((m) => m.slice(1, -1)).join(" ") : "";
    }
    return contents.toString() || "";
  } catch {
    return "";
  }
}

function extractTextFromAnnot(annotStr: string): string {
  const match = annotStr.match(/\(([^)]+)\)/);
  return match ? match[1] : "";
}

function stripTextFromContentStream(
  doc: PDFDocument,
  contents: any,
  keyword: string
): any | null {
  try {
    if (contents instanceof PDFRawStream || contents instanceof PDFStream) {
      const bytes = contents.getContents();
      let text = new TextDecoder("latin1").decode(bytes);

      // 删除包含关键词的 BT..ET 块
      const keywordLower = keyword.toLowerCase();
      const btEtPattern = /BT\s([\s\S]*?)ET/g;
      let modified = false;
      text = text.replace(btEtPattern, (match, inner) => {
        if (inner.toLowerCase().includes(keywordLower)) {
          modified = true;
          return "";
        }
        return match;
      });

      if (modified) {
        const encoder = new TextEncoder();
        const newBytes = encoder.encode(text);
        const newStream = PDFRawStream.of(
          contents.dict,
          newBytes
        );
        return newStream;
      }
    }
    return null;
  } catch {
    return null;
  }
}
