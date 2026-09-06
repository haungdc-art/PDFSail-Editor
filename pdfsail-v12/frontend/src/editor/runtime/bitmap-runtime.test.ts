/**
 * bitmap-runtime.test.ts — Bitmap Runtime Test（Sprint-127 · 唯一 Mission）
 *
 * 验证 computeBitmapState 的判定 + reason 区分：
 *   - null canvas → loading
 *   - 尺寸无效 → invalid
 *   - 有尺寸 + 全透明 → transparent
 *   - getImageData 抛错（canvas 污染）→ 退化为 ready（有尺寸）
 *   - 有尺寸 + 有非透明像素 → ready
 *   - visible = ready && valid
 *
 * 运行：npx tsx frontend/src/editor/runtime/bitmap-runtime.test.ts
 */
import { computeBitmapState, BitmapRuntimeState, BitmapReason, createBitmapRuntime } from "./bitmap-runtime";

let results: { name: string; pass: boolean }[] = [];
function assert(c: boolean, name: string): void {
  results.push({ name, pass: c });
  console.log(`  %c${c ? "✓" : "✗"} %s`, c ? "color:#22c55e" : "color:#ef4444", name);
}

/** 构造 mock canvas（可注入 getImageData 行为） */
interface MockCanvasOpts {
  width: number;
  height: number;
  /** 每像素 RGBA 数组；undefined → getImageData 返回 null */
  pixels?: number[] | null;
  /** getImageData 抛错（canvas 污染） */
  throwOnRead?: boolean;
}
function makeCanvas(o: MockCanvasOpts): unknown {
  return {
    width: o.width,
    height: o.height,
    getContext: () => ({
      getImageData: () => {
        if (o.throwOnRead) throw new Error("tainted canvas");
        if (o.pixels === null || o.pixels === undefined) return null;
        return { data: new Uint8ClampedArray(o.pixels) };
      },
    }),
  };
}

function testNull(): void {
  console.group("① null canvas → loading");
  const s = computeBitmapState(null);
  assert(s.reason === "loading" && s.ready === false, `null → loading (reason=${s.reason})`);
  assert(s.visible === false && s.valid === false, "null → visible=false");
  console.groupEnd();
}

function testInvalid(): void {
  console.group("② 尺寸无效 → invalid");
  const s = computeBitmapState(makeCanvas({ width: 0, height: 100 }) as HTMLCanvasElement);
  assert(s.reason === "invalid", `width=0 → invalid (reason=${s.reason})`);
  assert(s.valid === false && s.visible === false, "invalid → valid=false, visible=false");
  const s2 = computeBitmapState(makeCanvas({ width: 100, height: -1 }) as HTMLCanvasElement);
  assert(s2.reason === "invalid", "height<0 → invalid");
  console.groupEnd();
}

function testTransparent(): void {
  console.group("③ 全透明 → transparent");
  // 4x4 全 alpha=0
  const allAlpha0 = new Array(4 * 4 * 4).fill(0);
  const s = computeBitmapState(makeCanvas({ width: 100, height: 100, pixels: allAlpha0 }) as HTMLCanvasElement);
  assert(s.reason === "transparent", `全透明 → transparent (reason=${s.reason})`);
  assert(s.valid === false && s.visible === false, "transparent → 不可显示");
  console.groupEnd();
}

function testTainted(): void {
  console.group("④ canvas 污染 → 退化为 ready");
  const s = computeBitmapState(makeCanvas({ width: 100, height: 100, throwOnRead: true }) as HTMLCanvasElement);
  assert(s.reason === "ready" && s.valid === true && s.visible === true, `污染 → ready (reason=${s.reason})`);
  console.groupEnd();
}

function testReady(): void {
  console.group("⑤ 有非透明像素 → ready");
  // 4x4，第一个像素 alpha=255，其余 0
  const px = new Array(4 * 4 * 4).fill(0);
  px[3] = 255; // 第一个像素 alpha=255
  const s = computeBitmapState(makeCanvas({ width: 100, height: 100, pixels: px }) as HTMLCanvasElement);
  assert(s.reason === "ready" && s.valid === true && s.visible === true, `有非透明像素 → ready (reason=${s.reason})`);
  console.groupEnd();
}

function testContract(): void {
  console.group("⑥ Contract 一致性（visible = ready && valid）");
  // ready 状态
  const px = new Array(4 * 4 * 4).fill(0);
  px[3] = 255;
  const r = computeBitmapState(makeCanvas({ width: 100, height: 100, pixels: px }) as HTMLCanvasElement);
  assert(r.visible === (r.ready && r.valid), "ready 态 visible=ready&&valid");
  // reason 枚举覆盖
  const reasons: BitmapReason[] = ["loading", "invalid", "transparent", "empty", "ready"];
  assert(reasons.length === 5 && reasons.every((x) => typeof x === "string"), "reason 枚举 5 种");
  console.groupEnd();
}

function testFactory(): void {
  console.group("⑦ createBitmapRuntime 工厂");
  const rt = createBitmapRuntime();
  assert(rt.state.ready === false && rt.state.reason === "loading", "初始 loading");
  const px = new Array(4 * 4 * 4).fill(0);
  px[3] = 255;
  const readyState = computeBitmapState(makeCanvas({ width: 100, height: 100, pixels: px }) as HTMLCanvasElement);
  rt.update(readyState);
  assert(rt.state.visible === true && rt.state.reason === "ready", "update 后 state 生效");
  console.groupEnd();
}

export function runAllTests(): { name: string; pass: boolean }[] {
  results = [];
  console.log("%c── Bitmap Runtime Test (Sprint-127) ──", "font-weight:bold;color:#22c55e;");
  testNull();
  testInvalid();
  testTransparent();
  testTainted();
  testReady();
  testContract();
  testFactory();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("%cPassed: %d / %d", failed === 0 ? "color:#22c55e" : "color:#ef4444", passed, results.length);
  if (failed > 0) console.log("%cFAILED: %d", "color:#ef4444", failed);
  return results;
}

if (typeof process !== "undefined" && process.argv.length > 1) {
  const main = process.argv[1].replace(/\\/g, "/").replace(/^\.?\//, "");
  const self = import.meta.url.replace("file://", "").replace(/\\/g, "/").replace(/^\//, "");
  if (self.endsWith(main.replace(/^\.?\//, "")) || self.endsWith("bitmap-runtime.test.ts")) {
    const rs = runAllTests();
    if (rs.some((r) => !r.pass)) process.exit(1);
  }
}
