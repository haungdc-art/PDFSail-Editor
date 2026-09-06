/**
 * document-validator.test.ts — Document Validator Test（Sprint-118）
 *
 * 验证：
 *   1) 当前 Document Builder 只生成 text → Document 不完整（Header/Footer/Background/Signature Missing）
 *   2) 完整 Document（含 header/footer/background/signature/image/decoration/form）→ PASS
 *   3) 空 Document → 全 Missing，ratio=0
 */
import { validateDocument, defaultDocumentDetector, completenessFromCounts } from "./document-validator";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

function testCurrentTextOnly(): void {
  console.group("① 当前 Document Builder 只生成 text → 不完整");
  // 模拟当前 EditableDocument：只有 glyph 文本 block
  const doc = { pages: [{ blocks: [{ type: "text", lines: [{ glyphs: [{}, {}, {}] }] }] }] };
  const v = validateDocument(doc, defaultDocumentDetector);
  assert(v.pass === false, "pass=false（Document 不完整）");
  assert(v.completeness.glyph === true, "glyph 存在");
  assert(v.completeness.header === false, "header 缺失");
  assert(v.completeness.footer === false, "footer 缺失");
  assert(v.completeness.background === false, "background 缺失");
  assert(v.completeness.signature === false, "signature 缺失");
  assert(v.missing.includes("header") && v.missing.includes("footer"), "missing 含 header/footer");
  console.groupEnd();
}

function testCompleteDoc(): void {
  console.group("② 完整 Document → PASS");
  const counts = completenessFromCounts({ header: 1, footer: 1, background: 1, glyph: 100, signature: 1, image: 1, decoration: 2, annotation: 1, form: 1 });
  const doc = { pages: [{ blocks: [
    { regionType: "header", lines: [] }, { regionType: "footer", lines: [] },
    { type: "image", lines: [] }, { type: "image", lines: [] },
    { regionType: "signature", lines: [] }, { type: "text", lines: [{ glyphs: [{}, {}] }] },
    { regionType: "decoration", lines: [] }, { type: "form", lines: [] }, { type: "annotation", lines: [] },
  ] }] };
  const v = validateDocument(doc, defaultDocumentDetector);
  assert(v.pass === true, "pass=true（Document 完整）");
  assert(v.ratio === 100, `ratio=${v.ratio}%`);
  assert(v.missing.length === 0, "无缺失");
  console.groupEnd();
}

function testEmptyDoc(): void {
  console.group("③ 空 Document → 全 Missing");
  const v = validateDocument({ pages: [] }, defaultDocumentDetector);
  assert(v.ratio === 0, `ratio=${v.ratio}%`);
  assert(v.missing.length === 9, `missing=${v.missing.length}（9 类全缺）`);
  console.groupEnd();
}

function testScenarioCompleteness(): void {
  console.group("④ completenessFromCounts 构造");
  const c = completenessFromCounts({ header: 1, glyph: 5 });
  assert(c.header === true && c.glyph === true, "header/glyph=true");
  assert(c.background === false && c.signature === false, "background/signature=false");
  console.groupEnd();
}

export function runAllTests(): { name: string; pass: boolean }[] {
  results = [];
  console.log("%c── Document Validator Test (Sprint-118) ──", "font-weight:bold;color:#8b5cf6;");
  testCurrentTextOnly();
  testCompleteDoc();
  testEmptyDoc();
  testScenarioCompleteness();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  return results;
}

if (typeof process !== "undefined" && process.argv.length > 1) {
  const main = process.argv[1].replace(/\\/g, "/").replace(/^\.?\//, "");
  const self = import.meta.url.replace("file://", "").replace(/\\/g, "/");
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("document-validator.test.ts")) {
    const rs = runAllTests();
    if (rs.some((r) => !r.pass)) process.exit(1);
  }
}
