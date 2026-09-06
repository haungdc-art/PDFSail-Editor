/**
 * @diagnostic BUG-COORD-Y-ROOT-001 · 原始 PDF vs 真实导出 PDF · 同一行对照
 *
 * 直接对比两个 PDF 的 content stream，取出同一 text run 的：
 *   Tm(content) / full matrix / origin(x,y) / Tf / codes
 *
 * 用法:
 *   npx tsx _diag_ytrace_02_cmp.mts <原始PDF> <导出PDF> [needle]
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";

(globalThis as any).document = {
  createElement(tag: string) {
    if (tag === "canvas") return createCanvas(1, 1);
    throw new Error(`diag: unsupported <${tag}>`);
  },
  getElementsByTagName: () => [] as any,
  createElementNS: (_ns: string, tag: string) => (globalThis as any).document.createElement(tag),
} as any;
if (!(globalThis as any).Image) {
  (globalThis as any).Image = class { width = 0; height = 0; src = ""; onload: any = null; onerror: any = null; };
}

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
(pdfjs as any).GlobalWorkerOptions.workerSrc = new URL(
  "../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url,
).href;

const OPS: Record<string, number> = (pdfjs as any).OPS ?? {};
const OP_NAME: Record<number, string> = {};
for (const [k, v] of Object.entries(OPS)) if (typeof v === "number") OP_NAME[v] = k;

const r = (n: any, d = 3) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);

type M6 = [number, number, number, number, number, number];
function mul(A: M6, B: M6): M6 {
  return [
    A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3],
    A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3],
    A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5],
  ];
}
function translate(m: M6, tx: number, ty: number): M6 {
  return [m[0], m[1], m[2], m[3], m[4] + tx * m[0] + ty * m[2], m[5] + tx * m[1] + ty * m[3]];
}

interface RawRun { seq: number; tm: M6; full: M6; fontRes: string; tfSize: number; codes: number[]; text: string; }

async function extractRuns(path: string): Promise<RawRun[]> {
  const buf = readFileSync(path);
  const bytes = new Uint8Array(Uint8Array.from(buf).buffer);
  const doc = await (pdfjs as any).getDocument({
    data: bytes, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true,
  }).promise;
  const runs: RawRun[] = [];
  let seq = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const ol = await page.getOperatorList();
    let ctm: M6 = [1, 0, 0, 1, 0, 0];
    let tm: M6 = [1, 0, 0, 1, 0, 0];
    let tlm: M6 = [1, 0, 0, 1, 0, 0];
    let tl = 0, ts = 0, tz = 1, tfs = 0, fontRes = "?";
    const gsStack: M6[] = []; // q/Q 图形状态栈（此前缺失 → CTM 泄漏）
    for (let i = 0; i < ol.fnArray.length; i++) {
      const name = OP_NAME[ol.fnArray[i]] ?? String(ol.fnArray[i]);
      const args = (ol.argsArray[i] ?? []) as any[];
      switch (name) {
        case "transform": ctm = mul([args[0], args[1], args[2], args[3], args[4], args[5]] as M6, ctm); break;
        case "save": gsStack.push([...ctm] as M6); break;
        case "restore": ctm = gsStack.pop() ?? ctm; break;
        case "beginText": tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0]; break;
        case "setFont": fontRes = String(args[0] ?? "?"); tfs = Number(args[1]); break;
        case "setTextMatrix": tm = [args[0], args[1], args[2], args[3], args[4], args[5]] as M6; tlm = [...tm] as M6; break;
        case "moveText": tlm = translate(tlm, Number(args[0]) || 0, Number(args[1]) || 0); tm = [...tlm] as M6; break;
        case "setLeadingMoveText": tl = -(Number(args[1]) || 0); tlm = translate(tlm, Number(args[0]) || 0, Number(args[1]) || 0); tm = [...tlm] as M6; break;
        case "nextLine": tlm = translate(tlm, 0, -tl); tm = [...tlm] as M6; break;
        case "setLeading": tl = Number(args[0]) || 0; break;
        case "setTextRise": ts = Number(args[0]) || 0; break;
        case "setHScale": tz = (Number(args[0]) || 100) / 100; break;
        case "showText":
        case "showSpacedText": {
          const glyphs = (args[0] ?? []) as any[];
          const codes: number[] = []; let text = "";
          for (const g of glyphs) {
            if (typeof g === "number") codes.push(g);
            else if (g && typeof g === "object") {
              const fc = g.fontChar ?? g.unicode ?? "";
              if (typeof fc === "string" && fc.length) codes.push(fc.codePointAt(0)!);
              text += g.unicode ?? g.fontChar ?? "";
            } else if (typeof g === "string") text += g;
          }
          const param: M6 = [tfs * tz, 0, 0, tfs, 0, ts];
          runs.push({ seq: seq++, tm: [...tm] as M6, full: mul(mul(param, tm), ctm), fontRes, tfSize: tfs, codes, text });
          break;
        }
        default: break;
      }
    }
  }
  await doc.destroy();
  return runs;
}

function dump(tag: string, runs: RawRun[], needle: string, yFrom: number, yTo: number) {
  console.log(`\n${"─".repeat(96)}`);
  console.log(`${tag}   (runs=${runs.length})`);
  console.log(`${"─".repeat(96)}`);

  const matched = runs.filter((x) => x.text.includes(needle));
  console.log(`\n【A】text 含 ${JSON.stringify(needle)} 的 run: ${matched.length}`);
  for (const x of matched) {
    console.log(
      `  #${x.seq} ${JSON.stringify(x.text)}\n` +
      `      Tm(content) = [${x.tm.map((n) => r(n)).join(", ")}]\n` +
      `      full        = [${x.full.map((n) => r(n)).join(", ")}]\n` +
      `      origin      = (${r(x.full[4])}, ${r(x.full[5])}) pt\n` +
      `      Tf          = /${x.fontRes} ${x.tfSize}\n` +
      `      codes       = [${x.codes.join(",")}]`,
    );
  }

  const near = runs.filter((x) => x.full[5] >= yFrom && x.full[5] <= yTo);
  console.log(`\n【B】origin.y ∈ [${yFrom}, ${yTo}] 的所有 run（该行 + 上下邻行）: ${near.length}`);
  for (const x of near) {
    console.log(
      `  #${x.seq} y=${String(r(x.full[5])).padStart(8)}  x=${String(r(x.full[4])).padStart(8)}  ` +
      `Tm.ty=${String(r(x.tm[5])).padStart(9)}  /${x.fontRes} ${x.tfSize}  ${JSON.stringify(x.text)}`,
    );
  }
}

async function main() {
  const origPath = process.argv[2];
  const expPath = process.argv[3];
  const needle = process.argv[4] || "268282";
  if (!origPath || !expPath) {
    console.error("用法: npx tsx _diag_ytrace_02_cmp.mts <原始PDF> <导出PDF> [needle]");
    process.exit(2);
  }
  for (const p of [origPath, expPath]) {
    if (!existsSync(resolve(p))) { console.error(`文件不存在: ${p}`); process.exit(2); }
  }

  console.log("=".repeat(96));
  console.log("原始 PDF vs 真实导出 PDF · 同一 text run 对照");
  console.log("=".repeat(96));
  console.log(`原始: ${resolve(origPath)}`);
  console.log(`导出: ${resolve(expPath)}`);

  const yFrom = process.argv[5] !== undefined ? Number(process.argv[5]) : 555;
  const yTo = process.argv[6] !== undefined ? Number(process.argv[6]) : 600;

  const origRuns = await extractRuns(origPath);
  const expRuns = await extractRuns(expPath);

  dump("【原始 PDF】", origRuns, needle, yFrom, yTo);
  dump("【导出 PDF】", expRuns, needle, yFrom, yTo);

  // 对照表
  const a = origRuns.filter((x) => x.text.includes(needle))[0];
  const b = expRuns.filter((x) => x.text.includes(needle))[0];
  console.log(`\n\n${"=".repeat(96)}`);
  console.log("对照表");
  console.log("=".repeat(96));
  const w = [16, 12, 14, 12, 20, 14];
  const fmt = (arr: string[]) => "  " + arr.map((s, i) => String(s).padEnd(w[i])).join(" │ ");
  const sep = "  " + w.map((n) => "─".repeat(n)).join("─┼─");
  console.log(sep);
  console.log(fmt(["阶段", "X", "Y", "fontSize", "Font", "CharCode"]));
  console.log(sep);
  if (a) console.log(fmt(["原始 operator", r(a.full[4], 2) + "", r(a.full[5], 3) + "", r(a.tfSize, 2) + "", "/" + a.fontRes, String(a.codes[0])]));
  if (b) console.log(fmt(["最终 PDF", r(b.full[4], 2) + "", r(b.full[5], 3) + "", r(b.tfSize, 2) + "", "/" + b.fontRes, String(b.codes[0])]));
  console.log(sep);
  if (a && b) {
    console.log(`\n  ΔX = ${r(b.full[4] - a.full[4], 4)} pt`);
    console.log(`  ΔY = ${r(b.full[5] - a.full[5], 4)} pt   ${b.full[5] > a.full[5] ? "（向上偏移）" : "（向下偏移）"}`);
    console.log(`  ΔTm.ty = ${r(b.tm[5] - a.tm[5], 4)} pt`);
    console.log(`\n  参考: fontSize ${a.tfSize} × 0.72 = ${r(a.tfSize * 0.72, 4)}`);
    console.log(`        原 Y=${r(a.full[5])}  +  ascent(${r(a.tfSize * 0.72)})  = ${r(a.full[5] + a.tfSize * 0.72)}`);
    console.log(`        导出实测 Y = ${r(b.full[5])}`);
  }
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
