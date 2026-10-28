/**
 * find-similar.ts — M1 killer feature core: "Select → Find Similar → Replace All".
 *
 * Scans an EditableDocument for EVERY occurrence of a target string across all
 * pages / blocks / lines — including runs split across multiple glyphs — and
 * supports batch replacement. Pure data-layer: no canvas, no export. Visual
 * fidelity of replaced runs is owned by the export pipeline (overlay redraw or
 * native rewrite); see docs/extension-scope.md §9 (native-rewrite kerning risk).
 *
 *   Original PDF → parsePdfToEditableDocument → EditableDocument
 *        ↓  findOccurrences / replaceAllOccurrences
 *   EditableDocument (modified)
 *        ↓  exportEditableDocument
 *   PDF
 */

import type { EditableDocument, EditableLine } from './types';

export interface FindMatch {
  /** page index in doc.pages */
  pageIndex: number;
  /** owning block id */
  blockId: string;
  /** line index within the block */
  lineIndex: number;
  /** first glyph index of the match (inclusive) */
  glyphStart: number;
  /** last glyph index of the match (inclusive) */
  glyphEnd: number;
  /** the matched substring (== target) */
  text: string;
}

/** char-index → owning glyph-index for a line (handles multi-char glyphs). */
function charToGlyphMap(line: EditableLine): number[] {
  const map: number[] = [];
  line.glyphs.forEach((g, gi) => {
    const len = g.char?.length ?? 0;
    for (let i = 0; i < len; i++) map.push(gi);
  });
  return map;
}

/**
 * Find all occurrences of `target` in the document.
 * Returns match locations as (page, block, line, glyph range) so callers can
 * preview / review before replacing.
 */
export function findOccurrences(doc: EditableDocument, target: string): FindMatch[] {
  const matches: FindMatch[] = [];
  if (!target) return matches;

  doc.pages.forEach((page, pi) => {
    for (const block of page.blocks) {
      if (block.type !== 'text') continue;
      block.lines.forEach((line, li) => {
        if (!line.glyphs.length) return;
        const text = line.glyphs.map((g) => g.char ?? '').join('');
        const map = charToGlyphMap(line);
        let from = 0;
        let idx: number;
        while ((idx = text.indexOf(target, from)) !== -1) {
          const glyphStart = map[idx];
          const glyphEnd = map[idx + target.length - 1];
          matches.push({
            pageIndex: pi,
            blockId: block.id,
            lineIndex: li,
            glyphStart,
            glyphEnd,
            text: target,
          });
          from = idx + target.length;
        }
      });
    }
  });

  return matches;
}

export interface BatchEditResult {
  /** number of matches replaced */
  matchCount: number;
  /** total glyph-characters touched */
  editedGlyphCount: number;
  /** whether anything changed */
  changed: boolean;
}

/**
 * Replace EVERY occurrence of `target` with `replacement`, in place.
 *
 * Matched glyph runs are rewritten so a single glyph carries `replacement` and
 * the remaining glyphs are blanked (char="") + marked modified. This gives the
 * export pipeline one source of truth per run (no duplicated/offset text).
 *
 * NOTE: layout width of a length-changed replacement is resolved by the export
 * pipeline (overlay redraw uses glyph bbox; native rewrite preserves operator
 * geometry). That fidelity work is tracked separately — this module only owns
 * the correct data mutation.
 */
export function replaceAllOccurrences(
  doc: EditableDocument,
  target: string,
  replacement: string,
): BatchEditResult {
  const matches = findOccurrences(doc, target);
  let editedGlyphCount = 0;

  for (const m of matches) {
    const block = doc.pages[m.pageIndex].blocks.find((b) => b.id === m.blockId);
    const line = block?.lines[m.lineIndex];
    if (!line) continue;

    const run = line.glyphs.slice(m.glyphStart, m.glyphEnd + 1);
    if (!run.length) continue;

    if (run[0].originalChar === undefined) run[0].originalChar = run[0].char;
    run[0].char = replacement;
    run[0].modified = true;

    for (let i = 1; i < run.length; i++) {
      if (run[i].originalChar === undefined) run[i].originalChar = run[i].char;
      run[i].char = '';
      run[i].modified = true;
    }
    editedGlyphCount += target.length;
  }

  return { matchCount: matches.length, editedGlyphCount, changed: matches.length > 0 };
}
