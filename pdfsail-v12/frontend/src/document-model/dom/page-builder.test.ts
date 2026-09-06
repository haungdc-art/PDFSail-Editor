/**
 * page-builder.test.ts — DOM Page Builder Golden Test（Sprint-120 · Phase 2 · Task-1）
 *
 * 验证 Phase 2 核心架构转换：
 *   Builder 内部以 **Page 为唯一生产模型**，EditablePage 降级为兼容适配层。
 *
 *   Builder.createPage()
 *       ▼
 *   DomPage（唯一事实来源）
 *       ├────────► domPageToEditablePage() → EditablePage（兼容适配）
 *       └────────► Scene（未来 Phase 3，本阶段不接）
 *
 * 关键断言：
 *   1. createPage() 产出五层容器存在的 DomPage（符合 Phase 1 Schema Validator）
 *   2. BaseLayer 恒含结构化 PdfFallbackObject（无 bitmap，含 pageIndex/runtimeRef）
 *   3. ContentLayer 映射正确（footer→Glyph editable=true；stamp→BaseLayer Decoration）
 *   4. 不 fake Annotation/Form/Decoration（无数据 → 空容器，不建默认对象）
 *   5. 兼容适配 EditablePage 能按 sourceId 找回原始 glyph 数据
 *   6. 单向（Page → EditablePage），无反向
 *   7. DOM Validator 校验 Builder 产出的 Page PASS
 *   8. 生产编辑行为零变化（本测试只读 Builder 输出，不改生产代码）
 */
import type { EditableBlock, EditablePage } from "../types";
import { createPage, PageBuildInput } from "./page-builder";
import { domPageToEditablePage } from "./editable-page-compat";
import { validateDomPage } from "./dom-validator";
import { DomPage } from "./page";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

/** 构造带 glyph 数据的原始 EditableBlock（PDF Adapter 产物） */
function makeSourceBlocks(): EditableBlock[] {
  return [
    {
      id: "b-body",
      type: "text",
      regionType: "paragraph",
      bbox: { x: 40, y: 100, width: 500, height: 100 },
      source: "pdf_native",
      originalBounds: { x: 40, y: 100, width: 500, height: 100 },
      lines: [
        {
          id: "l-body",
          bbox: { x: 40, y: 100, width: 500, height: 20 },
          glyphs: [
            { char: "H", bbox: { x: 40, y: 100, width: 12, height: 12 }, styleRef: 0, modified: false },
            { char: "i", bbox: { x: 52, y: 100, width: 6, height: 12 }, styleRef: 0, modified: false },
          ],
          source: "vector",
          style: {},
        },
      ],
    },
    {
      id: "b-footer",
      type: "text",
      regionType: "footer",
      bbox: { x: 40, y: 810, width: 400, height: 20 },
      source: "pdf_native",
      originalBounds: { x: 40, y: 810, width: 400, height: 20 },
      lines: [
        {
          id: "l-footer",
          bbox: { x: 40, y: 810, width: 400, height: 20 },
          glyphs: [
            { char: "P", bbox: { x: 40, y: 810, width: 10, height: 12 }, styleRef: 0, modified: false },
            { char: "1", bbox: { x: 50, y: 810, width: 8, height: 12 }, styleRef: 0, modified: false },
          ],
          source: "vector",
          style: {},
        },
      ],
    },
    {
      id: "b-stamp",
      type: "text",
      regionType: "stamp",
      bbox: { x: 20, y: 300, width: 80, height: 80 },
      source: "pdf_native",
      originalBounds: { x: 20, y: 300, width: 80, height: 80 },
      lines: [
        {
          id: "l-stamp",
          bbox: { x: 20, y: 300, width: 80, height: 80 },
          glyphs: [{ char: "X", bbox: { x: 20, y: 300, width: 80, height: 80 }, styleRef: 0, modified: false }],
          source: "vector",
          style: {},
        },
      ],
    },
  ];
}

function buildInput(): PageBuildInput {
  return {
    metadata: { index: 1, width: 595, height: 842 },
    blocks: makeSourceBlocks(),
  };
}

function testFiveLayers(): void {
  console.group("① createPage() 产出五层容器（Schema）");
  const page = createPage(buildInput());
  assert(Array.isArray(page.layers.base), "BaseLayer 存在");
  assert(Array.isArray(page.layers.content), "ContentLayer 存在");
  assert(Array.isArray(page.layers.interaction), "InteractionLayer 存在");
  assert(Array.isArray(page.layers.overlay), "OverlayLayer 存在");
  assert(!!page.runtime, "Runtime 存在");
  assert(validateDomPage(page).length === 0, "DOM Validator PASS（Builder 产出 Page）");
  console.groupEnd();
}

