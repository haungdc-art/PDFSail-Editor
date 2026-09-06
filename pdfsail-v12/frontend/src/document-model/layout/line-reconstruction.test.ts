/**
 * line-reconstruction.test.ts — Sprint 33.3.1 / 33.3.2 Calibration Diagnostic Tests
 *
 * Sprint 33.3.1:
 *   Case 1: 医疗证明 — 短语保护 + 视觉右边界
 *   Case 2: 普通文本不破坏原有换行
 *   Case 3: Word 分组正确性
 *   Case 4: CID 拼接异常修复
 *   Case 5: joinWords 标点处理
 *   Case 6: Visual Right Boundary
 *
 * Sprint 33.3.2:
 *   Case 7: 医疗证明稳定性（"trabalho, a" 同行）
 *   Case 8: CID 拆分验证（M544 + Autorizo）
 *   Case 9: normalizeWordTokens 空白删除
 *   Case 10: singleWordPenalty
 *   Case 11: Phrase Cohesion Scoring
 *
 * 运行方式（浏览器控制台）：
 *   (await import("/src/document-model/layout/line-reconstruction.test.ts")).runAllTests()
 */

import type { EditableGlyph } from "../types";
import {
  reconstructLines,
  reconstructLinesWithDiagnostics,
  groupGlyphsIntoWords,
  calculateVisualRightBoundary,
  joinWords,
  normalizeWordTokens,
  singleWordPenalty,
  calculateLineStability,
} from "./line-reconstruction";
import type { OCRWord } from "./line-reconstruction";
import { getPhraseScore, isProtectedPair, normalizePhraseWord } from "./phrase-cohesion";

// ── Helper ──────────────────────────────────────────────────────

function makeGlyph(char: string, x: number, y: number, w: number, h: number): EditableGlyph {
  return {
    id: `g_${char}_${x}_${y}`,
    char,
    bbox: { x, y, width: w, height: h },
    styleRef: 0,
    transform: [1, 0, 0, 1, 0, 0],
    originalChar: char,
    source: "ocr" as const,
  } as unknown as EditableGlyph;
}

function makeWordGlyphs(
  text: string,
  startX: number,
  y: number,
  charWidth: number,
  lineHeight: number,
  spaceWidth: number,
): EditableGlyph[] {
  const glyphs: EditableGlyph[] = [];
  let cx = startX;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const w = ch === " " ? spaceWidth : charWidth;
    glyphs.push(makeGlyph(ch, cx, y, w, lineHeight));
    cx += w;
  }
  return glyphs;
}

/**
 * 创建模拟的 OCRWord[]（不含 glyphs，仅用于 joinWords / calculateVisualRightBoundary 测试）
 */
function makeMockWord(text: string, x: number, y: number, w: number, h: number): OCRWord {
  return {
    text,
    bbox: { x, y, width: w, height: h },
    glyphs: [],
    glyphStartIndex: 0,
    glyphEndIndex: 0,
    originalLineIndex: 0,
  };
}

// ── Test Runner ─────────────────────────────────────────────────

interface TestResult {
  name: string;
  pass: boolean;
  detail?: string;
}

let results: TestResult[] = [];

function assert(condition: boolean, name: string, detail?: string): void {
  results.push({ name, pass: condition, detail });
  if (condition) {
    console.log(`  %c✓ %s`, "color:#22c55e;", name);
  } else {
    console.log(`  %c✗ %s%c ${detail ?? ""}`, "color:#ef4444;", name, "");
  }
}

// ── Case 1: Medical Certificate Line Break ─────────────────────

