/**
 * dom-golden.test.ts — DOM Golden Test（Sprint-120 · Phase 1 · Task-4）
 *
 * 验证 ADR-045 的 Phase 1 完成标准：
 *   EditableDocument → Mapper → DOM → Validator PASS
 *
 * 目标（PM 定义）：
 *   证明新的 Document Object Model **可以与现有 EditableDocument 共存**，
 *   而不是证明它可以替代 EditableDocument。
 *
 * 关键断言：
 *   1. DOM Types 独立（不 import EditableDocument）—— 由 import 结构保证，本测试验证 Mapper 输出
 *   2. Mapper 是单向的（EditableDocument → Page），无反向转换
 *   3. 每个 Page 满足 >=1 BaseLayer 且 >=1 ContentLayer
 *   4. editable=false 对象不进入 ContentLayer
 *   5. footer 可编辑文本保留在 ContentLayer（PM 修正：不迁 Decoration）
 *   6. stamp/装饰归 BaseLayer（editable=false）
 *   7. DOM Validator PASS
 *   8. 生产编辑行为零变化（本测试只读 Mapper 输出，不改任何生产代码）
 */
import type { EditableDocument } from "../types";
import { mapEditableDocumentToDom } from "./editable-document-mapper";
import { validateDom, validateDomPage, validateDomSchema, validateDomContent, DomValidationResult, pdfBaseLayerRule } from "./dom-validator";
import { DomPage } from "./page";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

/** 构造最小但真实的 EditableDocument（含 text/footer/signature/image/table block） */
function makeEditableDocument(): EditableDocument {
  return {
    pages: [
      {
        index: 1,
        width: 595,
        height: 842,
        blocks: [
          // 页脚可编辑文本（regionType=footer）→ ContentLayer Glyph
          {
            id: "b-footer",
            type: "text",
            regionType: "footer",
            bbox: { x: 40, y: 810, width: 400, height: 20 },
            source: "pdf_native",
            lines: [
              { id: "l-footer", bbox: { x: 40, y: 810, width: 400, height: 20 }, glyphs: [], source: "vector", style: {} },
            ],
          },
          // 正文段落 → ContentLayer Glyph
          {
            id: "b-body",
            type: "text",
            regionType: "paragraph",
            bbox: { x: 40, y: 100, width: 500, height: 100 },
            source: "pdf_native",
            lines: [
              { id: "l-body", bbox: { x: 40, y: 100, width: 500, height: 100 }, glyphs: [], source: "vector", style: {} },
            ],
          },
          // 签名 → ContentLayer Signature
          {
            id: "b-sig",
            type: "text",
            regionType: "signature",
            bbox: { x: 400, y: 600, width: 150, height: 80 },
            source: "pdf_native",
            lines: [
              { id: "l-sig", bbox: { x: 400, y: 600, width: 150, height: 80 }, glyphs: [], source: "vector", style: {} },
            ],
            transform: { rotation: 45, scaleX: 1, scaleY: 1 },
            children: [
              { id: "b-sig-child", type: "text", regionType: "signature", bbox: { x: 0, y: 0, width: 150, height: 80 }, source: "pdf_native", lines: [] },
            ],
          },
          // 印章（stamp）→ BaseLayer Decoration（editable=false）
          {
            id: "b-stamp",
            type: "text",
            regionType: "stamp",
            bbox: { x: 20, y: 300, width: 80, height: 80 },
            source: "pdf_native",
            lines: [
              { id: "l-stamp", bbox: { x: 20, y: 300, width: 80, height: 80 }, glyphs: [], source: "vector", style: {} },
            ],
          },
          // 图片 → ContentLayer Image
          {
            id: "b-img",
            type: "image",
            bbox: { x: 40, y: 400, width: 200, height: 120 },
            source: "pdf_native",
            lines: [],
            src: "data:image/png;base64,xx",
          },
          // 表格 → ContentLayer Table
          {
            id: "b-table",
            type: "table",
            regionType: "table",
            bbox: { x: 40, y: 500, width: 300, height: 80 },
            source: "pdf_native",
            lines: [],
          },
        ],
      },
      // 第二页：只有空 blocks（验证 Mapper 仍产出 >=1 BaseLayer PdfFallback）
      { index: 2, width: 595, height: 842, blocks: [] },
    ],
    styles: [],
    metadata: { fileName: "golden-test.pdf", pageCount: 2, createdAt: 0 },
    runtime: { renderScale: 1.5, cssScale: 1, pageMetrics: [{ width: 595, height: 842 }, { width: 595, height: 842 }] },
  };
}

