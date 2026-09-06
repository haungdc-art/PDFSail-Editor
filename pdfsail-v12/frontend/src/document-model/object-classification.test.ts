/**
 * object-classification.test.ts — Object Classification Engine Test（Sprint-113/114）
 *
 * 验证 PM 场景：Image=1 可能是 Logo/整页背景/扫描位图/签名/透明mask，
 * 返回 SceneIntent（kind + confidence），Scene Builder 只消费 SceneIntent。
 */
import { classifyRawImage, intentsToExpected } from "./object-classification";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}
const PAGE = { width: 1240, height: 1754 };

function testScannedBitmap(): void {
  console.group("① 扫描件整页位图 → pdf-fallback (SceneIntent)");
  const r = classifyRawImage({ bbox: { x: 0, y: 0, width: 1240, height: 1754 }, pageSize: PAGE });
  assert(r.kind === "pdf-fallback", `kind=${r.kind}`);
  assert(r.confidence >= 0.9, `confidence=${r.confidence}（全页位图几何确定，应≥0.9）`);
  console.groupEnd();
}

function testSignature(): void {
  console.group("② 签名图（rotation）→ signature");
  const r = classifyRawImage({ bbox: { x: 800, y: 1500, width: 200, height: 100 }, pageSize: PAGE, rotation: 45 });
  assert(r.kind === "signature", `kind=${r.kind}`);
  assert(r.confidence > 0, "confidence 输出");
  console.groupEnd();
}

function testLogo(): void {
  console.group("③ 页眉小 logo → decoration（低置信度）");
  const r = classifyRawImage({ bbox: { x: 50, y: 20, width: 80, height: 40 }, pageSize: PAGE });
  assert(r.kind === "decoration", `kind=${r.kind}`);
  assert(r.confidence < 0.9, `confidence=${r.confidence}（几何不确定，应<0.9）`);
  console.groupEnd();
}

function testEmbeddedPhoto(): void {
  console.group("④ 正文内嵌照片 → image（中等置信度）");
  const r = classifyRawImage({ bbox: { x: 300, y: 600, width: 300, height: 200 }, pageSize: PAGE });
  assert(r.kind === "image", `kind=${r.kind}`);
  console.groupEnd();
}

function testSceneIntentConsumed(): void {
  console.group("⑤ SceneIntent 可被 Scene Builder 消费");
  const intents = [
    classifyRawImage({ bbox: { x: 0, y: 0, width: 1240, height: 1754 }, pageSize: PAGE }),
    classifyRawImage({ bbox: { x: 800, y: 1500, width: 200, height: 100 }, pageSize: PAGE, rotation: 45 }),
  ];
  const expected = intentsToExpected(intents);
  assert(expected["pdf-fallback"] === 1, "pdf-fallback=1");
  assert(expected.signature === 1, "signature=1");
  assert(expected.image === 0, "image=0（全页位图被正确分类为 pdf-fallback，非 image）");
  console.groupEnd();
}

export function runAllTests(): { name: string; pass: boolean }[] {
  results = [];
  console.log("%c── Object Classification Engine Test (Sprint-113/114) ──", "font-weight:bold;color:#8b5cf6;");
  testScannedBitmap();
  testSignature();
  testLogo();
  testEmbeddedPhoto();
  testSceneIntentConsumed();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  return results;
}

if (typeof process !== "undefined" && process.argv.length > 1) {
  const main = process.argv[1].replace(/\\/g, "/").replace(/^\.?\//, "");
  const self = import.meta.url.replace("file://", "").replace(/\\/g, "/");
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("object-classification.test.ts")) {
    const rs = runAllTests();
    if (rs.some((r) => !r.pass)) process.exit(1);
  }
}