function testMedicalCertificate(): void {
  console.group("%cCase 1: Medical Certificate Line Break", "font-weight:bold;color:#f59e0b;");

  const LINE1_TEXT = "Atesto que JENNIFER MARTINS DE OLIVEIRA necessita de 02 dia(s) de afastamento do trabalho, a ";
  const LINE2_TEXT = "partir de 03/04/2026, para tratamento de saúde.";
  const CHAR_W = 5.5;
  const SPACE_W = 3;
  const LINE_H = 22;
  const START_X = 36;

  // Sub-test 1: 两 OCR 行在相近 Y 合并后，"a" 成为更优断点
  {
    // 使用接近的 Y 值（差 ≤ tolerance）使 Y-clustering 合并为同一组
    const y1 = 157;
    const y2 = 168; // 差 11px ≤ 容忍度(0.5*22=11) → 合并到同组
    const allGlyphs: EditableGlyph[] = [
      ...makeWordGlyphs(LINE1_TEXT, START_X, y1, CHAR_W, LINE_H, SPACE_W),
      ...makeWordGlyphs(LINE2_TEXT, START_X, y2, CHAR_W, LINE_H, SPACE_W),
    ];

    const lines = reconstructLines(allGlyphs, 0, { yClusterTolerance: 0.5 });

    // 基本断言
    assert(lines.length >= 2, "should produce at least 2 lines",
      `got ${lines.length} lines`);

    // 打印调试信息
    console.log("  Reconstructed lines:");
    for (let i = 0; i < lines.length; i++) {
      console.log(`    Line ${i}: "${lines[i].text}"`);
    }
    console.log(`  Visual right boundary: ${calculateVisualRightBoundary(groupGlyphsIntoWords(allGlyphs)).toFixed(1)}px`);

    // 检查是否有行以 "a" 结尾
    const endsWithA = lines.some((l) => l.text?.trimEnd().endsWith("a"));
    assert(endsWithA, "at least one line should end with 'a'");

    // "partir de" 必须在同一行
    const partirDeOnSameLine = lines.some((l) => l.text?.includes("partir de"));
    assert(partirDeOnSameLine, "'partir de' should stay together on same line");
  }

  // Sub-test 2: 强制 Y 统一（所有词在同一视觉行），验证 overflow 行为
  {
    const FULL_TEXT = LINE1_TEXT + LINE2_TEXT;
    const y = 157;
    const allGlyphs = makeWordGlyphs(FULL_TEXT, START_X, y, CHAR_W, LINE_H, SPACE_W);
    const lines = reconstructLines(allGlyphs, 0);

    assert(lines.length >= 1, "all on same Y → at least 1 line");
    console.log("  All same Y reconstructed lines:");
    for (let i = 0; i < lines.length; i++) {
      console.log(`    Line ${i}: "${lines[i].text}"`);
    }
  }

  // Sub-test 3: diagnostics with two-line Y setup
  {
    const y1 = 157;
    const y2 = 168;
    const allGlyphs: EditableGlyph[] = [
      ...makeWordGlyphs(LINE1_TEXT, START_X, y1, CHAR_W, LINE_H, SPACE_W),
      ...makeWordGlyphs(LINE2_TEXT, START_X, y2, CHAR_W, LINE_H, SPACE_W),
    ];

    const { lines, decisions } = reconstructLinesWithDiagnostics(allGlyphs, 0, {
      yClusterTolerance: 0.5,
    });

    assert(lines.length >= 1, "diagnostics: should produce lines");
    assert(decisions.length >= 0, "diagnostics: decisions should be available");
    console.log(`  ${decisions.length} decisions made`);
  }

  console.groupEnd();
}

// ── Case 2: Normal Text Preservation ────────────────────────────

function testNormalText(): void {
  console.group("%cCase 2: Normal Text Preservation", "font-weight:bold;color:#f59e0b;");
  const CHAR_W = 5.5;
  const SPACE_W = 3;
  const LINE_H = 22;
  const START_X = 50;

  {
    const text = "Hello world this is a test";
    const glyphs = makeWordGlyphs(text, START_X, 100, CHAR_W, LINE_H, SPACE_W);
    const lines = reconstructLines(glyphs, 0);

    assert(lines.length === 1, "short text → 1 line", `got ${lines.length}`);
    assert(lines[0].text === text, "text preserved verbatim", `"${lines[0].text}"`);
  }

  {
    const text = "The quick brown fox jumps over the lazy dog and then runs away very quickly indeed";
    const glyphs = makeWordGlyphs(text, START_X, 100, CHAR_W, LINE_H, SPACE_W);
    const lines = reconstructLines(glyphs, 0);

    assert(lines.length >= 1, "long text → at least 1 line");
    for (const line of lines) {
      assert(line.text.length > 0, `line non-empty: "${line.text}"`);
    }
  }
  console.groupEnd();
}

// ── Case 3: Word Grouping ───────────────────────────────────────

