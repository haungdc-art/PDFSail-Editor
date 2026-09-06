import * as fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { resolvePageShowTextWithXObjects } from "./content-stream-resolver";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784672098938-k1smuql7x.pdf";
const EXP = "C:/Users/admin/Downloads/edited-edit-pdf_uploads_1784672098938-k1smuql7x.pdf (9).pdf";

function loadRecs(p: string, pageIndex: number) {
  const bytes = fs.readFileSync(p);
  const pdf = PDFDocument.load(bytes);
  return resolvePageShowTextWithXObjects(pdf, pageIndex) as any[];
}

const _log = console.log.bind(console);
// suppress noisy import logs
const SUPPRESS = /\[?(Sprint40-fix|Sprint34|YDIAG|M7\.8|PDFdraw|ExportLayout|WRITE_ENTRY|COORD_DIAG|DrawGlyph|NATIVE_REPLAY|009B|FIX-002|EditableDocument|ExportRenderer|DBG|SignatureRotationTrace|M7\.8-022A|NATIVE_DISABLED|M7\.8-035|M7\.8-036|M7\.8-037|provenance|Provenance)/;
console.log = (...a: any[]) => { const s = typeof a[0] === "string" ? a[0] : ""; if (!SUPPRESS.test(s)) _log(...a); };

try {
  const { createCanvas } = require("@napi-rs/canvas") as any;
  (globalThis as any).document = { createElement: (t: string) => (t === "canvas" ? createCanvas(1, 1) : ({ getContext: () => null } as any)) };
} catch {}

async function main() {
  const oPdf = await PDFDocument.load(fs.readFileSync(ORIG));
  const ePdf = await PDFDocument.load(fs.readFileSync(EXP));
  const oPages = oPdf.getPageCount();
  const ePages = ePdf.getPageCount();
  _log(`原始页数=${oPages} 导出页数=${ePages}`);

  for (let pg = 0; pg < Math.max(oPages, ePages); pg++) {
    const oRecs = resolvePageShowTextWithXObjects(oPdf, pg) as any[];
    const eRecs = resolvePageShowTextWithXObjects(ePdf, pg) as any[];
    _log(`\n===== PAGE ${pg} =====  origOps=${oRecs.length} expOps=${eRecs.length}`);
    const oSet = new Set(oRecs.map((r) => r.operatorText));
    const eSet = new Set(eRecs.map((r) => r.operatorText));
    // original operators whose exact text is gone from export (candidate stripped)
    const stripped = oRecs.filter((r) => !eSet.has(r.operatorText));
    // export operators whose exact text is new (candidate overlay)
    const added = eRecs.filter((r) => !oSet.has(r.operatorText));
    _log(`  [STRIPPED-LIKE] orig operator text 在导出中消失的条数=${stripped.length}`);
    for (const r of stripped.slice(0, 6)) _log(`    - "${String(r.operatorText).slice(0, 40)}" id=${r.operatorId}`);
    _log(`  [ADDED] 导出中新增的 operator 条数=${added.length}`);
    for (const r of added.slice(0, 12)) _log(`    + "${String(r.operatorText).slice(0, 40)}" id=${r.operatorId} fill?`);
    // YULM check
    const yO = oRecs.find((r) => String(r.operatorText).includes("YULM") || String(r.operatorText).includes("AUDITORIA"));
    const yE = eRecs.find((r) => String(r.operatorText).includes("YULM") || String(r.operatorText).includes("AUDITORIA"));
    if (yO) _log(`  ORIG YULM op: "${String(yO.operatorText).slice(0, 80)}" id=${yO.operatorId}`);
    if (yE) _log(`  EXP  YULM op: "${String(yE.operatorText).slice(0, 80)}" id=${yE.operatorId}`);
  }
}
main().catch((e) => { _log("ERR", e); process.exit(1); });
