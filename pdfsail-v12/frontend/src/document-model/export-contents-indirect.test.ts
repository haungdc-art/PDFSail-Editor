/**
 * export-contents-indirect.test.ts — M7.8-042-FIX 回归测试
 *
 * 背景（用户报告「导出后第一页内容无法显示」）：
 *   pdf-lib 的 `PDFContext.stream()` / `flateStream()` 返回的是**未注册**的 PDFRawStream。
 *   把它直接写进 `/Contents` 会产出「直接流对象」：
 *       /Contents [ 19 0 R << /Length 15381 >> stream ... endstream 20 0 R 18 0 R ]
 *   流必须是间接对象（ISO 32000-1 §7.3.8），否则 Chrome / Acrobat 判定页面内容流损坏 → 整页空白。
 *
 *   根因位置：export-renderer.ts（stripReplacedTextOperators 的 embedded 写回分支）
 *            native-export-policy.ts（writeBackPageStreams 未命中流分支）
 *   兜底：export-renderer.ts 的 ensureIndirectPageContents()（load 后 / save 前归一化）。
 *
 * 运行：npx tsx frontend/src/document-model/export-contents-indirect.test.ts
 */

import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFRef,
  PDFRawStream,
  PDFStream,
  decodePDFRawStream,
} from "pdf-lib";
import { ensureIndirectPageContents } from "./export-renderer";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

const CONTENTS = PDFName.of("Contents");

function contentsEntries(pdf: PDFDocument, pageIndex = 0): unknown[] {
  const entry = pdf.getPage(pageIndex).node.get(CONTENTS);
  return entry instanceof PDFArray ? entry.asArray() : [entry];
}

function decodeStream(obj: unknown): string {
  return Buffer.from(decodePDFRawStream(obj as PDFRawStream).getBytes()).toString("latin1");
}

/** 2 页 PDF，每页一个间接引用的内容流 */
async function makeDoc(): Promise<PDFDocument> {
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 800]);
  pdf.addPage([600, 800]);
  pdf.getPage(0).node.set(CONTENTS, pdf.context.register(pdf.context.stream("q 1 0 0 rg Q")));
  pdf.getPage(1).node.set(CONTENTS, pdf.context.register(pdf.context.stream("q 0 1 0 rg Q")));
  return pdf;
}

