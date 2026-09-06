/**
 * @diagnostic BUG-COORD-Y-ROOT-001 · 权威落点对照（pdf.js getTextContent）
 *
 * getTextContent() 的 item.transform 已完整计入 CTM，是文字在 user space 的权威位置。
 * 用它直接对比【原始 PDF】与【导出 PDF】，避免自己模拟 CTM 出错。
 *
 * 用法: npx tsx _diag_ytrace_03_textcontent.mts <原始PDF> <导出PDF> [yFrom] [yTo]
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

const r = (n: any, d = 3) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);

interface Item { str: string; tx: number; ty: number; w: number; h: number; font: string; }

async function items(path: string): Promise<Item[]> {
  const buf = readFileSync(path);
  const bytes = new Uint8Array(Uint8Array.from(buf).buffer);
  const doc = await (pdfjs as any).getDocument({
    data: bytes, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true,
  }).promise;
  const out: Item[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    for (const it of tc.items as any[]) {
      if (!("str" in it)) continue;
      const t = it.transform as number[];
      out.push({ str: it.str ?? "", tx: t[4], ty: t[5], w: it.width ?? 0, h: it.height ?? 0, font: it.fontName ?? "?" });
    }
  }
  await doc.destroy();
  return out;
}

/** 把同一 baseline 上的相邻单字符 item 合并成行，便于阅读 */
function groupByBaseline(list: Item[], tol = 0.6) {
  const map = new Map<string, Item[]>();
  for (const it of list) {
    const key = r(it.ty, 1).toFixed(1);
    const arr = map.get(key) ?? [];
    arr.push(it);
    map.set(key, arr);
  }
  return [...map.entries()]
    .map(([k, arr]) => {
      const sorted = arr.slice().sort((a, b) => a.tx - b.tx);
      return {
        y: Number(k),
        text: sorted.map((s) => s.str).join(""),
        x0: sorted[0]?.tx ?? NaN,
        font: sorted[0]?.font ?? "?",
        h: sorted[0]?.h ?? NaN,
        n: sorted.length,
      };
    })
    .sort((a, b) => b.y - a.y);
}

async function main() {
  const origPath = process.argv[2];
  const expPath = process.argv[3];
  const yFrom = process.argv[4] !== undefined ? Number(process.argv[4]) : 545;
  const yTo = process.argv[5] !== undefined ? Number(process.argv[5]) : 600;
  if (!origPath || !expPath) {
    console.error("用法: npx tsx _diag_ytrace_03_textcontent.mts <原始PDF> <导出PDF> [yFrom] [yTo]");
    process.exit(2);
  }
  for (const p of [origPath, expPath]) if (!existsSync(resolve(p))) { console.error(`文件不存在: ${p}`); process.exit(2); }

  const orig = await items(origPath);
  const exp = await items(expPath);

  console.log("=".repeat(104));
  console.log("pdf.js getTextContent 权威落点对照（user space，含完整 CTM）");
  console.log("=".repeat(104));
  console.log(`原始: ${resolve(origPath)}   items=${orig.length}`);
  console.log(`导出: ${resolve(expPath)}   items=${exp.length}`);

  const band = (list: Item[]) => list.filter((x) => x.ty >= yFrom && x.ty <= yTo);

  console.log(`\n\n${"═".repeat(104)}`);
  console.log(`【原始 PDF】baseline y ∈ [${yFrom}, ${yTo}]`);
  console.log("═".repeat(104));
  for (const row of groupByBaseline(band(orig))) {
    console.log(`  y=${String(r(row.y)).padStart(8)}  x0=${String(r(row.x0)).padStart(8)}  h=${String(r(row.h)).padStart(5)}  n=${String(row.n).padStart(3)}  ${row.font}  ${JSON.stringify(row.text)}`);
  }

  console.log(`\n\n${"═".repeat(104)}`);
  console.log(`【导出 PDF】baseline y ∈ [${yFrom}, ${yTo}]`);
  console.log("═".repeat(104));
  for (const row of groupByBaseline(band(exp))) {
    console.log(`  y=${String(r(row.y)).padStart(8)}  x0=${String(r(row.x0)).padStart(8)}  h=${String(r(row.h)).padStart(5)}  n=${String(row.n).padStart(3)}  ${row.font}  ${JSON.stringify(row.text)}`);
  }

  // ── 直接找被编辑行：原始 "268282-1-1" 与导出里的对应项 ──
  const oRow = groupByBaseline(orig).find((x) => x.text.includes("268282-1-1"));
  const eRow = groupByBaseline(exp).find((x) => x.text.includes("268282-1-1"));
  console.log(`\n\n${"═".repeat(104)}`);
  console.log("被编辑行对照（含 '268282-1-1' 的 baseline）");
  console.log("═".repeat(104));
  console.log(`  原始: ${oRow ? `y=${r(oRow.y)}  x0=${r(oRow.x0)}  h=${r(oRow.h)}  ${oRow.font}  ${JSON.stringify(oRow.text)}` : "未找到"}`);
  console.log(`  导出: ${eRow ? `y=${r(eRow.y)}  x0=${r(eRow.x0)}  h=${r(eRow.h)}  ${eRow.font}  ${JSON.stringify(eRow.text)}` : "未找到"}`);
  if (oRow && eRow) {
    console.log(`\n  ΔY = ${r(eRow.y - oRow.y, 4)} pt  ${eRow.y > oRow.y ? "（向上偏移）" : "（向下偏移）"}`);
    console.log(`  参考: fontSize 6.6 × 0.72 = ${r(6.6 * 0.72, 4)}（ascent）`);
  }

  // ── 导出 PDF 里 y=572.102 附近 ──
  const near572 = groupByBaseline(exp.filter((x) => Math.abs(x.ty - 572.102) < 0.01));
  if (near572.length) {
    console.log(`\n\n${"═".repeat(104)}`);
    console.log("【导出 PDF】baseline y == 572.102 的文字（overlay 新绘制）");
    console.log("═".repeat(104));
    for (const row of near572) {
      console.log(`  y=${r(row.y)}  x0=${r(row.x0)}  h=${r(row.h)}  n=${row.n}  ${row.font}  ${JSON.stringify(row.text)}`);
    }
  }
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
