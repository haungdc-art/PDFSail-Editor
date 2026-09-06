/**
 * Debug 工具 — EditableDocument JSON 序列化与摘要
 *
 * Sprint 1 Task 5 要求：
 *   上传 PDF/OCR 后，可以查看 page / blocks / lines / glyphs / style / source，
 *   方便后续调试。
 *
 * 提供：
 *   1. serializeEditableDocument(doc) → 可序列化的 JSON 对象（可 JSON.stringify）
 *   2. createDebugDocument(doc) → 生成可下载的 JSON 字符串
 *   3. summarizeEditableDocument(doc) → 文本摘要（控制台打印用）
 *
 * 使用方式（在 PDFEditor 中）：
 *   const doc = buildEditableDocument(...);
 *   console.log(summarizeEditableDocument(doc));
 *   const json = createDebugDocument(doc);
 *   // 或写入文件供检查：
 *   // localStorage.setItem("editable-document.json", json);
 */

import type {
  EditableDocument,
  EditablePage,
  EditableBlock,
  EditableLine,
} from "./types";

/** 可 JSON 序列化的 Page 视图 */
interface SerializablePage {
  index: number;
  width: number;
  height: number;
  blockCount: number;
  blocks: SerializableBlock[];
}

/** 可 JSON 序列化的 Block 视图 */
interface SerializableBlock {
  id: string;
  type: string;
  source: string;
  bbox: { x: number; y: number; width: number; height: number };
  originalBounds?: { x: number; y: number; width: number; height: number };
  lineCount: number;
  text: string;
  lines: SerializableLine[];
}

/** 可 JSON 序列化的 Line 视图 */
interface SerializableLine {
  id: string;
  /** M7.7-009A: 渲染源类型 "vector" | "image" */
  source: string;
  bbox: { x: number; y: number; width: number; height: number };
  glyphCount: number;
  text: string;
  style: Record<string, unknown>;
  glyphs: Array<{
    char: string;
    originalChar?: string;
    modified: boolean;
    bbox: { x: number; y: number; width: number; height: number };
    styleRef: number;
  }>;
}

/**
 * 把 EditableDocument 转换为可 JSON 序列化的对象。
 *
 * 剥离了函数引用等不可序列化字段，保留所有数据。
 */
export function serializeEditableDocument(doc: EditableDocument): {
  metadata: EditableDocument["metadata"];
  pages: SerializablePage[];
} {
  return {
    metadata: doc.metadata,
    pages: doc.pages.map(serializePage),
  };
}

function serializePage(page: EditablePage): SerializablePage {
  return {
    index: page.index,
    width: page.width,
    height: page.height,
    blockCount: page.blocks.length,
    blocks: page.blocks.map(serializeBlock),
  };
}

function serializeBlock(block: EditableBlock): SerializableBlock {
  return {
    id: block.id,
    type: block.type,
    source: block.source,
    bbox: block.bbox,
    originalBounds: block.originalBounds,
    lineCount: block.lines.length,
    text: block.lines
      .map((l) => l.glyphs.map((g) => g.char).join(""))
      .join("\n"),
    lines: block.lines.map(serializeLine),
  };
}

function serializeLine(line: EditableLine): SerializableLine {
  return {
    id: line.id,
    source: line.source,
    bbox: line.bbox,
    glyphCount: line.glyphs.length,
    text: line.glyphs.map((g) => g.char).join(""),
    style: line.style as Record<string, unknown>,
    glyphs: line.glyphs.map((g) => ({
      char: g.char,
      originalChar: g.originalChar,
      modified: g.modified,
      bbox: g.bbox,
      styleRef: g.styleRef,
    })),
  };
}

/**
 * 生成可下载 / 存储的 JSON 字符串。
 *
 * 文件名建议：editable-document.json
 */
export function createDebugDocument(doc: EditableDocument): string {
  return JSON.stringify(serializeEditableDocument(doc), null, 2);
}

/**
 * 生成文本摘要（控制台打印用）。
 *
 * 输出示例：
 *   === EditableDocument ===
 *   Pages: 1 | File: test.pdf | Created: 2026-08-07T...
 *   --- Page 1 (612 × 792) ---
 *   Block 0 [ocr] bbox=(72, 100, 468, 30) lines=1 glyphs=87
 *     Line 0: "Atesto que JENNIFER MARTINS DE OLIVEIRA..."
 *   Block 1 [ocr] bbox=(72, 140, 468, 60) lines=2 glyphs=150
 *     Line 0: "necessita de 02 dia(s) de afastamento..."
 *     Line 1: "para tratamento de saúde."
 */