async function main(): Promise<void> {
  console.log("M7.8-042-FIX -- /Contents 必须为间接引用\n");

  // -- 1. 单值 /Contents 被写成直接流对象 --
  {
    console.log("[1] 单值 /Contents 为直接流对象");
    const pdf = await makeDoc();
    const baseRef = contentsEntries(pdf, 0)[0] as PDFRef;
    // 模拟 bug：PDFContext.stream() 未 register 直接写回
    pdf.getPage(0).node.set(CONTENTS, pdf.context.stream("q 1 0 0 RG Q"));
    check("1a 修复前复现 bug：直接流对象", contentsEntries(pdf, 0)[0] instanceof PDFRawStream);
    ensureIndirectPageContents(pdf);
    const e = contentsEntries(pdf, 0)[0];
    check("1b 修复后为 PDFRef", e instanceof PDFRef);
    check("1c 修复后不再是原 baseRef（已整体替换）", (e as PDFRef).toString() !== baseRef.toString());
    const bytes = await pdf.save();
    const reloaded = await PDFDocument.load(bytes);
    const obj = reloaded.context.lookup(contentsEntries(reloaded, 0)[0] as PDFRef);
    check("1d save 后内容流字节完整", decodeStream(obj) === "q 1 0 0 RG Q", decodeStream(obj));
  }

  // -- 2. 数组 /Contents 中混有直接流对象 --
  {
    console.log("\n[2] 数组 /Contents 中间项为直接流对象");
    const pdf = await makeDoc();
    const baseRef = contentsEntries(pdf, 0)[0] as PDFRef;
    const qRef = pdf.context.register(pdf.context.stream("q"));
    pdf.getPage(0).node.set(
      CONTENTS,
      pdf.context.obj([qRef, pdf.context.stream("BT /F1 12 Tf (BROKEN) Tj ET"), baseRef]),
    );
    check("2a 修复前复现 bug：数组含直接流对象", contentsEntries(pdf, 0)[1] instanceof PDFRawStream);
    ensureIndirectPageContents(pdf);
    const arr = contentsEntries(pdf, 0);
    check(
      "2b 修复后数组全部为 PDFRef 且长度不变",
      arr.length === 3 && arr.every((x) => x instanceof PDFRef),
    );
    check(
      "2c 修复后首尾引用未被改写（顺序保持）",
      (arr[0] as PDFRef).toString() === qRef.toString() &&
        (arr[2] as PDFRef).toString() === baseRef.toString(),
    );
    const bytes = await pdf.save();
    const reloaded = await PDFDocument.load(bytes);
    const arr2 = contentsEntries(reloaded, 0);
    check(
      "2d save 后仍全为 PDFRef，中间流内容保留",
      arr2.every((x) => x instanceof PDFRef) &&
        decodeStream(reloaded.context.lookup(arr2[1] as PDFRef)).includes("BROKEN"),
    );
  }

  // -- 3. 幂等性 --
  {
    console.log("\n[3] 幂等性");
    const pdf = await makeDoc();
    pdf.getPage(0).node.set(CONTENTS, pdf.context.stream("q Q"));
    ensureIndirectPageContents(pdf);
    const first = (contentsEntries(pdf, 0)[0] as PDFRef).toString();
    ensureIndirectPageContents(pdf);
    const second = (contentsEntries(pdf, 0)[0] as PDFRef).toString();
    check("3a 重复调用不改变引用（幂等）", first === second, `${first} vs ${second}`);
    check("3b 未受影响页保持原引用", contentsEntries(pdf, 1)[0] instanceof PDFRef);
  }

  // -- 4. 结构本来就合法时不应有副作用 --
  {
    console.log("\n[4] 合法结构零副作用");
    const pdf = await makeDoc();
    const before = contentsEntries(pdf, 0)[0] as PDFRef;
    const before2 = contentsEntries(pdf, 1)[0] as PDFRef;
    ensureIndirectPageContents(pdf);
    check(
      "4a 合法的间接引用保持不变",
      (contentsEntries(pdf, 0)[0] as PDFRef).toString() === before.toString() &&
        (contentsEntries(pdf, 1)[0] as PDFRef).toString() === before2.toString(),
    );
  }

  // -- 5. 端到端：修复后的文件可被 pdf-lib 重新解析且页内容可读 --
  {
    console.log("\n[5] 端到端往返");
    const pdf = await makeDoc();
    // 让第 1 页 /Contents 变成数组 + 内联流（与用户坏文件同构）
    pdf.getPage(0).node.set(
      CONTENTS,
      pdf.context.obj([
        pdf.context.register(pdf.context.stream("q")),
        pdf.context.stream("BT /F1 12 Tf (BALANCO) Tj ET"),
      ]),
    );
    ensureIndirectPageContents(pdf);
    const bytes = await pdf.save();
    const text = Buffer.from(bytes).toString("latin1");
    // 修复后的字节流里不应出现 "/Contents [ ... stream"（内联流特征）
    check("5a 导出字节中无内联 /Contents 流", !/\/Contents\s*\[[^\]]{0,2000}?stream/.test(text));
    const reloaded = await PDFDocument.load(bytes);
    let allRef = true;
    for (let i = 0; i < reloaded.getPageCount(); i++) {
      if (!contentsEntries(reloaded, i).every((x) => x instanceof PDFRef)) allRef = false;
    }
    check("5b 重新加载后所有页 /Contents 均为间接引用", allRef);
  }

  console.log(`\n结果：${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
