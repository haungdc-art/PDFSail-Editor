/**
 * diag-export-bug.mjs — 诊断导出 PDF 的字符间距压缩 + 重影问题
 * 用法: node scripts/diag-export-bug.mjs <pdf路径>
 */
import { PDFDocument } from "pdf-lib";
import { readFileSync } from "node:fs";
import zlib from "node:zlib";

const path = process.argv[2];
if (!path) {
  console.error("usage: node diag-export-bug.mjs <pdf>");
  process.exit(1);
}

const bytes = readFileSync(path);
const doc = await PDFDocument.load(bytes);
const pages = doc.getPages();
console.log(`pages: ${pages.length}`);

for (let p = 0; p < pages.length; p++) {
  const page = pages[p];
  const cs = page.node.Contents();
  if (!cs) continue;
  const streams = cs.constructor.name === "PDFArray" ? cs.asArray().map((r) => doc.context.lookup(r)) : [cs];
  let text = "";
  for (const s of streams) {
    let raw = s.getContents();
    // 尝试 FlateDecode
    try {
      raw = zlib.inflateSync(Buffer.from(raw));
    } catch {
      /* 已解压 */
    }
    text += raw.toString("latin1");
  }
  console.log(`\n===== PAGE ${p + 1} content stream length: ${text.length} =====`);

  // 统计文本相关操作符
  const counts = {};
  for (const op of ["Tj", "TJ", "Td", "TD", "Tm", "Tc", "Tw", "Tz", "Ts", "Tf", "BT", "ET"]) {
    const m = text.match(new RegExp(`(?<![\\w])${op}(?![\\w])`, "g"));
    counts[op] = m ? m.length : 0;
  }
  console.log("operator counts:", JSON.stringify(counts));

  // 找包含 S9 / S30 / S33 / power 的 Tj/TJ 附近内容
  const keywords = ["S9", "S30", "S33", "power", "passes"];
  for (const kw of keywords) {
    // 直接以 latin1 搜（若字体用 Identity-H CID 编码则搜不到，改搜 hex）
    let idx = 0;
    let hits = 0;
    while (hits < 4) {
      const i = text.indexOf(kw, idx);
      if (i < 0) break;
      const start = Math.max(0, i - 260);
      const end = Math.min(text.length, i + kw.length + 120);
      console.log(`\n--- "${kw}" hit#${++hits} @${i} ---`);
      console.log(text.slice(start, end).replace(/[^\x20-\x7E\n]/g, "·"));
      idx = i + kw.length;
    }
    if (hits === 0) console.log(`\n(no latin1 hits for "${kw}" — 可能是 CID/hex 编码)`);
  }
}