export function summarizeEditableDocument(doc: EditableDocument): string {
  const lines: string[] = [];
  lines.push("=== EditableDocument ===");
  lines.push(
    `Pages: ${doc.pages.length} | Styles: ${doc.styles.length} | File: ${doc.metadata.fileName || "(unknown)"} | Created: ${new Date(doc.metadata.createdAt).toISOString()}`
  );

  for (const page of doc.pages) {
    lines.push(`--- Page ${page.index} (${page.width} × ${page.height}) ---`);
    page.blocks.forEach((block, bi) => {
      const glyphCount = block.lines.reduce(
        (sum, l) => sum + l.glyphs.length,
        0
      );
      lines.push(
        `  Block ${bi} [${block.source}] bbox=(${block.bbox.x.toFixed(0)}, ${block.bbox.y.toFixed(0)}, ${block.bbox.width.toFixed(0)}, ${block.bbox.height.toFixed(0)}) lines=${block.lines.length} glyphs=${glyphCount}`
      );
      block.lines.forEach((line, li) => {
        const text = line.glyphs.map((g) => g.char).join("");
        const preview = text.length > 60 ? text.slice(0, 57) + "..." : text;
        lines.push(`    Line ${li} [${line.source}]: "${preview}"`);
      });
    });
  }

  return lines.join("\n");
}

/**
 * 生成每个 Block 的样式摘要（Sprint 2 Debug 要求）。
 *
 * 显示每个 Block 的：
 *   - text（截断预览）
 *   - style（fontFamily / fontSize / fontWeight / fontStyle / color / lineHeight / letterSpacing）
 *   - styleRef（指向 doc.styles 数组的索引）
 *
 * 输出示例：
 *   === Block Styles ===
 *   Block 0 [ocr] ref=0
 *     text: "Atesto que JENNIFER MARTINS DE OLIVEIRA..."
 *     fontFamily: "Helvetica, Arial, sans-serif"
 *     fontSize: 14.0
 *     fontWeight: 700
 *     fontStyle: normal
 *     color: #000000
 *     lineHeight: 18.2
 *     letterSpacing: 0
 *   Block 1 [ocr] ref=1
 *     text: "necessita de 02 dia(s)..."
 *     ...
 *
 *   --- Document Styles Table (2 unique) ---
 *   [0] fontFamily="Helvetica..." fontSize=14 weight=700 color=#000000
 *   [1] fontFamily="SimSun..." fontSize=12 weight=400 color=#000000
 */
export function summarizeBlockStyles(doc: EditableDocument): string {
  const lines: string[] = [];
  lines.push("=== Block Styles ===");

  for (const page of doc.pages) {
    lines.push(`--- Page ${page.index} ---`);
    page.blocks.forEach((block, bi) => {
      const firstLine = block.lines[0];
      const style = firstLine?.style || {};
      const firstGlyphRef = firstLine?.glyphs[0]?.styleRef ?? -1;

      const text = block.lines
        .map((l) => l.glyphs.map((g) => g.char).join(""))
        .join("\n");
      const preview = text.length > 50 ? text.slice(0, 47) + "..." : text;

      lines.push(`  Block ${bi} [${block.source}] styleRef=${firstGlyphRef}`);
      lines.push(`    text: "${preview}"`);
      lines.push(`    fontFamily: ${style.fontFamily || "(none)"}`);
      lines.push(`    fontSize: ${style.fontSize?.toFixed(1) ?? "(none)"}`);
      lines.push(`    fontWeight: ${style.fontWeight ?? "(none)"}`);
      lines.push(`    fontStyle: ${style.fontStyle ?? "(none)"}`);
      lines.push(`    color: ${style.color ?? "(none)"}`);
      lines.push(`    lineHeight: ${style.lineHeight?.toFixed(1) ?? "(none)"}`);
      lines.push(`    letterSpacing: ${style.letterSpacing ?? "(none)"}`);
      if (style.transform) {
        lines.push(`    transform: [${style.transform.join(", ")}]`);
      }
    });
  }

  // 文档级样式表
  lines.push("");
  lines.push(`--- Document Styles Table (${doc.styles.length} unique) ---`);
  doc.styles.forEach((s, i) => {
    lines.push(
      `  [${i}] fontFamily="${s.fontFamily || "?"}" fontSize=${s.fontSize?.toFixed(1) ?? "?"} weight=${s.fontWeight ?? "?"} color=${s.color ?? "?"} fontStyle=${s.fontStyle ?? "?"}`
    );
  });

  return lines.join("\n");
}

