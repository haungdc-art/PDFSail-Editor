/**
 * block-rewrite.ts — Block Rewrite（Sprint44-Order-020，ADR-007 Option B）
 *
 * 对 modified block，从其页面 content stream 中移除原始 target 文本操作符，
 * 使导出 PDF 文本层正确反映 EditableDocument（不再叠加原文）。
 *
 * 复用 watermark-remover.ts 的 content stream 重写模式（stripTextFromContentStream）。
 *
 * 说明：
 *  - Block Rewrite 仅移除 modified block 的原始文本操作符。
 *  - 未修改 block 保留原始 PDF 表示。
 *  - Rewrite Unit = EditableBlock（ADR-007 定义）。
 *
 * 状态：Sprint44-Order-020 实现（待实际运行验证）
 */
import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFStream,
  PDFArray,
  PDFRef,
} from "pdf-lib";
import { inflateSync, deflateSync } from "node:zlib";
import type { EditableDocument } from "./types";

/** 解压 FlateDecode content stream（Node 环境用 zlib） */
async function inflateContent(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    return inflateSync(Buffer.from(bytes)) as Uint8Array;
  } catch {
    return null;
  }
}

/** 压缩 content stream（FlateDecode） */
async function deflateContent(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    return deflateSync(Buffer.from(bytes)) as Uint8Array;
  } catch {
    return null;
  }
}

/** 收集所有 modified block（含 glyph.modified=true 的 text block） */
export function collectModifiedBlocks(
  doc: EditableDocument,
): Array<{ blockId: string; pageIndex: number; originalText: string }> {
  const modified: Array<{ blockId: string; pageIndex: number; originalText: string }> = [];

  for (let pi = 0; pi < doc.pages.length; pi++) {
    const page = doc.pages[pi];
    for (const block of page.blocks) {
      if (block.type !== "text") continue;
      const hasModified = block.lines.some((l) =>
        l.glyphs.some((g) => g.modified),
      );
      if (!hasModified) continue;

      // 原始文本：优先用 glyph.originalChar（替换前），否则回退 block 的 bbox 内文本
      const originalText = block.lines
        .flatMap((l) => l.glyphs)
        .map((g) => g.originalChar ?? g.char)
        .join("")
        .trim();

      if (originalText.length > 0) {
        modified.push({ blockId: block.id, pageIndex: pi, originalText });
      }
    }
  }

  return modified;
}

/**
 * 从页面 content stream 中移除包含指定文本的 BT..ET 文本块。
 * 复用 watermark-remover 模式，增强对 TJ/Tj/hex 字符串的匹配。
 */
