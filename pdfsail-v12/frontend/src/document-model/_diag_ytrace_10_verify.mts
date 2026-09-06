/**
 * @diagnostic M7.8-036-FIX-002 端到端验证
 *   导入 → 建立 operator provenance → 编辑 1.057,50 → 1.059,50 → 导出 → 重读 content stream
 * 验证：
 *   - provenance 已建立（glyph.operatorId 非空）
 *   - 导出后原文 "1.057,50" 从文本层消失
 *   - 新文 "1.059,50" 出现
 * 用法: npx tsx _diag_ytrace_10_verify.mts <PDF>
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { exportEditableDocument } from "./export-renderer";
import { resolvePageShowTextWithXObjects } from "./content-stream-resolver";

// Node 环境：提供 canvas/document shim 供 text-measurement 使用
(globalThis as any).document = {
  createElement(tag: string) {
    if (tag === "canvas") return createCanvas(1, 1);
    return {} as any;
  },
};

async function main() {
  const p = process.argv[2];
  if (!p || !existsSync(resolve(p))) { console.error("用法: npx tsx _diag_ytrace_10_verify.mts <PDF>"); process.exit(2); }
  const abs = resolve(p);
  const raw = readFileSync(abs);
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);

  // ── ① 导入 ──
  const doc = await parsePdfToEditableDocument(bytes, "verify.pdf");
  const page = doc.pages[0];

  // provenance 建立统计
  let total = 0, withProv = 0;
  for (const b of page.blocks) for (const l of b.lines) for (const g of l.glyphs) {
    total++; if (g.operatorId) withProv++;
  }
  console.log(`[provenance] 页0 glyph 总数=${total} 已建立 operatorId=${withProv} (${Math.round(withProv / total * 100)}%)`);

  // ── ② 编辑：定位 "1.057,50" 中的 '7'，改为 '9' ──
  let target: any = null, targetLine: any = null;
  for (const b of page.blocks) for (const l of b.lines) {
    const gs = l.glyphs;
    for (let k = 4; k < gs.length; k++) {
      if (gs[k].char === "7" && gs[k].originalChar === "7" &&
          gs[k - 4].char === "1" && gs[k - 3].char === "." && gs[k - 2].char === "0" && gs[k - 1].char === "5") {
        target = gs[k]; targetLine = l; break;
      }
    }
    if (target) break;
  }
  if (!target) { console.error("未找到 '1.057,50' 中的 '7'，退出"); process.exit(1); }
  const lineText = targetLine.glyphs.map((g: any) => g.char).join("");
  console.log(`[edit] 定位 '7'@operatorId=${target.operatorId} 原行="${lineText}"`);
  target.char = "9";
  target.modified = true;

  // 记录被改算子 id（导入期记录的）
  const editedOpId = target.operatorId;

  // ── ③ 导出 ──
  const exported = await exportEditableDocument(doc, bytes.buffer as ArrayBuffer);
  console.log(`[export] 导出字节数=${exported.length}`);

  // ── ④ 重读导出 PDF 的 content stream ──
  const pdfOut = await PDFDocument.load(new Uint8Array(exported), { ignoreEncryption: true, throwOnInvalidObject: false });
  const recs = resolvePageShowTextWithXObjects(pdfOut, 0);
  const texts = recs.map((r) => r.operatorText);
  // 原文 "1.057,50" 应完全消失（含任一碎片 "1.057" 都不该出现）
  const origCount = texts.filter((t) => t.includes("1.057,50")).length;
  const origFrag = texts.filter((t) => t.includes("1.057")).length;
  // 新文：overlay/per-glyph 渲染下 "1.059,50" 被拆成单字符算子，故检测新数字 '9' 是否出现
  const newFull = texts.filter((t) => t.includes("1.059,50")).length;
  const newDigit = texts.filter((t) => t.includes("9")).length;
  // 被改算子在导出后的 operatorText（EMPTY_SHOW_BYTES="() Tj" 解码为空串 "" 表示已剥离）
  const editedRec = recs.find((r) => r.operatorId === editedOpId);
  const editedTextNow = editedRec ? JSON.stringify(editedRec.operatorText) : "(未找到该 operatorId)";

  console.log("=".repeat(80));
  console.log(`[结果]`);
  console.log(`  原文 "1.057,50" 在文本层出现次数 = ${origCount}  (期望 0)`);
  console.log(`  原文碎片 "1.057" 出现次数 = ${origFrag}  (期望 0)`);
  console.log(`  新文整串 "1.059,50" 出现次数 = ${newFull}  (overlay 下常为 0，看 newDigit)`);
  console.log(`  新数字 '9' 出现次数 = ${newDigit}  (期望 ≥1)`);
  console.log(`  被改算子 operatorId=${editedOpId} 导出后 operatorText = ${editedTextNow}  (期望 "")`);
  const ok = origCount === 0 && origFrag === 0 && editedRec && editedRec.operatorText === "" && newDigit >= 1;
  console.log(ok ? "  ✅ 通过：原文已剥离、新文出现、无重影" : "  ❌ 未通过");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("异常:", e); process.exit(1); });
