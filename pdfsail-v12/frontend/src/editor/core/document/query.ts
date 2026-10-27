/**
 * editor/core/document/query.ts — EDITOR-CORE-001
 *
 * EditorDocument 的最小纯查询集合。
 *
 * 设计约束：
 *   - 全部纯函数，无 React / DOM / PDF 依赖（规范 §13 / §37）
 *   - 只读，绝不修改文档（规范 §50：渲染与查询都不得 mutate document）
 *   - 文本聚合按 UTF-16 code unit 计数，与浏览器 input/IME 偏移语义一致（规范 §9）
 */

import type {
  EditorDocument,
  EditorObject,
  EditorPage,
  Paragraph,
  TextBoxObject,
  TextRun,
} from "./types";

/** 按 id 查找页 */
export function findPage(doc: EditorDocument, pageId: string): EditorPage | null {
  return doc.pages.find((p) => p.id === pageId) ?? null;
}

/** 按 1-based 页号查找页（PDF Binding / 导入常用） */
export function findPageByIndex(doc: EditorDocument, index: number): EditorPage | null {
  return doc.pages.find((p) => p.index === index) ?? null;
}

/**
 * F3B-6.24-B3：EditorObject 可能是 TextBox 或 Image，
 * 需要显式类型谓词才能在 find/filter 里收窄到 TextBoxObject。
 */
export function isTextBox(o: EditorObject): o is TextBoxObject {
  return o.type === "text";
}

/** 全文档查找 TextBox */
export function findTextBox(doc: EditorDocument, textBoxId: string): TextBoxObject | null {
  for (const page of doc.pages) {
    const hit = page.objects.find((o) => o.id === textBoxId);
    if (hit && isTextBox(hit)) return hit;
  }
  return null;
}

/** 查找 TextBox 所属页 */
export function findTextBoxPage(doc: EditorDocument, textBoxId: string): EditorPage | null {
  for (const page of doc.pages) {
    if (page.objects.some((o) => o.id === textBoxId)) return page;
  }
  return null;
}

/** 在 TextBox 内查找段落 */
export function findParagraph(
  textBox: TextBoxObject,
  paragraphId: string
): Paragraph | null {
  return textBox.paragraphs.find((p) => p.id === paragraphId) ?? null;
}

/** 在段落内查找 run */
export function findRun(paragraph: Paragraph, runId: string): TextRun | null {
  return paragraph.runs.find((r) => r.id === runId) ?? null;
}

/** 段落纯文本（所有 run 拼接） */
export function getParagraphText(paragraph: Paragraph): string {
  let out = "";
  for (const run of paragraph.runs) out += run.text;
  return out;
}

/** TextBox 纯文本：段落之间以 "\n" 分隔（规范 §54 Test F 的段落语义） */
export function getTextBoxText(textBox: TextBoxObject): string {
  return textBox.paragraphs.map(getParagraphText).join("\n");
}

/**
 * 段落内的 UTF-16 文本长度。
 *
 * 规范 §9：offset 必须按 UTF-16 code unit 计数，
 * 因此这里等价于 getParagraphText(p).length（emoji 等代理对计 2）。
 */
export function getParagraphLength(paragraph: Paragraph): number {
  let n = 0;
  for (const run of paragraph.runs) n += run.text.length;
  return n;
}

/** 文档中所有 TextBox（扁平化，供导出/命中测试遍历） */
export function allTextBoxes(doc: EditorDocument): TextBoxObject[] {
  const out: TextBoxObject[] = [];
  for (const page of doc.pages) {
    for (const obj of page.objects) {
      // F3B-6.24-B3：跳过图片等非文本对象
      if (isTextBox(obj)) out.push(obj);
    }
  }
  return out;
}

/** 统计 run 总数（结构诊断 / 测试用） */
export function countRuns(doc: EditorDocument): number {
  let n = 0;
  for (const box of allTextBoxes(doc)) {
    for (const para of box.paragraphs) n += para.runs.length;
  }
  return n;
}

/**
 * 判断点是否落在 TextBox 的布局约束矩形内（未考虑旋转）。
 *
 * 注意：这是**粗粒度**判定，仅供 hit testing 的第一阶段（page → TextBox）使用；
 * 精确的行/run/字符级命中由 EDITOR-CORE-007 基于 TextLayout 实现（规范 §20）。
 * 旋转对象在 EDITOR-CORE-006/007 中按逆旋转变换处理。
 */
export function pointInTextBox(
  textBox: TextBoxObject,
  point: { x: number; y: number }
): boolean {
  return (
    point.x >= textBox.x &&
    point.x <= textBox.x + textBox.width &&
    point.y >= textBox.y &&
    point.y <= textBox.y + textBox.height
  );
}
