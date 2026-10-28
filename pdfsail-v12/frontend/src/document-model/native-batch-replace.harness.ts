/**
 * End-to-end harness for native-batch-replace (M1-B kerning fidelity).
 * Builds a real PDF with a TJ-kerned content stream, runs applyNativeBatchReplace,
 * and asserts the rewritten content stream preserves kerning for equal-length swaps.
 *
 * Run: node native-batch-replace.harness.ts  (via esbuild bundle)
 */
import { PDFDocument, PDFName } from "pdf-lib";
import { applyNativeBatchReplace, type BatchNativeReplaceRun } from "./native-batch-replace.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

/** Build a minimal PDF whose page Contents is a custom content stream referencing /F1. */
async function buildPdf(content: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const ctx = pdf.context;
  const streamRef = ctx.register(ctx.flateStream(new TextEncoder().encode(content)));
  const fontDict = ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
  const fontRef = ctx.register(fontDict);
  page.node.set(PDFName.of("Contents"), streamRef);
  page.node.set(PDFName.of("Resources"), ctx.obj({ Font: ctx.obj({ F1: fontRef }) }));
  return pdf.save();
}

async function run() {
  console.log("[harness] applyNativeBatchReplace kerning fidelity (M1-B)");

  // Identity-H style CID codec: 2-byte hex pairs ↔ Unicode (what buildPageCidCodec yields for CID fonts)
  const codec = {
    decodeHex: (_fontRef: string, bytes: number[]): string => {
      let s = "";
      for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return s;
    },
    encodeHex: (_fontRef: string, text: string): string => {
      let h = "";
      for (const ch of text) h += ch.charCodeAt(0).toString(16).padStart(4, "0");
      return h;
    },
  };

  // --- Case 1: equal-length CJK-ish hex TJ with kerning → kerning preserved ---
  {
    const bytes = await buildPdf("BT /F1 12 Tf 100 700 Tm [<0041> -120 <0042> 30 <0043>] TJ ET");
    const doc = await PDFDocument.load(bytes);
    const run: BatchNativeReplaceRun = {
      blockId: "b1", lineIndex: 0, pageIndex: 0,
      glyphStart: 0, glyphEnd: 2,
      originalText: "ABC", replacementText: "XYZ", kind: "cid",
    };
    const res = applyNativeBatchReplace(doc, 0, [run], codec);
    assert(res.success, "case1: native batch replace succeeded");
    const out = res.streams.get(0) ?? "";
    assert(out.includes("[<0058> -120 <0059> 30 <005a>] TJ"), `case1: kerning preserved → ${out.trim()}`);
    assert(!out.includes("<0041>"), "case1: original glyphs gone");
    assert(res.targets[0]?.ready === true, "case1: target ready=true");
  }

  // --- Case 2: length-changed hex TJ → flattened (natural widths, kerning dropped) ---
  {
    const bytes = await buildPdf("BT /F1 12 Tf 100 700 Tm [<0041> -120 <0042> 30 <0043>] TJ ET");
    const doc = await PDFDocument.load(bytes);
    const run: BatchNativeReplaceRun = {
      blockId: "b2", lineIndex: 0, pageIndex: 0,
      glyphStart: 0, glyphEnd: 2,
      originalText: "ABC", replacementText: "WXYZ", kind: "cid",
    };
    const res = applyNativeBatchReplace(doc, 0, [run], codec);
    assert(res.success, "case2: length-changed replace succeeded");
    const out = res.streams.get(0) ?? "";
    assert(out.includes("[<005700580059005a>] TJ"), `case2: flattened natural-width → ${out.trim()}`);
    assert(!out.includes("-120"), "case2: kerning numbers dropped (length-changed)");
  }

  // --- Case 3: plain Tj (no kerning array) → literal swap ---
  {
    const bytes = await buildPdf("BT /F1 12 Tf 100 700 Tm (Hello) Tj ET");
    const doc = await PDFDocument.load(bytes);
    const run: BatchNativeReplaceRun = {
      blockId: "b3", lineIndex: 0, pageIndex: 0,
      glyphStart: 0, glyphEnd: 4,
      originalText: "Hello", replacementText: "Hxllo", kind: "simple",
    };
    const res = applyNativeBatchReplace(doc, 0, [run]);
    assert(res.success, "case3: Tj replace succeeded");
    const out = res.streams.get(0) ?? "";
    assert(out.includes("(Hxllo) Tj"), `case3: literal swap → ${out.trim()}`);
  }

  // --- Case 4: partial-operator match → not-found (safety, no corruption) ---
  {
    const bytes = await buildPdf("BT /F1 12 Tf 100 700 Tm (Hello World) Tj ET");
    const doc = await PDFDocument.load(bytes);
    const run: BatchNativeReplaceRun = {
      blockId: "b4", lineIndex: 0, pageIndex: 0,
      glyphStart: 0, glyphEnd: 4,
      originalText: "Hello", replacementText: "XYZ", kind: "simple", // substring of operator → not-found
    };
    const res = applyNativeBatchReplace(doc, 0, [run]);
    assert(!res.success && res.reason === "resolve-not-found", `case4: partial match rejected (${res.reason})`);
    // 安全保证：失败不写回（success=false），原算子完好无损
    const out4 = res.streams.get(0) ?? "";
    assert(out4.includes("(Hello World) Tj"), "case4: original operator intact (no partial mutation)");
  }

  console.log(failures === 0 ? "\n[harness] ALL PASS" : `\n[harness] ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