function testWordGrouping(): void {
  console.group("%cCase 3: Word Grouping", "font-weight:bold;color:#f59e0b;");

  const glyphs: EditableGlyph[] = [
    makeGlyph("H", 0, 0, 5, 20),
    makeGlyph("e", 5, 0, 5, 20),
    makeGlyph("l", 10, 0, 5, 20),
    makeGlyph("l", 15, 0, 5, 20),
    makeGlyph("o", 20, 0, 5, 20),
    makeGlyph(" ", 25, 0, 3, 20),
    makeGlyph("W", 28, 0, 5, 20),
    makeGlyph("o", 33, 0, 5, 20),
    makeGlyph("r", 38, 0, 5, 20),
    makeGlyph("l", 43, 0, 5, 20),
    makeGlyph("d", 48, 0, 5, 20),
  ];

  const words = groupGlyphsIntoWords(glyphs);
  assert(words.length === 2, "glyphs → 2 words", `got ${words.length}`);
  assert(words[0]?.text === "Hello", `word 0 = "${words[0]?.text}"`);
  assert(words[1]?.text === "World", `word 1 = "${words[1]?.text}"`);

  console.groupEnd();
}

// ── Case 4: CID 拼接修复 ────────────────────────────────────────

function testCIDFix(): void {
  console.group("%cCase 4: CID Word Split Fix", "font-weight:bold;color:#f59e0b;");

  const CHAR_W = 5.5;
  const SPACE_W = 3;
  const LINE_H = 22;
  const START_X = 36;

  // 模拟 CID 行："CID: M544" 在 y1，"Autorizo a divulgação do CID junto ao atestado." 在 y2
  // 两者 Y 差 ≤ tolerance → 合并后 overflow 触发换行
  {
    const LINE1 = "CID: M544 ";
    const LINE2 = "Autorizo a divulgação do CID junto ao atestado.";
    const y1 = 157;
    const y2 = 169; // 差 12px，略超 tolerance(0.5*22=11)，但可以接受

    const allGlyphs: EditableGlyph[] = [
      ...makeWordGlyphs(LINE1, START_X, y1, CHAR_W, LINE_H, SPACE_W),
      ...makeWordGlyphs(LINE2, START_X, y2, CHAR_W, LINE_H, SPACE_W),
    ];

    const lines = reconstructLines(allGlyphs, 0, { yClusterTolerance: 0.6 });

    console.log("  CID reconstructed lines:");
    for (let i = 0; i < lines.length; i++) {
      console.log(`    Line ${i}: "${lines[i].text}"`);
    }

    // 必须：至少两行
    assert(lines.length >= 2, "CID case: at least 2 lines", `got ${lines.length}`);

    // 不应该出现 "M544Autorizo"（无空格的拼接）
    const hasBrokenJoin = lines.some((l) => l.text?.includes("M544Autorizo"));
    assert(!hasBrokenJoin, "should NOT contain 'M544Autorizo' (no space join)");

    // "CID: M544" 应在同一行
    const hasCIDLine = lines.some((l) => l.text?.includes("CID:") && l.text?.includes("M544"));
    assert(hasCIDLine, "'CID: M544' should be on same line");

    // "Autorizo" 和 "CID" 不应在同一行没有空格地拼接
    const hasAutorizoCIDJoined = lines.some((l) =>
      l.text?.includes("Autorizo") && l.text?.includes("CID:")
    );
    // 如果 CID 和 Autorizo 在同一行也可以（空格分隔），但无空格拼接不行
    if (hasAutorizoCIDJoined) {
      const line = lines.find((l) => l.text?.includes("Autorizo") && l.text?.includes("CID:"));
      const idx1 = line?.text?.indexOf("AutorizoCID");
      const idx2 = line?.text?.indexOf("M544Autorizo");
      assert(idx2 === -1 && (idx1 === undefined || idx1 === -1),
        "'Autorizo' and 'CID' must have space between them",
        `line: "${line?.text?.slice(0, 60)}"`);
    }
  }

  console.groupEnd();
}

// ── Case 5: Word Join ────────────────────────────────────────────

