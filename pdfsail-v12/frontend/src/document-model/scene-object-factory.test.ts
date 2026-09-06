/**
 * scene-object-factory.test.ts — Scene Object Factory Test（Sprint-117）
 *
 * 验证：consume(SceneContract) → produce(SceneObject[])，
 * Factory 用注入的数据源（PDF Adapter/Image Decoder）填充真实数据，Builder 只拿 SceneObject[]。
 */
import { inventoryToContract } from "./scene-contract";
import { consumeSceneContract, SceneObjectDataSources } from "./scene-object-factory";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

// Mock 数据源（模拟 PDF Adapter / Image Decoder / Cache）
const sources: SceneObjectDataSources = {
  getBitmap: (src) => ({ decoded: true, source: src }),
  getGlyphText: () => "Hello PDF",
  getTableShape: () => ({ rows: 3, cols: 4, bbox: { x: 50, y: 100, width: 400, height: 200 } }),
};

function testCase001(): void {
  console.group("① Case-001 Contract → Scene Objects");
  const inv = { glyph: 1, signature: 1, background: 1, decoration: 2, image: 0, table: 0, annotation: 0, form: 0 };
  const contract = inventoryToContract(inv, 1, { SignatureObject: { rotation: 45, source: "image#3" } });
  const objects = consumeSceneContract(contract, sources);

  // 每个 Contract 对象 → 一个 SceneObject 实例
  assert(objects.length === 5, `objects=${objects.length}（Glyph1+Signature1+Fallback1+Decoration2=5）`);
  const sig = objects.find((o) => o.kind === "SignatureObject");
  assert(sig?.kind === "SignatureObject", "SignatureObject 被产出");
  if (sig && sig.kind === "SignatureObject") {
    assert(sig.rotation === 45, `SignatureObject rotation=${sig.rotation}`);
    assert(sig.bitmap && (sig.bitmap as any).decoded === true, "Signature bitmap 由 Factory 用 getBitmap 解码");
  }
  const pf = objects.find((o) => o.kind === "PdfFallbackObject");
  assert(pf?.kind === "PdfFallbackObject", "PdfFallbackObject 被产出");
  console.groupEnd();
}

function testFactoryNotBuilder(): void {
  console.group("② Factory 负责数据获取，Builder 不依赖数据源");
  // consumeSceneContract 需要 sources（Factory 依赖数据源）
  // SceneObject[] 本身不含 pdf.js/bitmap decoder 引用（除 bitmap 数据）
  const inv = { glyph: 0, signature: 0, background: 1, decoration: 0, image: 0, table: 1, annotation: 0, form: 0 };
  const contract = inventoryToContract(inv, 1);
  const objects = consumeSceneContract(contract, sources);
  const table = objects.find((o) => o.kind === "TableObject");
  if (table && table.kind === "TableObject") {
    assert(table.rows === 3 && table.cols === 4, `TableObject rows/cols=${table.rows}/${table.cols}（来自 getTableShape）`);
  }
  console.groupEnd();
}

function testNoPdfJsInObjects(): void {
  console.group("③ SceneObject 不含 pdf.js 依赖");
  const inv = { glyph: 1, signature: 1, background: 1, decoration: 0, image: 0, table: 0, annotation: 0, form: 0 };
  const objects = consumeSceneContract(inventoryToContract(inv, 1), sources);
  const json = JSON.stringify(objects);
  assert(!json.includes("pdf.js") && !json.includes("getOperatorList"), "SceneObject 不含 pdf.js 内部 API");
  console.groupEnd();
}

export function runAllTests(): { name: string; pass: boolean }[] {
  results = [];
  console.log("%c── Scene Object Factory Test (Sprint-117) ──", "font-weight:bold;color:#8b5cf6;");
  testCase001();
  testFactoryNotBuilder();
  testNoPdfJsInObjects();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  return results;
}

if (typeof process !== "undefined" && process.argv.length > 1) {
  const main = process.argv[1].replace(/\\/g, "/").replace(/^\.?\//, "");
  const self = import.meta.url.replace("file://", "").replace(/\\/g, "/");
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("scene-object-factory.test.ts")) {
    const rs = runAllTests();
    if (rs.some((r) => !r.pass)) process.exit(1);
  }
}
