/**
 * @diagnostic BUG-COORD-Y-ROOT-001 · Stage 0 探针（完整 PDF 文字状态机）
 *
 * 目的：在【原始 PDF】的 content stream operator list 里定位被编辑的 text run。
 *      用户给的真实证据：Tm = [1 0 0 1 24 -224.65]，page transform translate 792
 *      => user-space baseline Y = 567.35pt
 *
 * 关键：必须完整模拟 PDF 文字状态机（Tm / Td / TD / T* / Ts / Tz / cm），
 *      否则所有 run 都会读到同一个初始 Tm。
 *
 * 只读取，不修改任何 production 代码。
 *
 * 用法: npx tsx frontend/src/document-model/_diag_ytrace_00_probe.mts <PDF路径>
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
for (const [k, v] of Object.entries(OPS)) {
  if (typeof v === "number") OP_NAME[v] = k;
}

const r = (n: any, d = 3) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);

type M6 = [number, number, number, number, number, number];

/** PDF 矩阵乘法（行向量约定）：result = A × B（先 A 后 B） */
function mul(A: M6, B: M6): M6 {
  return [
    A[0] * B[0] + A[1] * B[2],
    A[0] * B[1] + A[1] * B[3],
    A[2] * B[0] + A[3] * B[2],
    A[2] * B[1] + A[3] * B[3],
    A[4] * B[0] + A[5] * B[2] + B[4],
    A[4] * B[1] + A[5] * B[3] + B[5],
  ];
}

/** 在文字行矩阵上做 translate(tx,ty) */
function translate(m: M6, tx: number, ty: number): M6 {
  return [m[0], m[1], m[2], m[3], m[4] + tx * m[0] + ty * m[2], m[5] + tx * m[1] + ty * m[3]];
}

const TARGET_Y = 567.35; // user-space baseline
const TARGET_X = 24;