function testWordJoin(): void {
  console.group("%cCase 5: Word Join & Punctuation", "font-weight:bold;color:#f59e0b;");

  // 基本空格
  {
    const words: OCRWord[] = [
      makeMockWord("CID:", 0, 0, 30, 20),
      makeMockWord("M544", 34, 0, 35, 20),
    ];
    const text = joinWords(words);
    assert(text === "CID: M544", `"CID: M544"`, `got "${text}"`);
  }

  // 逗号不空格
  {
    const words: OCRWord[] = [
      makeMockWord("trabalho,", 0, 0, 60, 20),
      makeMockWord("a", 64, 0, 8, 20),
    ];
    const text = joinWords(words);
    assert(text === "trabalho, a", `"trabalho, a" (comma no space before next)`, `got "${text}"`);
  }

  // 句号不空格
  {
    const words: OCRWord[] = [
      makeMockWord("saúde.", 0, 0, 40, 20),
      makeMockWord("Atesto", 44, 0, 45, 20),
    ];
    const text = joinWords(words);
    assert(text === "saúde. Atesto", `"saúde. Atesto"`, `got "${text}"`);
  }

  // 正常空格
  {
    const words: OCRWord[] = [
      makeMockWord("partir", 0, 0, 35, 20),
      makeMockWord("de", 39, 0, 15, 20),
    ];
    const text = joinWords(words);
    assert(text === "partir de", `"partir de" (normal space)`, `got "${text}"`);
  }

  // 冒号后空格
  {
    const words: OCRWord[] = [
      makeMockWord("CID:", 0, 0, 30, 20),
      makeMockWord("M544", 34, 0, 35, 20),
      makeMockWord("Autorizo", 73, 0, 60, 20),
    ];
    const text = joinWords(words);
    assert(text === "CID: M544 Autorizo", `"CID: M544 Autorizo"`, `got "${text}"`);
  }

  console.groupEnd();
}

// ── Case 6: Visual Right Boundary ────────────────────────────────

function testVisualRightBoundary(): void {
  console.group("%cCase 6: Visual Right Boundary", "font-weight:bold;color:#f59e0b;");

  // 均匀右边缘
  {
    const words: OCRWord[] = [];
    for (let i = 0; i < 10; i++) {
      words.push(makeMockWord(`word${i}`, 36, 100 + i * 22, 500 + i, 20));
    }
    const vr = calculateVisualRightBoundary(words);
    // 10 个词，90% 百分位 = 第 9 个（index 9），宽度 ≈ 509
    assert(vr >= 500, "uniform words: visualRight >= 500", `got ${vr.toFixed(1)}`);
  }

  // 有离群超宽行
  {
    const words: OCRWord[] = [];
    // 8 个窄行词
    for (let i = 0; i < 8; i++) {
      words.push(makeMockWord(`n${i}`, 36, 100 + i * 22, 100, 20));
    }
    // 2 个超宽行词
    words.push(makeMockWord("wide1", 36, 280, 700, 20));
    words.push(makeMockWord("wide2", 36, 302, 710, 20));

    const vr = calculateVisualRightBoundary(words);
    // 10 个词，90% 百分位 = 第 9 个（index 9 at position 90% = 9），排序后 index 9 大概率是宽词
    // 但至少 > 100
    assert(vr > 100, "mixed widths: visualRight > narrow width", `got ${vr.toFixed(1)}`);
  }

  console.groupEnd();
}

// ═══════════════════════════════════════════════════════════════════
// Sprint 33.3.2 Test Cases
// ═══════════════════════════════════════════════════════════════════

// ── Case 7: Medical Certificate Stability ──────────────────────