function testPageCount(): void {
  console.group("① 页数映射：EditableDocument.pages → DomPage[]");
  const doc = makeEditableDocument();
  const dom = mapEditableDocumentToDom(doc);
  assert(dom.length === doc.pages.length, `DOM 页数 = EditableDocument 页数（${dom.length}）`);
  assert(dom.every((p) => p.metadata.index === 1 || p.metadata.index === 2), "每页 index 保留");
  console.groupEnd();
}

function testContentLayer(): void {
  console.group("② ContentLayer：可编辑对象归属");
  const doc = makeEditableDocument();
  const dom = mapEditableDocumentToDom(doc);
  const page = dom[0];
  const content = page.layers.content;

  const footer = content.find((o) => o.id.includes("b-footer"));
  assert(!!footer && footer.editable === true, "footer 可编辑文本 → ContentLayer（editable=true）");
  assert(!!footer && footer.anchor === "BOTTOM", `footer anchor=BOTTOM（位置，${footer?.anchor}）`);

  assert(content.some((o) => o.id.includes("b-body")), "正文段落 → ContentLayer");
  assert(content.some((o) => o.type === "Signature"), "签名 → ContentLayer Signature");
  assert(content.some((o) => o.type === "Image"), "图片 → ContentLayer Image");
  assert(content.some((o) => o.type === "Table"), "表格 → ContentLayer Table");
  console.groupEnd();
}

function testBaseLayer(): void {
  console.group("③ BaseLayer：不可编辑对象归属");
  const doc = makeEditableDocument();
  const dom = mapEditableDocumentToDom(doc);
  const page = dom[0];
  const base = page.layers.base;

  assert(base.some((o) => o.type === "PdfFallback"), "每页至少一个 PdfFallback（BaseLayer）");
  assert(base.some((o) => o.id.includes("b-stamp") && o.editable === false), "stamp → BaseLayer Decoration（editable=false）");
  assert(!page.layers.content.some((o) => o.id.includes("b-stamp")), "stamp 不进入 ContentLayer");
  console.groupEnd();
}

function testStructureConstraints(): void {
  console.group("④ Schema 约束：五层容器存在（Structural Invariant），Data 可为空");
  const doc = makeEditableDocument();
  const dom = mapEditableDocumentToDom(doc);
  assert(dom.every((p) => p.layers.base.length >= 1), "每页 >=1 BaseLayer（PdfFallback）");
  assert(dom[0].layers.content.length >= 1, "page1 ContentLayer 有内容");
  assert(dom[1].layers.content.length === 0, "page2（空页）ContentLayer 内容为空（合法 Data）");
  // Schema 校验不因空 ContentLayer 而 fail（空白页/封底合法）
  assert(validateDomPage(dom[1]).length === 0, "空 ContentLayer 通过 Schema+Content 校验（不误判）");
  console.groupEnd();
}

function testThreeTierValidation(): void {
  console.group("⑤ 三层校验分离：Schema / Content / Business");
  const doc = makeEditableDocument();
  const dom = mapEditableDocumentToDom(doc);

  // 层 1：Schema —— 空页也满足（容器存在）
  const schemaIssues = validateDomSchema(dom[1]);
  assert(schemaIssues.length === 0, "空页 Schema 校验通过（容器恒存在）");

  // 层 2：Content —— 对象归属
  const contentIssues = validateDomContent(dom[0]);
  assert(contentIssues.length === 0, "page1 Content 校验通过（归属正确）");

  // 层 3：Business —— 需要显式注入
  const noPdfFallbackPage: DomPage = {
    metadata: { index: 1, width: 100, height: 100 },
    layers: {
      base: [{ id: "o-bg", type: "Decoration", editable: false, anchor: "TOP", bbox: { x: 0, y: 0, width: 10, height: 10 } }],
      content: [{ id: "o-g", type: "Glyph", editable: true, anchor: "TOP", bbox: { x: 0, y: 0, width: 10, height: 10 } }],
      interaction: [],
      overlay: [],
    },
    runtime: { dirty: false, visible: true },
  };
  // 默认（无 business rule）→ PASS（Word/CAD/PPT 场景合法，无 PdfFallback）
  assert(validateDomPage(noPdfFallbackPage).length === 0, "无 PdfFallback 的页面默认通过（非 PDF 格式合法）");
  // 注入 PDF rule → FAIL（PDF Builder Contract 要求 PdfFallback）
  const pdfIssues = validateDomPage(noPdfFallbackPage, { businessRules: [pdfBaseLayerRule] });
  assert(pdfIssues.some((i) => i.code === "PDF_NO_FALLBACK"), "注入 pdfBaseLayerRule 后捕获缺 PdfFallback");
  console.groupEnd();
}

