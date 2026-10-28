/**
 * Unit test for buildNativeExportPlan (M1-B · length-changed native enable).
 * Run: node native-export-policy.test.ts (via esbuild bundle)
 */
import { buildNativeExportPlan } from "./native-export-policy.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// 最小可路由 doc：一行 3 glyph，全部 native-ready + 单 binding，originalText≠replacementText（长度变化）
const doc: any = {
  pages: [
    {
      height: 792,
      blocks: [
        {
          type: "text",
          id: "b1",
          lines: [
            {
              edited: false,
              glyphs: [
                { nativeReplacementState: { ready: true, bindingId: "bn", originalText: "ABC", replacementText: "WXYZ" } },
                { nativeReplacementState: { ready: true, bindingId: "bn", originalText: "ABC", replacementText: "WXYZ" } },
                { nativeReplacementState: { ready: true, bindingId: "bn", originalText: "ABC", replacementText: "WXYZ" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

console.log("[test] buildNativeExportPlan (M1-B length-changed native)");

const plan = buildNativeExportPlan(doc);
assert(plan.runs.length === 1, `length-changed line produces 1 native run (got ${plan.runs.length})`);
if (plan.runs.length === 1) {
  const r = plan.runs[0];
  assert(r.originalText === "ABC", `run.originalText === "ABC" (${r.originalText})`);
  assert(r.replacementText === "WXYZ", `run.replacementText === "WXYZ" (${r.replacementText})`);
}

// 对照：缺 binding originalText → 仍回退 overlay（0 run）
const docNoBinding: any = {
  pages: [
    {
      height: 792,
      blocks: [
        {
          type: "text",
          id: "b2",
          lines: [
            {
              edited: false,
              glyphs: [
                { nativeReplacementState: { ready: false, bindingId: "bn", originalText: "ABC", replacementText: "WXYZ" } },
                { nativeReplacementState: { ready: false, bindingId: "bn", originalText: "ABC", replacementText: "WXYZ" } },
                { nativeReplacementState: { ready: false, bindingId: "bn", originalText: "ABC", replacementText: "WXYZ" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};
const plan2 = buildNativeExportPlan(docNoBinding);
assert(plan2.runs.length === 0, `not-ready line → 0 native run (overlay fallback) (got ${plan2.runs.length})`);

console.log(failures === 0 ? "\n[test] ALL PASS" : `\n[test] ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
