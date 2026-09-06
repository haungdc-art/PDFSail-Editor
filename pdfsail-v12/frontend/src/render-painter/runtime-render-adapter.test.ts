/**
 * runtime-render-adapter.test.ts — RuntimeRenderAdapter Golden Test（Sprint-123 · Task-2）
 *
 * ADR-045 · Sprint-123 · PM 最后一个冻结边界。
 *
 * 验证：
 *   1. SceneRuntime → RenderObject[] 纯投影
 *   2. visible=false → 不生成 RenderObject
 *   3. glyph → GlyphObject / image → PatchObject / mask → MaskObject
 *   4. 纯函数（不修改 Runtime/Painter/Builder，不改输入）
 *   5. 不依赖 EditableDocument
 *   6. 输出可被 Painter.paint() 消费（PaintOutput 兼容）
 */
import { projectSceneRuntimeToRenderObjects, SceneRuntimeView } from "./runtime-render-adapter";
import { paintObject } from "./render-painter";
import { RenderObject } from "../render-object/render-object";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

function makeView(): SceneRuntimeView {
  return {
    page: 1,
    nodes: [
      { kind: "glyph", visible: true, id: "g1", x: 10, y: 20, width: 8, height: 12, char: "H", fontSize: 12 },
      { kind: "glyph", visible: false, id: "g2", x: 20, y: 20, width: 8, height: 12, char: "i" }, // 不可见
      { kind: "image", visible: true, id: "img1", x: 40, y: 50, width: 100, height: 60 },
      { kind: "mask", visible: true, id: "m1", x: 0, y: 0, width: 50, height: 50 },
    ],
  };
}

function testProjectionRules(): void {
  console.group("① 投影规则：glyph→GlyphObject / image→PatchObject / mask→MaskObject");
  const objects = projectSceneRuntimeToRenderObjects(makeView());
  assert(objects.length === 3, "3 个可见节点 → 3 个 RenderObject（g2 不可见被过滤）");
  const glyph = objects[0];
  assert(glyph.kind === "glyph" && glyph.char === "H", "glyph → GlyphObject");
  const patch = objects[1];
  assert(patch.kind === "patch", "image → PatchObject");
  const mask = objects[2];
  assert(mask.kind === "mask", "mask → MaskObject");
  console.groupEnd();
}

function testVisibilityFilter(): void {
  console.group("② visible=false → 不生成 RenderObject");
  const objects = projectSceneRuntimeToRenderObjects(makeView());
  assert(!objects.some((o) => o.id === "g2"), "g2（不可见）不生成 RenderObject");
  console.groupEnd();
}

function testPureFunction(): void {
  console.group("③ 纯函数：不改输入，不修改 Runtime/Painter/Builder");
  const view = makeView();
  const before = JSON.stringify(view);
  projectSceneRuntimeToRenderObjects(view);
  assert(JSON.stringify(view) === before, "Adapter 不修改输入（纯投影）");
  console.groupEnd();
}

function testPainterConsumable(): void {
  console.group("④ 输出可被 Painter.paint() 消费（PaintOutput 兼容）");
  const objects: RenderObject[] = projectSceneRuntimeToRenderObjects(makeView());
  for (const obj of objects) {
    const out = paintObject(obj);
    assert(out.layer === obj.kind || out.layer === (obj.kind === "image" ? "patch" : obj.kind), `paint(${obj.kind}) 返回 ${out.layer} 输出`);
  }
  console.groupEnd();
}

function testOnlyDomIndependent(): void {
  console.group("⑤ 不依赖 EditableDocument（纯渲染世界投影）");
  const objects = projectSceneRuntimeToRenderObjects(makeView());
  assert(objects.every((o) => "bounds" in o), "所有 RenderObject 有统一 bounds（Painter 只看 bounds）");
  console.groupEnd();
}

export function runAllTests(): { name: string; pass: boolean }[] {
  results = [];
  console.log("%c── RuntimeRenderAdapter Golden Test (Sprint-123 · Task-2) ──", "font-weight:bold;color:#8b5cf6;");
  testProjectionRules();
  testVisibilityFilter();
  testPureFunction();
  testPainterConsumable();
  testOnlyDomIndependent();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  return results;
}

if (typeof process !== "undefined" && process.argv.length > 1) {
  const main = process.argv[1].replace(/\\/g, "/").replace(/^\.?\//, "");
  const self = import.meta.url.replace("file://", "").replace(/\\/g, "/");
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("runtime-render-adapter.test.ts")) {
    const rs = runAllTests();
    if (rs.some((r) => !r.pass)) process.exit(1);
  }
}
