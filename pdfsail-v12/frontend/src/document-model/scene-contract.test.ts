/**
 * scene-contract.test.ts — Scene Contract Definition Test（Sprint-116）
 *
 * 验证 PM Case-001 场景：
 *   Scene Inventory: Background=1, Glyph=126, Signature=1, Decoration=2
 *   → Scene Contract: PdfFallbackObject(blocking,required), GlyphObject(count=126),
 *                     SignatureObject(rotation=45), DecorationObject(blocking:false)
 * Builder 只认识工程类型，不知道 "background"/"signature" 业务术语。
 */
import { inventoryToContract, SceneObjectType } from "./scene-contract";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

function testCase001(): void {
  console.group("① Case-001 Scene Inventory → Scene Contract");
  const inv = { glyph: 126, signature: 1, background: 1, decoration: 2, image: 0, table: 0, annotation: 0, form: 0 };
  const contract = inventoryToContract(inv, 1, { SignatureObject: { rotation: 45, source: "Raw Image #3" } });
  const types = contract.objects.map((o) => o.type);

  // 工程类型（无业务术语 "background"/"signature"）
  assert(types.includes("PdfFallbackObject"), `background→PdfFallbackObject（${types.join(",")}）`);
  assert(types.includes("SignatureObject"), "signature→SignatureObject");
  assert(types.includes("GlyphObject"), "glyph→GlyphObject");
  assert(types.includes("DecorationObject"), "decoration→DecorationObject");

  // Blocking/Required
  const pf = contract.objects.find((o) => o.type === "PdfFallbackObject")!;
  assert(pf.blocking === true && pf.required === true, "PdfFallbackObject blocking+required");
  const deco = contract.objects.find((o) => o.type === "DecorationObject")!;
  assert(deco.blocking === false, "DecorationObject blocking=false（非阻塞）");

  // count / rotation
  const glyph = contract.objects.find((o) => o.type === "GlyphObject")!;
  assert(glyph.count === 126, `GlyphObject count=126`);
  const sig = contract.objects.find((o) => o.type === "SignatureObject")!;
  assert(sig.rotation === 45, `SignatureObject rotation=45`);
  assert(sig.source === "Raw Image #3", "SignatureObject source");
  console.groupEnd();
}

function testScanned(): void {
  console.group("② 扫描件 Scene Inventory → Contract");
  const inv = { glyph: 0, signature: 0, background: 1, decoration: 0, image: 0, table: 0, annotation: 0, form: 1 };
  const contract = inventoryToContract(inv, 1);
  const types = contract.objects.map((o) => o.type);
  assert(types.includes("PdfFallbackObject"), "扫描件 background=1 → PdfFallbackObject");
  assert(types.includes("FormObject"), "form→FormObject");
  assert(!types.includes("GlyphObject"), "扫描件无 GlyphObject（glyph=0）");
  console.groupEnd();
}

function testNoBusinessInContract(): void {
  console.group("③ Contract 不含业务术语");
  const inv = { glyph: 10, signature: 1, background: 1, decoration: 0, image: 0, table: 0, annotation: 0, form: 0 };
  const contract = inventoryToContract(inv, 1);
  const json = JSON.stringify(contract);
  assert(!json.includes('"background"'), "Contract 不含 business 'background'");
  assert(!json.includes('"signature"') || json.includes('"SignatureObject"'), "Contract 用 SignatureObject 非 signature");
  console.groupEnd();
}

export function runAllTests(): { name: string; pass: boolean }[] {
  results = [];
  console.log("%c── Scene Contract Definition Test (Sprint-116) ──", "font-weight:bold;color:#8b5cf6;");
  testCase001();
  testScanned();
  testNoBusinessInContract();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  return results;
}

if (typeof process !== "undefined" && process.argv.length > 1) {
  const main = process.argv[1].replace(/\\/g, "/").replace(/^\.?\//, "");
  const self = import.meta.url.replace("file://", "").replace(/\\/g, "/");
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("scene-contract.test.ts")) {
    const rs = runAllTests();
    if (rs.some((r) => !r.pass)) process.exit(1);
  }
}