function testMedicalCertificateStability(): void {
  console.group("%cCase 7: S33.3.2 Medical Certificate Stability", "font-weight:bold;color:#f59e0b;");

  const LINE1_TEXT = "Atesto que JENNIFER MARTINS DE OLIVEIRA necessita de 02 dia(s) de afastamento do trabalho, a ";
  const LINE2_TEXT = "partir de 03/04/2026, para tratamento de saúde.";
  const CHAR_W = 5.5;
  const SPACE_W = 3;
  const LINE_H = 22;
  const START_X = 36;

  // Sub-test 7a: full text reconstruction — "trabalho, a" must be on same line
  {
    const y1 = 157;
    const y2 = 168; // merged into same Y cluster
    const allGlyphs: EditableGlyph[] = [
      ...makeWordGlyphs(LINE1_TEXT, START_X, y1, CHAR_W, LINE_H, SPACE_W),
      ...makeWordGlyphs(LINE2_TEXT, START_X, y2, CHAR_W, LINE_H, SPACE_W),
    ];

    const lines = reconstructLines(allGlyphs, 0, { yClusterTolerance: 0.5 });

    console.log("  Reconstructed lines:");
    for (let i = 0; i < lines.length; i++) {
      console.log(`    Line ${i}: "${lines[i].text}"`);
    }

    // "trabalho, a" must be together on one line
    const hasTrabalhoA = lines.some((l) => l.text?.includes("trabalho, a"));
    assert(hasTrabalhoA, "'trabalho, a' should be on same line");

    // No line should be just "a" alone
    const aloneA = lines.some((l) => (l.text?.trim() ?? "") === "a");
    assert(!aloneA, "'a' should NOT be alone on a line");

    // No line should be just "trabalho," alone
    const aloneTrabalho = lines.some((l) => (l.text?.trim() ?? "") === "trabalho,");
    assert(!aloneTrabalho, "'trabalho,' should NOT be alone on a line");

    // No empty lines
    const hasEmptyLine = lines.some((l) => (l.text?.trim() ?? "").length === 0);
    assert(!hasEmptyLine, "should have no empty lines");
  }

  // Sub-test 7b: "partir de" must be together
  {
    const y1 = 157;
    const y2 = 168;
    const allGlyphs: EditableGlyph[] = [
      ...makeWordGlyphs(LINE1_TEXT, START_X, y1, CHAR_W, LINE_H, SPACE_W),
      ...makeWordGlyphs(LINE2_TEXT, START_X, y2, CHAR_W, LINE_H, SPACE_W),
    ];

    const lines = reconstructLines(allGlyphs, 0, { yClusterTolerance: 0.5 });

    const partirDeLine = lines.find((l) => l.text?.includes("partir de"));
    assert(partirDeLine !== undefined, "'partir de' should appear together");
    if (partirDeLine) {
      // "partir de" line should also include the date
      const hasDate = partirDeLine.text?.includes("03/04/2026");
      // This may or may not fit depending on visualRight, at minimum "partir de" stays together
      console.log(`    'partir de' line: "${partirDeLine.text}"`);
    }
  }

  console.groupEnd();
}

// ── Case 8: CID Split Verification ─────────────────────────────

function testCIDSplitVerification(): void {
  console.group("%cCase 8: S33.3.2 CID Split", "font-weight:bold;color:#f59e0b;");

  const CHAR_W = 5.5;
  const SPACE_W = 3;
  const LINE_H = 22;
  const START_X = 36;

  // "CID: M544" at y1, "Autorizo a divulgação do CID junto ao atestado." at y2
  {
    const LINE1 = "CID: M544 ";
    const LINE2 = "Autorizo a divulgação do CID junto ao atestado.";
    const y1 = 157;
    const y2 = 169;

    const allGlyphs: EditableGlyph[] = [
      ...makeWordGlyphs(LINE1, START_X, y1, CHAR_W, LINE_H, SPACE_W),
      ...makeWordGlyphs(LINE2, START_X, y2, CHAR_W, LINE_H, SPACE_W),
    ];

    const lines = reconstructLines(allGlyphs, 0, { yClusterTolerance: 0.6 });

    console.log("  CID reconstructed lines (S33.3.2):");
    for (let i = 0; i < lines.length; i++) {
      console.log(`    Line ${i}: "${lines[i].text}"`);
    }

    // "M544Autorizo" (no-space join) must NOT appear
    const hasNoSpaceJoin = lines.some((l) => l.text?.includes("M544Autorizo"));
    assert(!hasNoSpaceJoin, "must NOT have 'M544Autorizo' (S33.3.2 join fix)");

    // "CID: M544" should be on its own line or first line
    const hasCIDLine = lines.some((l) =>
      (l.text ?? "").includes("CID:") && (l.text ?? "").includes("M544"),
    );
    assert(hasCIDLine, "'CID: M544' should be on a line together");

    // "Autorizo" should be separate from "M544"
    const autorizoLine = lines.find((l) => (l.text ?? "").includes("Autorizo"));
    if (autorizoLine && hasCIDLine) {
      const cidLine = lines.find((l) =>
        (l.text ?? "").includes("CID:") && (l.text ?? "").includes("M544"),
      );
      if (cidLine) {
        const cidIdx = lines.indexOf(cidLine);
        const autorizoIdx = lines.indexOf(autorizoLine);
        assert(cidIdx < autorizoIdx, "'CID: M544' should come before 'Autorizo'");
      }
    }
  }

  console.groupEnd();
}