function testFooterStaysEditable(): void {
  console.group("⑥ PM 修正：footer 不迁 Decoration，保留可编辑");
  const doc = makeEditableDocument();
  const dom = mapEditableDocumentToDom(doc);
  const page = dom[0];
  const footer = page.layers.content.find((o) => o.id.includes("b-footer"));
  assert(!!footer, "footer 在 ContentLayer（可编辑）");
  assert(!page.layers.base.some((o) => o.id.includes("b-footer")), "footer 不在 BaseLayer");
  assert(footer?.type === "Glyph", "footer 映射为 Glyph（非 Decoration）");
  console.groupEnd();
}

function testValidatorPass(): void {
  console.group("⑦ DOM Validator PASS（EditableDocument → Mapper → DOM → Validator）");
  const doc = makeEditableDocument();
  const dom = mapEditableDocumentToDom(doc);
  // 默认只跑 Schema + Content；PDF 场景需显式注入 pdfBaseLayerRule（Builder Contract）
  const result = validateDom(dom);
  assert(result.pass === true, `Golden Test Validator PASS（默认 Schema+Content，${dom.length} pages）`);
  if (!result.pass) {
    for (const i of result.issues) console.log(`    [${i.code}] page ${i.page}: ${i.message}`);
  }
  // PDF 特有规则（Builder Contract）注入后仍 PASS（Mapper 每页都产 PdfFallback）
  const resultPdf = validateDom(dom, { businessRules: [pdfBaseLayerRule] });
  assert(resultPdf.pass === true, "PDF Builder Contract（pdfBaseLayerRule）注入后仍 PASS");
  console.groupEnd();
}

function testNegativeValidation(): void {
  console.group("⑧ 负向验证：Validator 能捕获结构违规");
  // 人为构造违规：editable=false 放进 ContentLayer
  const badPage: DomPage = {
    metadata: { index: 1, width: 100, height: 100 },
    layers: {
      base: [{ id: "obj-bad", type: "Decoration", editable: false, anchor: "TOP", bbox: { x: 0, y: 0, width: 10, height: 10 } }],
      content: [{ id: "obj-nonedit", type: "Decoration", editable: false, anchor: "TOP", bbox: { x: 0, y: 0, width: 10, height: 10 } }],
      interaction: [],
      overlay: [],
    },
    runtime: { dirty: false, visible: true },
  };
  const r: DomValidationResult = validateDom([badPage]);
  assert(r.pass === false, "Validator 拒绝违规 DOM");
  assert(r.issues.some((i) => i.code === "NON_EDITABLE_IN_CONTENT"), "捕获 NON_EDITABLE_IN_CONTENT");
  console.groupEnd();
}

function testMapperSingleDirection(): void {
  console.group("⑨ 单向映射验证（无 Page → EditableDocument 反向）");
  // Mapper 只导出 EditableDocument → Page[]；不存在反向函数（静态约束：模块 API 不提供 reverse）
  const doc = makeEditableDocument();
  const dom = mapEditableDocumentToDom(doc);
  assert(dom.length >= 1, "Mapper 输出 DomPage[]");
  assert(
    !("reverse" in mapEditableDocumentToDom as unknown as object),
    "Mapper 不暴露 reverse 能力（单向）",
  );
  console.groupEnd();
}

export function runAllTests(): { name: string; pass: boolean }[] {
  results = [];
  console.log("%c── DOM Golden Test (Sprint-120 · Phase 1 · Task-4) ──", "font-weight:bold;color:#8b5cf6;");
  testPageCount();
  testContentLayer();
  testBaseLayer();
  testStructureConstraints();
  testThreeTierValidation();
  testFooterStaysEditable();
  testValidatorPass();
  testNegativeValidation();
  testMapperSingleDirection();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  return results;
}

if (typeof process !== "undefined" && process.argv.length > 1) {
  const main = process.argv[1].replace(/\\/g, "/").replace(/^\.?\//, "");
  const self = import.meta.url.replace("file://", "").replace(/\\/g, "/");
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("dom-golden.test.ts")) {
    const rs = runAllTests();
    if (rs.some((r) => !r.pass)) process.exit(1);
  }
}