function testPdfFallbackStructural(): void {
  console.group("② BaseLayer 结构化 PdfFallback（无 bitmap）");
  const page = createPage(buildInput());
  const fallback = page.layers.base.find((o) => o.type === "PdfFallback");
  assert(!!fallback, "BaseLayer 含 PdfFallback");
  assert(fallback?.editable === false, "PdfFallback editable=false");
  assert(fallback?.pageIndex === 1, `PdfFallback pageIndex=${fallback?.pageIndex}`);
  assert(typeof fallback?.runtimeRef === "string", "PdfFallback runtimeRef（仅标识）");
  const json = JSON.stringify(fallback);
  assert(!json.includes("bitmap") && !json.includes("canvas") && !json.includes("imageData"), "PdfFallback 不含 bitmap/canvas/imageData（Runtime 负责）");
  console.groupEnd();
}

function testContentMapping(): void {
  console.group("③ ContentLayer 映射（footer 可编辑 / stamp 归 BaseLayer）");
  const page = createPage(buildInput());
  const footer = page.layers.content.find((o) => o.sourceId === "b-footer");
  assert(!!footer && footer.editable === true, "footer → ContentLayer（editable=true）");
  assert(footer?.type === "Glyph", "footer → Glyph（可编辑）");
  assert(!page.layers.base.some((o) => o.sourceId === "b-footer"), "footer 不在 BaseLayer");
  const stamp = page.layers.base.find((o) => o.sourceId === "b-stamp");
  assert(!!stamp && stamp.editable === false, "stamp → BaseLayer（editable=false）");
  assert(!page.layers.content.some((o) => o.sourceId === "b-stamp"), "stamp 不在 ContentLayer");
  assert(page.layers.content.some((o) => o.sourceId === "b-body"), "正文 → ContentLayer");
  console.groupEnd();
}

function testNoFakeBusinessData(): void {
  console.group("④ 不 fake Annotation/Form/Decoration");
  const page = createPage(buildInput());
  const allContent = page.layers.content;
  const allBase = page.layers.base;
  // 没有 Annotation/Form 业务数据（源数据里没有，不建默认对象）
  assert(!allContent.some((o) => o.type === "Annotation" || o.type === "Form"), "无 Annotation/Form 默认对象（空容器合法）");
  // BaseLayer 只有 PdfFallback + stamp（Decoration），无伪背景/装饰
  assert(allBase.filter((o) => o.type !== "PdfFallback" && o.type !== "Decoration").length === 0, "BaseLayer 无伪默认装饰");
  console.groupEnd();
}

function testCompatRecoversGlyphData(): void {
  console.group("⑤ 兼容适配：Page → EditablePage 找回原始 glyph（等价性）");
  const page = createPage(buildInput());
  const sourceBlocks = makeSourceBlocks();
  const editablePage: EditablePage = domPageToEditablePage(page, sourceBlocks);
  assert(editablePage.index === 1, "EditablePage.index 保留");
  // 等价性：所有被 Page 承载的原始 block（含 BaseLayer 的 stamp）都找回，顺序与 sourceBlocks 一致
  assert(editablePage.blocks.length === 3, `找回全部 3 个原始 block（body+footer+stamp），实际 ${editablePage.blocks.length}`);
  assert(editablePage.blocks.map((b) => b.id).join(",") === "b-body,b-footer,b-stamp", "blocks 顺序与旧 Builder 一致");
  const body = editablePage.blocks.find((b) => b.id === "b-body");
  assert(!!body && body.lines[0]?.glyphs.length === 2, "body 找回原始 2 个 glyph（sourceId 匹配）");
  const footer = editablePage.blocks.find((b) => b.id === "b-footer");
  assert(!!footer, "footer 在 EditablePage（可编辑页脚保留）");
  const stamp = editablePage.blocks.find((b) => b.id === "b-stamp");
  assert(!!stamp, "stamp 也找回（不可编辑但仍是原始 block，等价性要求）");
  console.groupEnd();
}

function testSingleDirection(): void {
  console.group("⑥ 单向（无 EditablePage → Page 反向）");
  const page = createPage(buildInput());
  const sourceBlocks = makeSourceBlocks();
  const editablePage = domPageToEditablePage(page, sourceBlocks);
  assert(editablePage.index === page.metadata.index, "EditablePage 是 Page 的兼容产物");
  assert(
    !("toPage" in (domPageToEditablePage as unknown as object)),
    "兼容适配不暴露反向（Page 是唯一事实来源）",
  );
  console.groupEnd();
}

export function runAllTests(): { name: string; pass: boolean }[] {
  results = [];
  console.log("%c── DOM Page Builder Golden Test (Sprint-120 · Phase 2 · Task-1) ──", "font-weight:bold;color:#8b5cf6;");
  testFiveLayers();
  testPdfFallbackStructural();
  testContentMapping();
  testNoFakeBusinessData();
  testCompatRecoversGlyphData();
  testSingleDirection();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  return results;
}

if (typeof process !== "undefined" && process.argv.length > 1) {
  const main = process.argv[1].replace(/\\/g, "/").replace(/^\.?\//, "");
  const self = import.meta.url.replace("file://", "").replace(/\\/g, "/");
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("page-builder.test.ts")) {
    const rs = runAllTests();
    if (rs.some((r) => !r.pass)) process.exit(1);
  }
}