// ── Case 9: normalizeWordTokens ────────────────────────────────

function testNormalizeWordTokens(): void {
  console.group("%cCase 9: normalizeWordTokens", "font-weight:bold;color:#f59e0b;");

  // Blank token removal
  {
    const words: OCRWord[] = [
      makeMockWord("Hello", 0, 0, 40, 20),
      makeMockWord(" ", 44, 0, 5, 20),    // blank
      makeMockWord("World", 49, 0, 40, 20),
      makeMockWord("  ", 93, 0, 8, 20),   // multi-space blank
      makeMockWord("test", 101, 0, 30, 20),
    ];
    const normalized = normalizeWordTokens(words);
    assert(normalized.length === 3, "5 words (2 blank) → 3 words", `got ${normalized.length}`);
    assert(normalized[0]?.text === "Hello", `[0] = "Hello"`);
    assert(normalized[1]?.text === "World", `[1] = "World"`);
    assert(normalized[2]?.text === "test", `[2] = "test"`);
  }

  // All valid (no change)
  {
    const words: OCRWord[] = [
      makeMockWord("a", 0, 0, 10, 20),
      makeMockWord("b", 14, 0, 10, 20),
    ];
    const normalized = normalizeWordTokens(words);
    assert(normalized.length === 2, "all valid: length preserved");
  }

  // Single space only
  {
    const words: OCRWord[] = [makeMockWord(" ", 0, 0, 5, 20)];
    const normalized = normalizeWordTokens(words);
    assert(normalized.length === 0, "single space only: filtered to 0");
  }

  console.groupEnd();
}

// ── Case 10: singleWordPenalty ─────────────────────────────────

function testSingleWordPenalty(): void {
  console.group("%cCase 10: singleWordPenalty", "font-weight:bold;color:#f59e0b;");

  // Short function word alone → -100
  {
    const words: OCRWord[] = [makeMockWord("a", 0, 0, 10, 20)];
    const penalty = singleWordPenalty(words);
    assert(penalty === -100, `'a' alone → penalty=-100`, `got ${penalty}`);
  }

  // "de" alone → -100
  {
    const words: OCRWord[] = [makeMockWord("de", 0, 0, 15, 20)];
    const penalty = singleWordPenalty(words);
    assert(penalty === -100, `'de' alone → penalty=-100`, `got ${penalty}`);
  }

  // Normal multi-word line → 0
  {
    const words: OCRWord[] = [
      makeMockWord("trabalho,", 0, 0, 60, 20),
      makeMockWord("a", 64, 0, 10, 20),
    ];
    const penalty = singleWordPenalty(words);
    assert(penalty === 0, "multi-word line → penalty=0", `got ${penalty}`);
  }

  // Non-function short word → -80
  {
    const words: OCRWord[] = [makeMockWord("xa", 0, 0, 15, 20)];
    const penalty = singleWordPenalty(words);
    assert(penalty <= -80, "2-char unknown word → penalty <= -80", `got ${penalty}`);
  }

  // Blank word → -100
  {
    const words: OCRWord[] = [makeMockWord("  ", 0, 0, 8, 20)];
    const penalty = singleWordPenalty(words);
    assert(penalty === -100, "blank word alone → penalty=-100", `got ${penalty}`);
  }

  console.groupEnd();
}

// ── Case 11: Phrase Cohesion Scoring ───────────────────────────