interface Run {
  seq: number;
  /** content-stream 文字矩阵（Tm，用户空间，未含 Tf 缩放） */
  tm: M6;
  /** 参数矩阵 [Tfs*Tz, 0, 0, Tfs, 0, Ts] */
  param: M6;
  /** 完整渲染矩阵 param × tm × ctm，[4],[5] 应等于 pdf.js item.transform[4],[5] */
  full: M6;
  fontRes: string;
  tfSize: number;
  op: string;
  rawCodes: number[];
  text: string;
  isTarget: boolean;
}

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) { console.error("用法: npx tsx _diag_ytrace_00_probe.mts <PDF路径>"); process.exit(2); }
  const abs = resolve(pdfPath);
  if (!existsSync(abs)) { console.error(`文件不存在: ${abs}`); process.exit(2); }

  const fileBuf = readFileSync(abs);
  const bytes = new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength);
  const doc = await (pdfjs as any).getDocument({
    data: bytes, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true,
  }).promise;

  console.log(`文件: ${abs}`);
  console.log(`页数: ${doc.numPages}`);

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    console.log(`\n========== Page ${p} ==========`);
    console.log(`  MediaBox view = [${(page.view as number[]).join(", ")}]`);
    console.log(`  viewport(scale=1) = ${r(vp.width)} × ${r(vp.height)} pt`);
    console.log(`  CTM (viewport.transform) = [${vp.transform.map((n) => r(n, 2)).join(", ")}]`);

    const [tc, ol] = await Promise.all([page.getTextContent(), page.getOperatorList()]);

    // ── 文字状态机 ──
    let ctm: M6 = [1, 0, 0, 1, 0, 0];
    let tm: M6 = [1, 0, 0, 1, 0, 0];
    let tlm: M6 = [1, 0, 0, 1, 0, 0];
    let tl = 0;      // leading
    let ts = 0;      // rise
    let tz = 1;      // horizontal scale (/100)
    let tfs = 0;     // font size
    let fontRes = "?";
    const runs: Run[] = [];
    let seq = 0;

    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i];
      const name = OP_NAME[fn] ?? String(fn);
      const args = (ol.argsArray[i] ?? []) as any[];

      switch (name) {
        case "transform": // cm
          ctm = mul([args[0], args[1], args[2], args[3], args[4], args[5]] as M6, ctm);
          break;
        case "save":
        case "restore":
          break;
        case "beginText":
          tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0];
          break;
        case "endText":
          break;
        case "setFont":
          fontRes = String(args[0] ?? "?"); tfs = Number(args[1]);
          break;
        case "setTextMatrix":
          tm = [args[0], args[1], args[2], args[3], args[4], args[5]] as M6;
          tlm = [...tm] as M6;
          break;
        case "moveText": // Td
          tlm = translate(tlm, Number(args[0]) || 0, Number(args[1]) || 0);
          tm = [...tlm] as M6;
          break;
        case "setLeadingMoveText": // TD
          tl = -(Number(args[1]) || 0);
          tlm = translate(tlm, Number(args[0]) || 0, Number(args[1]) || 0);
          tm = [...tlm] as M6;
          break;
        case "nextLine": // T*
          tlm = translate(tlm, 0, -tl);
          tm = [...tlm] as M6;
          break;
        case "setLeading": tl = Number(args[0]) || 0; break;
        case "setTextRise": ts = Number(args[0]) || 0; break;
        case "setHScale": tz = (Number(args[0]) || 100) / 100; break;
        case "showText":
        case "showSpacedText": {
          const glyphs = (args[0] ?? []) as any[];
          const rawCodes: number[] = [];
          let text = "";
          for (const g of glyphs) {
            if (typeof g === "number") rawCodes.push(g);
            else if (g && typeof g === "object") {
              const fc = g.fontChar ?? g.unicode ?? "";
              if (typeof fc === "string" && fc.length) rawCodes.push(fc.codePointAt(0)!);
              text += g.unicode ?? g.fontChar ?? "";
            } else if (typeof g === "string") text += g;
          }
          const param: M6 = [tfs * tz, 0, 0, tfs, 0, ts];
          const full = mul(mul(param, tm), ctm);
          const isTarget = Math.abs(full[4] - TARGET_X) < 0.6 && Math.abs(full[5] - TARGET_Y) < 0.6;
          runs.push({ seq: seq++, tm: [...tm] as M6, param, full, fontRes, tfSize: tfs, op: name, rawCodes, text, isTarget });
          break;
        }
        default: break;
      }
    }

    console.log(`\n  --- showText runs: ${runs.length} ---`);
    for (const run of runs) {
      const flag = run.isTarget ? " ★★★ TARGET ★★★" : "";
      console.log(
        `    #${run.seq}${flag} op=${run.op} font=/${run.fontRes} Tfs=${run.tfSize}\n` +
        `        Tm(content)= [${run.tm.map((n) => r(n)).join(", ")}]\n` +
        `        full      = [${run.full.map((n) => r(n)).join(", ")}]   → origin x=${r(run.full[4])} y=${r(run.full[5])}\n` +
        `        text      = ${JSON.stringify(run.text)}  codes[${run.rawCodes.length}]=[${run.rawCodes.slice(0, 20).join(",")}${run.rawCodes.length > 20 ? ",…" : ""}]`,
      );
    }

    // ── 校验：full[4],[5] 应与 pdf.js item.transform[4],[5] 一致 ──
    console.log(`\n  --- 状态机校验（对比 pdf.js TextContent） ---`);
    let ok = 0, bad = 0;
    let ti = 0;
    for (const item of tc.items as any[]) {
      if (!("str" in item)) continue;
      const t = item.transform as number[];
      const cand = runs.find((x) => Math.abs(x.full[4] - t[4]) < 0.05 && Math.abs(x.full[5] - t[5]) < 0.05);
      if (cand) ok++; else { if (bad < 5) console.log(`    ✗ item[${ti}] ${JSON.stringify(item.str)} Tm=[${t.map((n) => r(n, 2)).join(",")}] 无匹配 run`); bad++; }
      ti++;
    }
    console.log(`    匹配 ${ok} / 不匹配 ${bad}`);

    const hits = runs.filter((x) => x.isTarget);
    console.log(`\n  >>> 命中 TARGET (origin x≈${TARGET_X}, y≈${TARGET_Y}) : ${hits.length}`);
    for (const h of hits) {
      console.log(`      #${h.seq} Tm=[${h.tm.map((n) => r(n)).join(", ")}] font=/${h.fontRes} Tfs=${h.tfSize} text=${JSON.stringify(h.text)}`);
    }
  }
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