/**
 * Layout Debug Viewer — Task 5
 *
 * 显示每个 Block 的：
 *   - original bbox（原文区域，用于对比原 PDF）
 *   - reconstructed lines（重建后的行布局）
 *   - glyph positions（每个字符的精确位置）
 *
 * 用于对比：原 PDF vs 重建结果
 *
 * 输出示例：
 *   === Layout Comparison ===
 *   --- Page 1 ---
 *   Block 0 [ocr]
 *     Original bbox: (72, 100, 468, 90)  ← 原文区域
 *     Reconstructed bbox: (72, 100, 468, 90)
 *     Lines: 3
 *     Line 0: y=100 h=18 text="Atesto que JENNIFER MARTINS DE OLIVEIRA..."
 *       glyph[0] "A" x=72 w=8.5
 *       glyph[1] "t" x=80.5 w=4.2
 *       ...
 *     Line 1: y=118 h=18 text="dia(s) de afastamento..."
 *     Line 2: y=136 h=18 text="para tratamento de saúde."
 */
export function summarizeLayoutComparison(doc: EditableDocument): string {
  const lines: string[] = [];
  lines.push("=== Layout Comparison ===");

  for (const page of doc.pages) {
    lines.push(`--- Page ${page.index} ---`);
    page.blocks.forEach((block, bi) => {
      const original = block.originalBounds || block.bbox;
      lines.push(`  Block ${bi} [${block.source}]`);
      lines.push(
        `    Original bbox: (${original.x.toFixed(1)}, ${original.y.toFixed(1)}, ${original.width.toFixed(1)}, ${original.height.toFixed(1)})`
      );
      lines.push(
        `    Reconstructed bbox: (${block.bbox.x.toFixed(1)}, ${block.bbox.y.toFixed(1)}, ${block.bbox.width.toFixed(1)}, ${block.bbox.height.toFixed(1)})`
      );
      lines.push(`    Lines: ${block.lines.length}`);

      block.lines.forEach((line, li) => {
        const text = line.glyphs.map((g) => g.char).join("");
        const preview = text.length > 55 ? text.slice(0, 52) + "..." : text;
        lines.push(
          `    Line ${li}: y=${line.bbox.y.toFixed(1)} h=${line.bbox.height.toFixed(1)} w=${line.bbox.width.toFixed(1)} text="${preview}"`
        );

        // 显示前 5 个 glyph 的位置（避免输出过长）
        const glyphPreview = line.glyphs.slice(0, 5);
        glyphPreview.forEach((g, gi) => {
          lines.push(
            `      glyph[${gi}] "${g.char}" x=${g.bbox.x.toFixed(1)} w=${g.bbox.width.toFixed(1)}`
          );
        });
        if (line.glyphs.length > 5) {
          lines.push(`      ... (${line.glyphs.length - 5} more glyphs)`);
        }
      });

      // 行高一致性检查
      if (block.lines.length > 1) {
        const heights = block.lines.map((l) => l.bbox.height);
        const allSame = heights.every((h) => Math.abs(h - heights[0]) < 0.1);
        lines.push(
          `    LineHeight consistent: ${allSame ? "YES" : "NO"} (${heights[0].toFixed(1)}px)`
        );
      }
    });
  }

  return lines.join("\n");
}

/**
 * Layout Diff Viewer — Sprint 3.5 Task 4
 *
 * 显示 Original glyph positions vs New glyph positions + position difference。
 *
 * 用于验证编辑后（如 JENNIFER → MARIA）：
 *   - 文字位置是否保持
 *   - 字体是否不变
 *   - 行距是否不变
 *   - 是否影响下一行
 *
 * 输出示例：
 *   === Layout Diff ===
 *   --- Page 1 Block 0 Line 0 ---
 *   Original: "Atesto que JENNIFER MARTINS..."
 *   New:      "Atesto que MARIA MARTINS..."
 *
 *   Glyph Diff (modified: 3):
 *     [7] "J"→"M" origX=152.3 newX=152.3 dx=0.0 ✓ position preserved
 *     [8] "E"→"A" origX=160.1 newX=160.1 dx=0.0 ✓ position preserved
 *     [9] "N"→"R" origX=167.0 newX=167.0 dx=0.0 ✓ position preserved
 *
 *   Line Y check: origY=100.0 newY=100.0 dy=0.0 ✓ baseline preserved
 *   Next line Y: 118.0 (unchanged) ✓ no impact on next line
 *   FontSize check: 14.0 (unchanged) ✓ font preserved
 */
