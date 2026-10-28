/**
 * Unit test for find-similar.ts (M1 Find Similar → Replace All core).
 * Pure data-layer: builds a minimal mock EditableDocument, no canvas / pipeline.
 *
 * Run: node find-similar.test.ts   (Node 22.6+ strips TS types)
 * Fallback: npx esbuild find-similar.test.ts --bundle --platform=node --format=esm | node --input-type=module
 */
import { findOccurrences, replaceAllOccurrences } from './find-similar.ts';
import type { EditableDocument, EditableGlyph, EditableLine, EditableBlock } from './types.ts';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

function glyph(char: string, modified = false): EditableGlyph {
  return { char, modified };
}
function line(...chars: string[]): EditableLine {
  return { glyphs: chars.map((c) => glyph(c)) };
}
function block(id: string, ...lines: EditableLine[]): EditableBlock {
  return { id, type: 'text', lines };
}
function doc(...blocks: EditableBlock[]): EditableDocument {
  return { pages: [{ blocks }] } as EditableDocument;
}

console.log('[test] findOccurrences');

// 1. single occurrence across single-char glyphs
{
  const d = doc(block('b1', line('A', 'B', 'C', 'D')));
  const m = findOccurrences(d, 'BC');
  assert(m.length === 1, 'found 1 match for "BC"');
  assert(m[0]?.glyphStart === 1 && m[0]?.glyphEnd === 2, 'match span = glyphs [1..2]');
}

// 2. multiple occurrences on one line
{
  const d = doc(block('b1', line('A', 'B', 'C', ' ', 'A', 'B', 'C')));
  const m = findOccurrences(d, 'ABC');
  assert(m.length === 2, 'found 2 matches for "ABC"');
  assert(m[0]?.glyphStart === 0 && m[1]?.glyphStart === 4, 'matches at 0 and 4');
}

// 3. target inside a single multi-char glyph
{
  const d = doc(block('b1', line('Hello')));
  const m = findOccurrences(d, 'llo');
  assert(m.length === 1, 'found 1 match for "llo" inside "Hello"');
  assert(m[0]?.glyphStart === 0 && m[0]?.glyphEnd === 0, 'match collapsed to glyph 0');
}

// 4. across pages + ignores non-text blocks
{
  const d = {
    pages: [
      { blocks: [block('b1', line('X', 'Y', 'Z'))] },
      { blocks: [block('b2', line('X', 'Y', 'Z'))] },
      { blocks: [{ id: 'img', type: 'image', lines: [] } as EditableBlock] },
    ],
  } as EditableDocument;
  const m = findOccurrences(d, 'XYZ');
  assert(m.length === 2, 'found matches on 2 text pages only (image block skipped)');
  assert(m[0]?.pageIndex === 0 && m[1]?.pageIndex === 1, 'matches on page 0 and 1');
}

// 5. empty / no match
{
  assert(findOccurrences(doc(block('b1', line('A', 'B'))), '').length === 0, 'empty target → 0');
  assert(findOccurrences(doc(block('b1', line('A', 'B'))), 'Z').length === 0, 'no match → 0');
}

console.log('[test] replaceAllOccurrences');

// 6. replaces every occurrence, first glyph carries replacement, rest blanked
{
  const d = doc(block('b1', line('A', 'B', 'C', ' ', 'A', 'B', 'C')));
  const r = replaceAllOccurrences(d, 'ABC', 'XY');
  assert(r.matchCount === 2, 'matchCount = 2');
  assert(r.changed === true, 'changed = true');
  const g = d.pages[0].blocks[0].lines[0].glyphs;
  assert(g[0].char === 'XY' && g[0].modified === true, 'first run: glyph0 = "XY", modified');
  assert(g[1].char === '' && g[1].modified === true, 'first run: glyph1 blanked + modified');
  assert(g[2].char === '' && g[2].modified === true, 'first run: glyph2 blanked + modified');
  assert(g[4].char === 'XY' && g[5].char === '' && g[6].char === '', 'second run rewritten identically');
  // re-scan: original gone, replacement text now present (single glyph per run)
  assert(findOccurrences(d, 'ABC').length === 0, 'after replace, "ABC" gone');
  assert(findOccurrences(d, 'XY').length === 2, 'after replace, "XY" present (replacement carried by glyph0/glyph4)');
}

// 7. no target → no-op
{
  const d = doc(block('b1', line('A', 'B')));
  const r = replaceAllOccurrences(d, 'Q', 'Z');
  assert(r.matchCount === 0 && r.changed === false, 'no-op when no match');
}

console.log(failures === 0 ? '\n[test] ALL PASS' : `\n[test] ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
