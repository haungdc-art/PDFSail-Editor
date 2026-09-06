import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { resolvePageShowTextWithXObjects } from "./content-stream-resolver";
import type { EditableDocument } from "./types";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784672098938-k1smuql7x.pdf";
const _log = console.log.bind(console);
const SUPPRESS = /\[?(Sprint40-fix|Sprint34|YDIAG|M7\.8|PDFdraw|ExportLayout|WRITE_ENTRY|COORD_DIAG|DrawGlyph|NATIVE_REPLAY|009B|FIX-002|EditableDocument|ExportRenderer|DBG|SignatureRotationTrace|M7\.8-022A|NATIVE_DISABLED|M7\.8-035|M7\.8-036|M7\.8-037|provenance|Provenance|009B-2a|MASK_DIAG|FIX-002)/;
console.log = (...a: any[]) => { const s = typeof a[0] === "string" ? a[0] : ""; if (!SUPPRESS.test(s)) _log(...a); };

function short(id: string) { return id; }

async function main() {
  const bytes = fs.readFileSync(ORIG);

  // ---------- 导入侧：加载一次，钉 provenance ----------
  const impPdf = await PDFDocument.load(bytes);
  const doc = (await parsePdfToEditableDocument(bytes as unknown as ArrayBuffer, impPdf)) as EditableDocument;

  // ---------- 导出侧等价：再加载一次（exportEditableDocument 内部通常重新 load） ----------
  const expPdf = await PDFDocument.load(bytes);

  _log("============= 1) streamObjRef 空间对比（导入 pdf vs 导出 pdf） =============");
  for (const pIdx of [0, 1, 2]) {
    const rImp = resolvePageShowTextWithXObjects(impPdf, pIdx) as any[];
    const rExp = resolvePageShowTextWithXObjects(expPdf, pIdx) as any[];
    const impRefs = [...new Set(rImp.map((r) => r.streamObjRef))];
    const expRefs = [...new Set(rExp.map((r) => r.streamObjRef))];
    _log(`PAGE ${pIdx} (EditableDocument page.index=${pIdx + 1}):`);
    _log(`  导入pdf streamObjRefs = ${impRefs.join(", ")}   算子数=${rImp.length}`);
    _log(`  导出pdf streamObjRefs = ${expRefs.join(", ")}   算子数=${rExp.length}`);
    _log(`  导入pdf 样本 operatorId: ${rImp.slice(0, 4).map((r) => r.operatorId).join(", ")}`);
    _log(`  导出pdf 样本 operatorId: ${rExp.slice(0, 4).map((r) => r.operatorId).join(", ")}`);
  }

  _log("\n============= 2) Glyph provenance（EditableGlyph.operatorId） vs 导出侧 resolver operatorId =============");
  for (const pIdx of [0, 1, 2]) {
    const edPage = doc.pages[pIdx];
    const glyphIds = [...new Set(edPage.blocks.flatMap((b) => b.lines.flatMap((l) => l.glyphs)).map((g) => (g as any).operatorId))] as (string | undefined)[];
    const rExp = resolvePageShowTextWithXObjects(expPdf, pIdx) as any[];
    const expIds = new Set(rExp.map((r) => r.operatorId));
    const matched = glyphIds.filter((id) => id && expIds.has(id)).length;
    const unmatched = glyphIds.filter((id) => id && !expIds.has(id));
    _log(`PAGE ${pIdx} (EditableDocument page.index=${edPage.index}):`);
    _log(`  Glyph 去重 operatorId 数=${glyphIds.length}（含 undefined=${glyphIds.filter((x) => !x).length}）`);
    _log(`  Glyph operatorId 样本: ${glyphIds.filter(Boolean).slice(0, 6).map(short).join(", ")}`);
    _log(`  → 能在导出侧 resolver 中找到的 = ${matched} / ${glyphIds.filter(Boolean).length}`);
    _log(`  → 找不到（ID 空间错位）样本: ${unmatched.slice(0, 6).map(short).join(", ")}`);
  }

  _log("\n============= 3) charCodes === null 统计 + 安全 removal 可行性 =============");
  for (const pIdx of [0, 1, 2]) {
    const rExp = resolvePageShowTextWithXObjects(expPdf, pIdx) as any[];
    const nullCC = rExp.filter((r) => r.charCodes === null);
    _log(`PAGE ${pIdx}: 算子 ${rExp.length}，charCodes===null 数=${nullCC.length}`);
    if (nullCC.length) _log(`   样本(不可权威解码, strip 会跳过): ${nullCC.slice(0, 3).map((r) => `${r.operatorId}[${r.charCodeBasis}](${(r.unicodeText ?? "?").slice(0, 12)})`).join("; ")}`);
  }

  _log("\n============= 4) 第1页 CNPJ '79' 目标 Glyph→Operator 矩阵 =============");
  const edPage1 = doc.pages[0];
  for (const block of edPage1.blocks) {
    for (const line of block.lines) {
      const text = line.glyphs.map((g) => g.char).join("");
      if (!text.includes("0001-79")) continue;
      _log(`  line.id=${line.id} 文本="${text}"`);
      for (const g of line.glyphs) {
        const gg = g as any;
        if (["0", "0", "0", "1", "-", "7", "9"].includes(gg.char) || gg.char === "/") {
          _log(`    glyph '${gg.char}' operatorId=${gg.operatorId ?? "UNDEF"} operatorCharIndex=${gg.operatorCharIndex ?? "?" }`);
        }
      }
      // 找 resolver 中含 0001-79 的算子
      const rExp = resolvePageShowTextWithXObjects(expPdf, 0) as any[];
      const hit = rExp.find((r) => (r.unicodeText ?? "").includes("0001-79"));
      _log(`  resolver 中含 '0001-79' 的算子: ${hit ? hit.operatorId + " text=" + JSON.stringify(hit.unicodeText) : "无"}`);
    }
  }
}
main().catch((e) => { _log("ERR", e); process.exit(1); });
