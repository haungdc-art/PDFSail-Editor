/**
 * @diagnostic BUG-COORD-Y-ROOT-001 · 导出 PDF 字体资源清点
 *
 * 目的：确认 overlay 行用的 g_d1_f3 到底是：
 *   (a) pdf-lib 新嵌入的 Standard 14（→ page.drawText 路径，Sprint40-fix），还是
 *   (b) 原 PDF 就有的嵌入/Type3 字体（→ native replay：tryNativeLineReplay / emitNativeTextRun）
 *
 * 这决定 Y=572.102 该去哪段代码找。
 *
 * 用法: npx tsx _diag_ytrace_06_fonts.mts <原始PDF> <导出PDF>
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { PDFDocument, PDFName, PDFDict, PDFRef, PDFRawStream } from "pdf-lib";

function subOf(v: any): string {
  const t = v?.constructor?.name ?? typeof v;
  if (v instanceof PDFRef) return `ref(${v.objectNumber})`;
  if (v instanceof PDFName) return `/${v.asString()}`;
  if (v?.toString) { const s = v.toString(); return s.length > 70 ? s.slice(0, 67) + "..." : s; }
  return t;
}

async function dump(path: string, tag: string) {
  console.log(`\n${"═".repeat(96)}`);
  console.log(`${tag}  ${path}`);
  console.log("═".repeat(96));
  const buf = readFileSync(path);
  const doc = await PDFDocument.load(new Uint8Array(Uint8Array.from(buf).buffer), {
    ignoreEncryption: true, throwOnInvalidObject: false,
  });

  for (let i = 0; i < doc.getPageCount(); i++) {
    const page = doc.getPage(i);
    const res = (page.node as any).Resources?.();
    const fontsDict = res?.lookup?.(PDFName.of("Font"), PDFDict);
    if (!fontsDict) { console.log(`  page ${i}: 无 /Font`); continue; }
    console.log(`\n  page ${i} /Font:`);
    for (const [key, val] of fontsDict.entries()) {
      const name = `/${key.asString()}`;
      let f: any = val;
      try { f = (val as any)?.lookup ? (val as any).lookup(PDFDict) ?? val : val; } catch { /* noop */ }
      let base = "-", sub = "-", type = "-", firstChar = "-", hasFontFile = false;
      try {
        const d = f?.constructor?.name === "PDFDict" ? f : (f?.dict ?? null);
        const g = (n: string) => { try { return d?.lookup?.(PDFName.of(n)); } catch { return undefined; } };
        base = subOf(g("BaseFont"));
        sub = subOf(g("Subtype"));
        type = subOf(g("FontDescriptor"));
        firstChar = subOf(g("FirstChar"));
        // 是否真的带字形字节（Type3 用 CharProcs）
        try {
          const fd = d?.lookup?.(PDFName.of("FontDescriptor"), PDFDict);
          if (fd) {
            for (const ff of ["FontFile", "FontFile2", "FontFile3"]) {
              const s = fd.lookup?.(PDFName.of(ff));
              if (s) { hasFontFile = true; break; }
            }
          }
          const cp = d?.lookup?.(PDFName.of("CharProcs"));
          if (cp) hasFontFile = true; // Type3
        } catch { /* noop */ }
      } catch (e) { /* noop */ }
      console.log(
        `    ${name.padEnd(10)} BaseFont=${String(base).padEnd(38)} Subtype=${String(sub).padEnd(12)} ` +
        `FirstChar=${String(firstChar).padEnd(6)} 字形数据=${hasFontFile ? "有" : "无"}`,
      );
    }
  }
}

async function main() {
  const origPath = process.argv[2];
  const expPath = process.argv[3];
  if (!origPath || !expPath) {
    console.error("用法: npx tsx _diag_ytrace_06_fonts.mts <原始PDF> <导出PDF>");
    process.exit(2);
  }
  for (const p of [origPath, expPath]) if (!existsSync(resolve(p))) { console.error(`文件不存在: ${p}`); process.exit(2); }

  await dump(origPath, "【原始 PDF】");
  await dump(expPath, "【导出 PDF】");

  console.log(`\n${"═".repeat(96)}`);
  console.log("判读：");
  console.log("  · 导出 PDF 里「字形数据=有」且 BaseFont 与原 PDF 同名 → native replay（原字体重绘）");
  console.log("  · 导出 PDF 里「字形数据=无」且 BaseFont=Helvetica 之类 → pdf-lib Standard 14（page.drawText）");
  console.log("═".repeat(96));
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