export async function stripTextBlockFromContentStream(
  doc: PDFDocument,
  contents: any,
  targetText: string,
): Promise<any | null> {
  try {
    if (!(contents instanceof PDFRawStream) && !(contents instanceof PDFStream)) {
      return null;
    }
    // content stream 通常是 FlateDecode 压缩。获取可读文本（解压）。
    const rawBytes = contents.getContents();
    const inflated = await inflateContent(new Uint8Array(rawBytes));
    // 若解压失败，尝试直接用原始字节（未压缩流）
    let text = inflated
      ? new TextDecoder("latin1").decode(inflated)
      : new TextDecoder("latin1").decode(rawBytes);

    const target = targetText.toLowerCase();
    const btEtPattern = /BT\s([\s\S]*?)ET/g;
    let modified = false;

    text = text.replace(btEtPattern, (match, inner) => {
      // 从 BT..ET 块内提取可见文本（() 括号字符串 或 <hex> 十六进制串）
      const blockText = extractTextFromBlock(inner).toLowerCase();
      if (blockText.includes(target)) {
        modified = true;
        return "";
      }
      return match;
    });

    if (modified) {
      // 重新压缩并创建 PDFRawStream。
      // 关键：若原 stream 是 FlateDecode，新内容需保持 FlateDecode（Filter 标记保留，字节重新 deflate）。
      // 若 deflate 失败，使用未压缩字节，此时必须移除 /Filter 标记，避免 pdf.js 误以为要解压。
      const encoder = new TextEncoder();
      const newBytes = encoder.encode(text);
      const compressed = await deflateContent(new Uint8Array(newBytes));

      // 复制 dict 并正确设置 /Filter
      const newDict = contents.dict.clone();
      if (compressed) {
        // FlateDecode 压缩内容 → 设置 /Filter /FlateDecode
        newDict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
        newDict.set(PDFName.of("Length"), doc.context.obj(compressed.length));
        return PDFRawStream.of(newDict, compressed);
      } else {
        // 未压缩 → 移除 /Filter
        newDict.delete(PDFName.of("Filter"));
        newDict.set(PDFName.of("Length"), doc.context.obj(newBytes.length));
        return PDFRawStream.of(newDict, newBytes);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 从 BT..ET 块内提取文本（支持 () 字面字符串 与 <hex> 十六进制） */
function extractTextFromBlock(inner: string): string {
  // 提取 () 内字面字符串
  const literalMatches = inner.match(/\(((?:\\.|[^()\\])*)\)/g) || [];
  let text = literalMatches
    .map((m) => m.slice(1, -1))
    .map(unescapePdfString)
    .join("");

  // 提取 <hex> 十六进制字符串（UTF-16BE 常见）
  const hexMatches = inner.match(/<([0-9A-Fa-f\s]+)>/g) || [];
  for (const h of hexMatches) {
    const hex = h.slice(1, -1).replace(/\s+/g, "");
    const decoded = decodeHexString(hex);
    if (decoded) text += decoded;
  }

  return text;
}

/** 解码 PDF 十六进制字符串（UTF-16BE 或 latin1） */
function decodeHexString(hex: string): string {
  if (hex.length % 2 !== 0) return "";
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  try {
    // 尝试 UTF-16BE
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    }
  } catch {}
  return new TextDecoder("latin1").decode(bytes);
}

/** 反转义 PDF 字符串 */
function unescapePdfString(s: string): string {
  return s.replace(/\\([nrtbf()\\])/g, (m, c) => {
    const map: Record<string, string> = {
      n: "\n", r: "\r", t: "\t", b: "\b", f: "\f",
      "(": "(", ")": ")", "\\": "\\",
    };
    return map[c] ?? c;
  });
}

/**
 * Block Rewrite 主流程：移除所有 modified block 的原始文本操作符。
 * 处理 Contents 可能是数组（多个 content stream）的情况。
 * 返回是否发生了任何移除。
 */
export async function blockRewrite(
  pdf: PDFDocument,
  modifiedBlocks: Array<{ blockId: string; pageIndex: number; originalText: string }>,
): Promise<{ removedCount: number }> {
  let removedCount = 0;
  const pages = pdf.getPages();

  for (const mb of modifiedBlocks) {
    if (mb.pageIndex >= pages.length) continue;
    const page = pages[mb.pageIndex] as any;
    try {
      const contents = page.node.Contents();
      if (!contents) continue;

      // Contents 可能是数组（[stream1, stream2, ...]）或单个 stream
      if (contents instanceof PDFArray) {
        const arr = contents.asArray();
        let arrayModified = false;
        for (let i = 0; i < arr.length; i++) {
          const ref = arr[i];
          const stream = ref instanceof PDFRef ? pdf.context.lookup(ref) : ref;
          const newStream = await stripTextBlockFromContentStream(pdf, stream, mb.originalText);
          if (newStream) {
            arr[i] = pdf.context.register(newStream);
            arrayModified = true;
            removedCount++;
          }
        }
        if (arrayModified) {
          page.node.set(PDFName.of("Contents"), contents);
        }
      } else {
        // 单个 stream
        const newStream = await stripTextBlockFromContentStream(pdf, contents, mb.originalText);
        if (newStream) {
          // 流必须是间接对象（ISO 32000-1 §7.3.8）：未注册流直接写入 /Contents 会变成
          // 内联流 → 解析器判页面损坏 → 整页空白。
          page.node.set(PDFName.of("Contents"), pdf.context.register(newStream));
          removedCount++;
        }
      }
    } catch (e) {}
  }

  return { removedCount };
}
