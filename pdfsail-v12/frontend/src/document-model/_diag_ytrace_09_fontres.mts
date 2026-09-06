/**
 * @diagnostic 查明 content-stream-resolver 为何解析不到字体字典
 * 用法: npx tsx _diag_ytrace_09_fontres.mts <PDF>
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { PDFDocument, PDFName, PDFRef, PDFDict } from "pdf-lib";
import { resolvePageShowTextWithXObjects, makeFontDictResolver } from "./content-stream-resolver";

async function main() {
  const p = process.argv[2];
  if (!p || !existsSync(resolve(p))) { console.error("用法: npx tsx _diag_ytrace_09_fontres.mts <PDF>"); process.exit(2); }
  const buf = readFileSync(resolve(p));
  const doc = await PDFDocument.load(new Uint8Array(Uint8Array.from(buf).buffer), {
    ignoreEncryption: true, throwOnInvalidObject: false,
  });
  const page = doc.getPage(0) as any;

  const res = page.node.Resources?.();
  console.log("=== page 0 /Resources ===");
  console.log(`  Resources 实际类型: ${res?.constructor?.name}  toString=${String(res).slice(0, 60)}`);
  const resDict = res instanceof PDFRef ? (doc.context.lookup(res) as PDFDict) : (res as PDFDict);
  console.log(`  解析为 dict? ${resDict instanceof PDFDict}`);

  if (resDict instanceof PDFDict) {
    console.log(`  /Resources keys: [${resDict.keys().map((k) => k.asString()).join(", ")}]`);
    const fv = resDict.get(PDFName.of("Font"));
    console.log(`  /Font 原始值类型: ${fv?.constructor?.name}  toString=${String(fv).slice(0, 40)}`);
    const fd = fv instanceof PDFRef ? (doc.context.lookup(fv) as PDFDict) : (fv as PDFDict);
    console.log(`  /Font dict? ${fd instanceof PDFDict}`);
    if (fd instanceof PDFDict) {
      console.log(`  /Font keys: [${fd.keys().map((k) => k.asString()).join(", ")}]`);
      for (const [k, v] of fd.entries()) {
        const d = v instanceof PDFRef ? (doc.context.lookup(v) as PDFDict) : (v as PDFDict);
        const dd = (d as any)?.dict ?? d;
        if (dd instanceof PDFDict) {
          const sub = dd.get(PDFName.of("Subtype"))?.toString?.() ?? "?";
          const enc = dd.get(PDFName.of("Encoding"));
          console.log(`    ${k.asString().padEnd(8)} Subtype=${String(sub).padEnd(12)} Encoding=${String(enc).slice(0, 40)}`);
        }
      }
    }
  }

  console.log("\n=== content stream 里 Tf 用到的 key ===");
  const recs = resolvePageShowTextWithXObjects(doc, 0);
  const keys = [...new Set(recs.map((r) => r.fontResourceKey))];
  console.log(`  算子用到的 fontResourceKey = ${JSON.stringify(keys)}`);
  console.log(`  样本: ${recs.slice(0, 5).map((r) => `${r.op}/font=${r.fontResourceKey || "-"}/basis=${r.charCodeBasis}`).join("  ")}`);

  console.log("\n=== makeFontDictResolver 对各个 key 的解析结果 ===");
  const resolver = makeFontDictResolver(doc, resDict instanceof PDFDict ? resDict : undefined);
  for (const k of keys) {
    const d = resolver(k);
    console.log(`  key=${JSON.stringify(k)} → ${d ? `dict(Subtype=${d.get(PDFName.of("Subtype"))?.toString?.() ?? "?"})` : "undefined ❌"}`);
  }
}
main().catch((e) => { console.error("异常:", e); process.exit(1); });