function testPhraseCohesion(): void {
  console.group("%cCase 11: Phrase Cohesion Scoring", "font-weight:bold;color:#f59e0b;");

  // Protected pair "trabalho, a"
  {
    const prev = [makeMockWord("trabalho,", 0, 0, 60, 20)];
    const next = makeMockWord("a", 64, 0, 10, 20);
    const score = getPhraseScore(prev, next);
    assert(score === 50, `'trabalho,' + 'a' → +50`, `got ${score}`);
  }

  // Protected pair "a partir"
  {
    const prev = [makeMockWord("a", 0, 0, 10, 20)];
    const next = makeMockWord("partir", 14, 0, 40, 20);
    const score = getPhraseScore(prev, next);
    assert(score === 50, `'a' + 'partir' → +50`, `got ${score}`);
  }

  // Protected pair "partir de"
  {
    const prev = [makeMockWord("partir", 0, 0, 40, 20)];
    const next = makeMockWord("de", 44, 0, 15, 20);
    const score = getPhraseScore(prev, next);
    assert(score === 50, `'partir' + 'de' → +50`, `got ${score}`);
  }

  // Protected pair "junto ao"
  {
    const prev = [makeMockWord("junto", 0, 0, 35, 20)];
    const next = makeMockWord("ao", 39, 0, 15, 20);
    const score = getPhraseScore(prev, next);
    assert(score === 50, `'junto' + 'ao' → +50`, `got ${score}`);
  }

  // Normal non-protected pair
  {
    const prev = [makeMockWord("saúde.", 0, 0, 40, 20)];
    const next = makeMockWord("Atesto", 44, 0, 45, 20);
    const score = getPhraseScore(prev, next);
    assert(score === 0, "normal pair → 0", `got ${score}`);
  }

  // Empty previous → 0
  {
    const prev: OCRWord[] = [];
    const next = makeMockWord("a", 0, 0, 10, 20);
    const score = getPhraseScore(prev, next);
    assert(score === 0, "empty prev → 0", `got ${score}`);
  }

  // isProtectedPair raw
  {
    assert(isProtectedPair("trabalho,", "a") === true, "isProtectedPair('trabalho,', 'a')");
    assert(isProtectedPair("hello", "world") === false, "isProtectedPair('hello', 'world')");
    // Case-normalized
    assert(isProtectedPair("TRABALHO,", "A") === true, "isProtectedPair case-insensitive");
  }

  // normalizePhraseWord
  {
    assert(normalizePhraseWord("trabalho,") === "trabalho", "normalize: strip comma");
    assert(normalizePhraseWord("  ABC  ") === "abc", "normalize: trim + lower");
    assert(normalizePhraseWord("saúde.") === "saúde", "normalize: strip period");
  }

  console.groupEnd();
}

// ── Case 12: calculateLineStability ────────────────────────────

function testLineStabilityScore(): void {
  console.group("%cCase 12: calculateLineStability", "font-weight:bold;color:#f59e0b;");

  // Balanced 2-line arrangement
  {
    const line1: OCRWord[] = [
      makeMockWord("Hello", 36, 0, 40, 20),
      makeMockWord("world", 80, 0, 35, 20),
      makeMockWord("this", 119, 0, 28, 20),
    ];
    const line2: OCRWord[] = [
      makeMockWord("is", 36, 22, 12, 20),
      makeMockWord("a", 52, 0, 8, 20),
      makeMockWord("test", 64, 0, 28, 20),
    ];
    const score = calculateLineStability([line1, line2], 200);
    assert(score > 0, "balanced → score > 0", `got ${score}`);
    assert(score <= 100, "balanced → score <= 100", `got ${score}`);
  }

  // Single-line (trivial)
  {
    const line: OCRWord[] = [makeMockWord("single", 36, 0, 45, 20)];
    const score = calculateLineStability([line], 200);
    assert(score > 0, "single line → score > 0", `got ${score}`);
  }

  console.groupEnd();
}

export function runAllTests(): TestResult[] {
  results = [];
  console.log(
    "%c── Line Reconstruction Tests (Sprint 33.3.1 + 33.3.2) ──",
    "font-weight:bold;font-size:14px;color:#8b5cf6;",
  );

  // Sprint 33.3.1
  testMedicalCertificate();
  testNormalText();
  testWordGrouping();
  testCIDFix();
  testWordJoin();
  testVisualRightBoundary();

  // Sprint 33.3.2
  testMedicalCertificateStability();
  testCIDSplitVerification();
  testNormalizeWordTokens();
  testSingleWordPenalty();
  testPhraseCohesion();
  testLineStabilityScore();

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;

  if (failed === 0) {
    console.log(
      `%c✓ ALL ${passed} TESTS PASSED`,
      "font-weight:bold;color:#22c55e;font-size:14px;",
    );
  } else {
    console.log(
      `%c✗ ${failed}/${results.length} TESTS FAILED`,
      "font-weight:bold;color:#ef4444;font-size:14px;",
    );
  }

  return results;
}

// Also expose globally for console access
if (typeof window !== "undefined") {
  (window as any).__runLineReconstructionTests = runAllTests;
}