export function summarizeLayoutDiff(
  doc: EditableDocument,
  beforeDoc?: EditableDocument
): string {
  const lines: string[] = [];
  lines.push("=== Layout Diff ===");

  for (const page of doc.pages) {
    const beforePage = beforeDoc?.pages.find((p) => p.index === page.index);
    page.blocks.forEach((block, bi) => {
      const beforeBlock = beforePage?.blocks[bi];
      lines.push(`--- Page ${page.index} Block ${bi} [${block.source}] [${block.layoutMode || "default"}] [${block.regionType || "unknown"}] ---`);

      block.lines.forEach((line, li) => {
        const beforeLine = beforeBlock?.lines[li];
        const text = line.glyphs.map((g) => g.char).join("");
        const beforeText = beforeLine?.glyphs.map((g) => g.char).join("") || "(none)";

        // 只显示有修改的行
        const hasModification = line.glyphs.some((g) => g.modified) || text !== beforeText;
        if (!hasModification && li > 0) return; // 跳过未修改的非首行（减少输出）

        lines.push(`  Line ${li}:`);
        lines.push(`    Before: "${beforeText.length > 50 ? beforeText.slice(0, 47) + "..." : beforeText}"`);
        lines.push(`    After:  "${text.length > 50 ? text.slice(0, 47) + "..." : text}"`);

        // Glyph 级 Diff
        const modifiedGlyphs = line.glyphs
          .map((g, i) => ({ g, i }))
          .filter(({ g }) => g.modified || g.originalBBox);

        if (modifiedGlyphs.length > 0) {
          lines.push(`    Glyph Diff (showing modified):`);
          modifiedGlyphs.slice(0, 10).forEach(({ g, i }) => {
            const origChar = g.originalChar || g.char;
            const origBBox = g.originalBBox || g.bbox;
            const dx = g.bbox.x - origBBox.x;
            const dy = g.bbox.y - origBBox.y;
            const dw = g.bbox.width - origBBox.width;
            const posOk = Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5;
            const charChanged = g.char !== origChar;

            lines.push(
              `      [${i}] "${origChar}"${charChanged ? `→"${g.char}"` : ""} ` +
              `origX=${origBBox.x.toFixed(1)} newX=${g.bbox.x.toFixed(1)} ` +
              `dx=${dx.toFixed(1)} dy=${dy.toFixed(1)} dw=${dw.toFixed(1)} ` +
              `${posOk ? "✓ position preserved" : "✗ position changed"}`
            );
          });
        }

        // 行 Y 检查（baseline 保持）
        const beforeY = beforeLine?.bbox.y ?? line.bbox.y;
        const dy = line.bbox.y - beforeY;
        lines.push(
          `    Line Y: before=${beforeY.toFixed(1)} after=${line.bbox.y.toFixed(1)} dy=${dy.toFixed(1)} ` +
          `${Math.abs(dy) < 0.5 ? "✓ baseline preserved" : "✗ baseline changed"}`
        );

        // 下一行影响检查
        const nextLine = block.lines[li + 1];
        const beforeNextLine = beforeBlock?.lines[li + 1];
        if (nextLine && beforeNextLine) {
          const nextDy = nextLine.bbox.y - beforeNextLine.bbox.y;
          lines.push(
            `    Next line Y: before=${beforeNextLine.bbox.y.toFixed(1)} after=${nextLine.bbox.y.toFixed(1)} dy=${nextDy.toFixed(1)} ` +
            `${Math.abs(nextDy) < 0.5 ? "✓ no impact" : "✗ next line moved"}`
          );
        }

        // FontSize 检查
        const fontSize = line.style.fontSize;
        const beforeFontSize = beforeLine?.style.fontSize ?? fontSize;
        const fontOk = fontSize === beforeFontSize;
        lines.push(
          `    FontSize: before=${beforeFontSize?.toFixed(1) ?? "?"} after=${fontSize?.toFixed(1) ?? "?"} ` +
          `${fontOk ? "✓ font preserved" : "✗ font changed"}`
        );
      });
    });
  }

  return lines.join("\n");
}
