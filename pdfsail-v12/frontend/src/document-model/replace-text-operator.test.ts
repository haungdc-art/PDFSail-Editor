/**
 * Unit test for composeReplacementOperator (M1-B kerning fidelity).
 * Run: node replace-text-operator.test.ts
 */
import { composeReplacementOperator } from './replace-text-operator.ts';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

console.log('[test] composeReplacementOperator kerning fidelity (M1-B)');

// 1. cid equal-length → kerning numbers preserved, glyph codes swapped
{
  const r = composeReplacementOperator('cid', 'TJ', 'XYZ', undefined, '[<0041> -120 <0042> 30 <0043>] TJ');
  assert(r.operator === '[<0058> -120 <0059> 30 <005a>] TJ', `cid equal-length preserves kerning: ${r.operator}`);
}

// 2. simple equal-length → kerning preserved, literal glyphs swapped
{
  const r = composeReplacementOperator('simple', 'TJ', 'XY', undefined, '[(A) -50 (B)] TJ');
  assert(r.operator === '[(X) -50 (Y)] TJ', `simple equal-length preserves kerning: ${r.operator}`);
}

// 3. cid length-changed → falls back to flattened single-element TJ (no kerning)
{
  const r = composeReplacementOperator('cid', 'TJ', 'WXYZ', undefined, '[<0041> -120 <0042>] TJ');
  assert(r.operator === '[<005700580059005a>] TJ', `cid length-changed flattens: ${r.operator}`);
  assert(!r.operator.includes('-120'), 'flattened TJ drops kerning numbers (length-changed)');
}

// 4. simple length-changed → flattened, no kerning
{
  const r = composeReplacementOperator('simple', 'TJ', 'WXYZ', undefined, '[(A) -50 (B)] TJ');
  assert(r.operator === '[(WXYZ)] TJ', `simple length-changed flattens: ${r.operator}`);
  assert(!r.operator.includes('-50'), 'flattened TJ drops kerning numbers');
}

// 5. no originalRaw → flattened (cannot preserve)
{
  const r = composeReplacementOperator('cid', 'TJ', 'XYZ', undefined);
  assert(r.operator === '[<00580059005a>] TJ', `no raw → flattened: ${r.operator}`);
}

// 6. Tj (no kerning array) → literal, unaffected
{
  assert(composeReplacementOperator('simple', 'Tj', 'Hi').operator === '(Hi) Tj', 'simple Tj literal');
  assert(composeReplacementOperator('cid', 'Tj', '中').operator.includes('<4e2d>'), 'cid Tj encodes CJK');
}

// 7. glyph token count != replacement length → fallback (safety, no kerning)
{
  const r = composeReplacementOperator('simple', 'TJ', 'AB', undefined, '[(A)] TJ');
  // 1 glyph token but replacement length 2 → mismatch → flatten (no kerning)
  assert(r.operator === '[(AB)] TJ', `token count mismatch → flattened: ${r.operator}`);
  assert(!r.operator.includes('-10'), 'token count mismatch → fallback (no kerning)');
}

console.log(failures === 0 ? '\n[test] ALL PASS' : `\n[test] ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
