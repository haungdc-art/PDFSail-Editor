/**
 * OCR Word Level Line Reconstruction — Sprint 33.3 / 33.3.1 / 33.3.2
 *
 * Sprint 33.3.1 核心校准（从"OCR 排版"→ "Adobe 视觉重建"）：
 *   1. OCR line 边界降级为 softHint（不再是 hardBoundary）
 *   2. 视觉右边界由 word projection density 计算（不用 paragraph bbox）
 *   3. 候选打分制：visualWidthWeight + whitespaceWeight + phraseWeight + originalLinePenalty
 *   4. 葡萄牙语短语保护（"partir de"/"de abril"/"do trabalho"/"junto ao"）
 *   5. Word join 修正（标点去空格）
 *
 * Sprint 33.3.2 过度拆分修复（从"数学换行"→ "文档视觉换行"）：
 *   6. normalizeWordTokens() — 删除空白 token
 *   7. Phrase Cohesion Engine — 短语内聚评分（getPhraseScore）
 *   8. singleWordPenalty() — 禁止孤立短词
 *   9. calculateLineStability() — 全新综合评分（width + phrase + balance + originalOCR）
 *   10. mergeShortLines() — 短行合并回退机制
 */

import type { EditableGlyph, BBox } from "../types";
import { getPhraseScore, isProtectedPair } from "./phrase-cohesion";

// ── Public Types ────────────────────────────────────────────────

export interface OCRWord {
  /** 词表面文本（不含空格） */
  text: string;
  /** 词的 CSS 包围盒 */
  bbox: BBox;
  /** 组成该词的所有 glyph */
  glyphs: EditableGlyph[];
  /** 在原始 glyph 数组中的起始下标（用于诊断） */
  glyphStartIndex: number;
  glyphEndIndex: number;
  /** 原始 OCR line 在 block 内的下标（用于诊断 original OCR lines） */
  originalLineIndex: number;
}

export interface ReconstructedLine {
  /** 该行的所有词 */
  words: OCRWord[];
  /** 连接后的文本（使用 joinWords 规则） */
  text: string;
  /** 行的 CSS 包围盒 */
  bbox: BBox;
  /** 各行内词的原始 glyph 范围（用于回溯 EditableGlyph） */
  glyphStartIndex: number;
  glyphEndIndex: number;
  /** 该行在段落内的行号 */
  lineIndex: number;
}

export interface LineReconstructionOptions {
  /** 溢出权重因子（越大越敏感，默认 2.0） */
  overflowPenalty?: number;
  /** 语义断裂惩罚因子（默认 0.6） */
  semanticBreakPenalty?: number;
  /** Y 聚类容忍度（默认 0.5——半行高以内的 Y 偏移视为同一行） */
  yClusterTolerance?: number;
}

/**
 * Sprint 33.3.1 / 33.3.2: 行候选打分权重配置
 *
 * - originalLinePenalty: OCR 原始行的匹配奖励（仅做 softHint，S33.3.2 降为 0.10）
 * - visualWidthWeight: 视觉行宽契合度（S33.3.2: 0.35）
 * - whitespaceWeight: 空白分布质量（S33.3.2 并入 balance/phrase，置 0）
 * - phraseWeight: 短语保护得分（S33.3.2: 0.35）
 * - balanceWeight: 行平衡得分（S33.3.2 新增: 0.20）
 */
export interface LineScoreConfig {
  originalLinePenalty: number;
  visualWidthWeight: number;
  whitespaceWeight: number;
  phraseWeight: number;
  balanceWeight: number;
}

/** Sprint 33.3.2 新权重: width(0.35) + phrase(0.35) + balance(0.20) + originalOCR(0.10) */
export const DEFAULT_LINE_SCORE: LineScoreConfig = {
  originalLinePenalty: 0.10,
  visualWidthWeight: 0.35,
  whitespaceWeight: 0.0,
  phraseWeight: 0.35,
  balanceWeight: 0.20,
};

export interface LineReconstructionResult {
  /** 重建后的行 */
  lines: ReconstructedLine[];
  /** 原始 OCR 行（从 glyph.originalLineIndex 分组） */
  originalOCRLines: string[];
  /** 逐词决策日志 */
  decisions: LineReconstructionDecision[];
}

export interface LineReconstructionDecision {
  word: string;
  /** true = 该词被移动到下一行（与 OCR 原始行边界不同） */
  moved: boolean;
  /** 决策理由 */
  reason: string;
}

/**
 * Sprint 33.3.1: 断点候选（用于打分）
 */
export interface BreakCandidate {
  /** 拆分位置：leftWords = currentLineWords[0..splitIdx)，rightWords = currentLineWords[splitIdx..] */
  splitIdx: number;
  /** 该候选的综合得分 */
  score: number;
  /** 得分明细（诊断用） */
  reasons: string[];
  /** 各维度得分 */
  visualWidthScore: number;
  whitespaceScore: number;
  phraseScore: number;
  ocrBoundaryScore: number;
}

/**
 * Sprint 33.3.1: 行打分 debug 入口
 */
export interface LineScoreDebugEntry {
  paragraphId: string;
  candidateDecisions: Array<{
    candidates: Array<{
      text: string;
      score: number;
      reasons: string[];
    }>;
    selected: string;
  }>;
}

// ── Constants ───────────────────────────────────────────────────

/** 葡萄牙语介词/连词（优先断行位置） */
const PT_PREPOSITIONS = new Set([
  "a", "de", "do", "da", "dos", "das",
  "para", "por", "com", "em", "no", "na",
  "nos", "nas", "ao", "à", "pelo", "pela",
  "e", "ou", "que",
]);

/** Sprint 33.3.2: 短虚词集合——不应单独成行 */
const SHORT_FUNCTION_WORDS = new Set([
  "a", "de", "do", "da", "dos", "das",
  "e", "ou", "que", "em", "no", "na",
  "ao", "à", "com", "por", "para",
  "se", "mas", "nem",
]);

function isShortFunctionWord(text: string): boolean {
  return SHORT_FUNCTION_WORDS.has(text.toLowerCase());
}

/**
 * Sprint 33.3.1: 葡萄牙语保护短语（不可在内部拆分）
 *
 * 规则举例：
 *   "partir de"    → 不可拆 "partir | de"
 *   "de abril"     → 不可拆 "de | abril"
 *   "do trabalho"  → 不可拆 "do | trabalho"
 *   "junto ao"     → 不可拆 "junto | ao"
 *
 * 注意：不再把 "a partir" 标记为 keep-together，
 * 允许在 "a" 之后断开以满足 "a | partir de" 的自然换行需求。
 */
const PT_KEEP_TOGETHER = new Map<string, string[]>([
  ["partir", ["de"]],
  ["de", ["abril"]],
  ["do", ["trabalho"]],
  ["junto", ["ao"]],
  ["de", ["acordo"]],
  ["em", ["vez"]],
  ["a", ["fim"]],
]);

/**
 * 检查两个连续词是否构成不可拆分短语。
 * @param wordText 当前词文本（已小写、已清理尾部标点）
 * @param nextWordText 下一词文本（已小写、已清理尾部标点，可为空）
 */
function isKeepTogether(wordText: string, nextWordText: string): boolean {
  const followers = PT_KEEP_TOGETHER.get(wordText);
  if (followers && nextWordText && followers.includes(nextWordText)) return true;
  return false;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Sprint 33.3.1 / 33.3.2: 核心入口，使用视觉右边界 + 候选打分 + 短语内聚 + 短行合并。
 *
 * 使用场景：
 *   const visualRight = calculateVisualRightBoundary(words);
 *   const result = reconstructLines(allGlyphs, 0, { yClusterTolerance: 0.5 });
 */
export function reconstructLines(
  glyphs: EditableGlyph[],
  _unusedRight: number, // 保留参数兼容，实际使用 visualRight
  options: LineReconstructionOptions = {},
): ReconstructedLine[] {
  const {
    yClusterTolerance = 0.5,
  } = options;

  // 1) Glyph → Word（按空格分组）
  const rawWords = groupGlyphsIntoWords(glyphs);
  // Sprint 33.3.2: 删除空白 token
  const words = normalizeWordTokens(rawWords);
  if (words.length === 0) return [];

  // Sprint 33.3.1: 计算视觉右边界（word projection density）
  const visualRight = calculateVisualRightBoundary(words);

  // 2) Y 聚类得到视觉候选行
  const visualLineGroups = yClusterWords(words, yClusterTolerance);

  // 3) 对每个视觉行做候选打分断行 + Sprint 33.3.2 短行合并
  const resultLines: ReconstructedLine[] = [];
  let lineIndex = 0;
  for (const vLineWords of visualLineGroups) {
    const splits = splitOverflowLinesByScore(vLineWords, visualRight, DEFAULT_LINE_SCORE);
    // Sprint 33.3.2: 后处理短行合并
    const mergedSplits = mergeShortLines(splits, visualRight);
    for (const splitWords of mergedSplits) {
      resultLines.push(buildLine(splitWords, lineIndex));
      lineIndex++;
    }
  }

  return resultLines;
}

/**
 * Sprint 33.3.1 / 33.3.2: 带 diagnostic 信息的重建入口。
 */
export function reconstructLinesWithDiagnostics(
  glyphs: EditableGlyph[],
  _unusedRight: number,
  options: LineReconstructionOptions = {},
): LineReconstructionResult {
  const {
    yClusterTolerance = 0.5,
  } = options;

  const rawWords = groupGlyphsIntoWords(glyphs);
  // Sprint 33.3.2: 删除空白 token
  const words = normalizeWordTokens(rawWords);
  if (words.length === 0) return { lines: [], originalOCRLines: [], decisions: [] };

  // 原始 OCR 行（按 originalLineIndex 分组）
  const originalOCRLines = groupOriginalOCRLines(words);

  // Sprint 33.3.1: 视觉右边界
  const visualRight = calculateVisualRightBoundary(words);

  const decisions: LineReconstructionDecision[] = [];

  const visualLineGroups = yClusterWords(words, yClusterTolerance);

  const resultLines: ReconstructedLine[] = [];
  let lineIndex = 0;
  for (const vLineWords of visualLineGroups) {
    const splits = splitOverflowLinesByScoreWithDiagnostics(
      vLineWords,
      visualRight,
      DEFAULT_LINE_SCORE,
      decisions,
    );
    // Sprint 33.3.2: 后处理短行合并
    const mergedSplits = mergeShortLines(splits, visualRight);
    for (const splitWords of mergedSplits) {
      resultLines.push(buildLine(splitWords, lineIndex));
      lineIndex++;
    }
  }

  return { lines: resultLines, originalOCRLines, decisions };
}

// ── Step 1: Glyph → Word ───────────────────────────────────────

export function groupGlyphsIntoWords(glyphs: EditableGlyph[]): OCRWord[] {
  const words: OCRWord[] = [];
  let currentGlyphs: EditableGlyph[] = [];
  let glyphStart = 0;

  const flushWord = (lineIdx: number) => {
    if (currentGlyphs.length === 0) return;
    const xs = currentGlyphs.map((g) => g.bbox.x);
    const ys = currentGlyphs.map((g) => g.bbox.y);
    const rights = currentGlyphs.map((g) => g.bbox.x + g.bbox.width);
    const bottoms = currentGlyphs.map((g) => g.bbox.y + g.bbox.height);

    words.push({
      text: currentGlyphs.map((g) => g.char).join(""),
      bbox: {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...rights) - Math.min(...xs),
        height: Math.max(...bottoms) - Math.min(...ys),
      },
      glyphs: [...currentGlyphs],
      glyphStartIndex: glyphStart - currentGlyphs.length,
      glyphEndIndex: glyphStart,
      originalLineIndex: lineIdx,
    });
    currentGlyphs = [];
  };

  // 按原始 OCR line 分组，保持 reading order
  const linesMap = new Map<number, EditableGlyph[]>();
  for (const g of glyphs) {
    // 使用 glyph.styleRef 的变通：无法直接获取 lineIndex → 存储时不分组
    // 用 _lineIdx 元数据字段（暂无），改用 Y-clustering
    linesMap.set(0, [...(linesMap.get(0) ?? []), g]);
  }

  for (const [lineIdx, lineGlyphs] of linesMap) {
    for (const g of lineGlyphs) {
      if (g.char === " ") {
        flushWord(lineIdx);
        currentGlyphs.push(g);
        glyphStart++;
        flushWord(lineIdx);
        continue;
      }
      currentGlyphs.push(g);
      glyphStart++;
    }
    flushWord(lineIdx);
  }

  return words;
}

// ── Sprint 33.3.2: Normalize Word Tokens ───────────────────────

/**
 * 删除空白 / 空 token，确保不会生成空行。
 *
 * 规则：
 *   - text 全空白（trim() === ""）→ 丢弃
 *   - 保留所有非空白词
 */
export function normalizeWordTokens(words: OCRWord[]): OCRWord[] {
  return words.filter((w) => w.text.trim().length > 0);
}

// ── Step 2: Y 聚类 ─────────────────────────────────────────────

function yClusterWords(words: OCRWord[], tolerance: number): OCRWord[][] {
  if (words.length === 0) return [];

  // 按 (y, x) 双键排序：从上到下，从左到右
  const sorted = [...words].sort((a, b) => {
    const dy = a.bbox.y - b.bbox.y;
    if (Math.abs(dy) > tolerance) return dy;
    return a.bbox.x - b.bbox.x;
  });

  // 计算平均行高（用于动态 tolerance）
  const avgHeight = words.reduce((s, w) => s + w.bbox.height, 0) / words.length;

  const groups: OCRWord[][] = [];
  let currentGroup: OCRWord[] = [sorted[0]];
  let groupMinY = sorted[0].bbox.y;

  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i];
    const centerY = w.bbox.y + w.bbox.height / 2;
    const groupCenterY = groupMinY + currentGroup[0].bbox.height / 2;
    const dy = Math.abs(centerY - groupCenterY);

    if (dy <= avgHeight * tolerance) {
      currentGroup.push(w);
    } else {
      // 按 x 排序后 push
      currentGroup.sort((a, b) => a.bbox.x - b.bbox.x);
      groups.push(currentGroup);
      currentGroup = [w];
      groupMinY = w.bbox.y;
    }
  }
  currentGroup.sort((a, b) => a.bbox.x - b.bbox.x);
  groups.push(currentGroup);

  return groups;
}

// ── Sprint 33.3.1: Visual Right Boundary ─────────────────────

/**
 * 通过 word projection density 估算视觉右边界。
 *
 * 不使用 paragraph bbox（可能过宽），而是基于词右边缘的 90% 百分位。
 *
 * 算法：
 *   1. 收集所有 word 的右边缘坐标
 *   2. 排序取 90% 百分位
 *   3. 若段落内存在多行宽窄不一，宽行会被截断在 90% 位置（soft bound）
 *
 * 这样能自动适应文档的实际排版宽度，排除个别超宽行的干扰。
 */
export function calculateVisualRightBoundary(words: OCRWord[]): number {
  if (words.length === 0) return 0;

  const rightEdges = words
    .map((w) => w.bbox.x + w.bbox.width)
    .sort((a, b) => a - b); // 升序

  // 90% 百分位：90% 的词右边缘 ≤ 此值
  const idx = Math.max(0, Math.min(rightEdges.length - 1,
    Math.floor(rightEdges.length * 0.90)
  ));

  return rightEdges[idx];
}

// ── Sprint 33.3.1: Word Join ──────────────────────────────────

/**
 * 按阅读顺序拼接词文本，正确处理标点。
 *
 * 规则：
 *   - 默认：word + " " + nextWord
 *   - 若 nextWord 以标点开头（逗号、句号等）→ 不加空格
 *
 * 例如：
 *   joinWords(["trabalho,", "a"])     → "trabalho, a"
 *   joinWords(["CID:", "M544"])       → "CID: M544"
 *   joinWords(["Autorizo", "a"])      → "Autorizo a"
 */
export function joinWords(words: OCRWord[]): string {
  if (words.length === 0) return "";

  let result = words[0].text;

  for (let i = 1; i < words.length; i++) {
    const prevText = words[i - 1].text;
    const currText = words[i].text;

    // 前词末尾没有标点且后词开头没有标点 → 加空格
    const prevLast = prevText.charAt(prevText.length - 1);
    const currFirst = currText.charAt(0);

    // 默认加空格，除非有标点相接
    const needsSpace = !isPunctuationNoSpace(currFirst);

    result += needsSpace ? " " + currText : currText;
  }

  return result;
}

/** 以这些字符开头的词不加前导空格 */
function isPunctuationNoSpace(ch: string): boolean {
  return ch === "," || ch === "." || ch === ";" || ch === ":" ||
         ch === "!" || ch === "?" || ch === ")" || ch === "]" ||
         ch === "}" || ch === "%";
}

// ── Step 3: Overflow Split (Score-Based) ─────────────────────

/**
 * Sprint 33.3.1: 候选打分制断行。
 *
 * 当新词导致溢出时：
 *   1. 生成所有可能的断点候选（currentLineWords 中每个词之后）
 *   2. 对每个候选打分（visualWidth + whitespace + phrase + ocrBoundary）
 *   3. 选择得分最高的候选
 *   4. 无有效候选时强制断行
 */
function splitOverflowLinesByScore(
  words: OCRWord[],
  visualRight: number,
  scoreConfig: LineScoreConfig,
): OCRWord[][] {
  const result: OCRWord[][] = [];
  let currentLineWords: OCRWord[] = [];

  for (let i = 0; i < words.length; i++) {
    const nextWord = words[i];
    const testLine = [...currentLineWords, nextWord];
    const testRight = computeLineMaxRight(testLine);
    const overflows = testRight > visualRight;

    if (!overflows) {
      currentLineWords.push(nextWord);
      continue;
    }

    // 溢出——生成候选并打分
    if (currentLineWords.length === 0) {
      // 空行——单词溢出，强塞
      currentLineWords = [nextWord];
      continue;
    }

    const candidates = generateBreakCandidates(currentLineWords, nextWord, visualRight);
    const needsSplit = findOCROriginalLineChange(currentLineWords, nextWord);

    let bestCandidate: BreakCandidate | null = null;

    if (candidates.length > 0) {
      for (const c of candidates) {
        const score = scoreCandidate(c, currentLineWords, nextWord, visualRight, scoreConfig, needsSplit);
        c.score = score.total;
        c.visualWidthScore = score.visualWidthScore;
        c.whitespaceScore = score.whitespaceScore;
        c.phraseScore = score.phraseScore;
        c.ocrBoundaryScore = score.ocrBoundaryScore;
        c.reasons = score.reasons;

        if (!bestCandidate || c.score > bestCandidate.score) {
          bestCandidate = c;
        }
      }
    }

    if (bestCandidate && bestCandidate.splitIdx > 0) {
      // 应用最佳断点
      result.push(currentLineWords.slice(0, bestCandidate.splitIdx));
      currentLineWords = [...currentLineWords.slice(bestCandidate.splitIdx), nextWord];
    } else {
      // 无合适断点：强制当前行结束
      result.push(currentLineWords);
      currentLineWords = [nextWord];
    }
  }

  if (currentLineWords.length > 0) result.push(currentLineWords);
  return result;
}

function splitOverflowLinesByScoreWithDiagnostics(
  words: OCRWord[],
  visualRight: number,
  scoreConfig: LineScoreConfig,
  decisions: LineReconstructionDecision[],
): OCRWord[][] {
  const result: OCRWord[][] = [];
  let currentLineWords: OCRWord[] = [];

  for (let i = 0; i < words.length; i++) {
    const nextWord = words[i];
    const testLine = [...currentLineWords, nextWord];
    const testRight = computeLineMaxRight(testLine);
    const overflows = testRight > visualRight;

    if (!overflows) {
      currentLineWords.push(nextWord);
      decisions.push({ word: nextWord.text, moved: false, reason: "fits" });
      continue;
    }

    if (currentLineWords.length === 0) {
      currentLineWords = [nextWord];
      decisions.push({ word: nextWord.text, moved: false, reason: "forced_single" });
      continue;
    }

    const candidates = generateBreakCandidates(currentLineWords, nextWord, visualRight);
    const needsSplit = findOCROriginalLineChange(currentLineWords, nextWord);

    let bestCandidate: BreakCandidate | null = null;

    if (candidates.length > 0) {
      for (const c of candidates) {
        const score = scoreCandidate(c, currentLineWords, nextWord, visualRight, scoreConfig, needsSplit);
        c.score = score.total;
        c.visualWidthScore = score.visualWidthScore;
        c.whitespaceScore = score.whitespaceScore;
        c.phraseScore = score.phraseScore;
        c.ocrBoundaryScore = score.ocrBoundaryScore;
        c.reasons = score.reasons;

        if (!bestCandidate || c.score > bestCandidate.score) {
          bestCandidate = c;
        }
      }
    }

    if (bestCandidate && bestCandidate.splitIdx > 0) {
      const movedWords = currentLineWords.slice(bestCandidate.splitIdx);
      for (const mw of movedWords) {
        decisions.push({ word: mw.text, moved: true, reason: "score_optimized_move" });
      }
      decisions.push({ word: nextWord.text, moved: true, reason: "overflow_joined_moved" });

      result.push(currentLineWords.slice(0, bestCandidate.splitIdx));
      currentLineWords = [...movedWords, nextWord];
    } else {
      result.push(currentLineWords);
      decisions.push({ word: nextWord.text, moved: true, reason: "overflow_forced_newline" });
      currentLineWords = [nextWord];
    }
  }

  if (currentLineWords.length > 0) result.push(currentLineWords);
  return result;
}

// ── Candidate Generation ─────────────────────────────────────

/**
 * 为 currentLineWords 生成所有可能的断点候选。
 *
 * 每个断点 splitIdx 表示：left = [0..splitIdx) 留在当前行，right = [splitIdx..] 移到下一行。
 * 只生成左半部分不溢出的候选。
 */
function generateBreakCandidates(
  currentLineWords: OCRWord[],
  _nextWord: OCRWord,
  visualRight: number,
): BreakCandidate[] {
  const candidates: BreakCandidate[] = [];
  const leftStart = currentLineWords[0]?.bbox.x ?? 0;

  // 从第 1 个词末尾到倒数第 1 个词末尾
  for (let splitIdx = 1; splitIdx <= currentLineWords.length; splitIdx++) {
    const leftWords = currentLineWords.slice(0, splitIdx);
    const leftRight = computeLineMaxRight(leftWords);

    // 左半不溢出才有效
    if (leftRight <= visualRight) {
      candidates.push({
        splitIdx,
        score: 0,
        reasons: [],
        visualWidthScore: 0,
        whitespaceScore: 0,
        phraseScore: 0,
        ocrBoundaryScore: 0,
      });
    }
  }

  return candidates;
}

// ── Candidate Scoring ────────────────────────────────────────

interface ScoreBreakdown {
  total: number;
  visualWidthScore: number;
  whitespaceScore: number;
  phraseScore: number;
  ocrBoundaryScore: number;
  reasons: string[];
}

/**
 * 对单个断点候选打分。
 *
 * 四个维度：
 *   1. visualWidthScore (权重 0.4): 行右端离 visualRight 越近越好（理想 85-98%）
 *   2. whitespaceScore  (权重 0.3): 词间空白分布均匀度
 *   3. phraseScore      (权重 0.2): 短语完整性（拆分 protected phrase → 0 分）
 *   4. ocrBoundaryScore (权重 0.1): OCR 原始行边界匹配奖励
 */
function scoreCandidate(
  candidate: BreakCandidate,
  currentLineWords: OCRWord[],
  nextWord: OCRWord,
  visualRight: number,
  config: LineScoreConfig,
  needsSplit: boolean,
): ScoreBreakdown {
  const leftWords = currentLineWords.slice(0, candidate.splitIdx);
  const rightWords = currentLineWords.slice(candidate.splitIdx);
  const reasons: string[] = [];

  // 1) Visual Width Score
  const leftRight = computeLineMaxRight(leftWords);
  const leftStart = leftWords[0]?.bbox.x ?? 0;
  const usedWidth = leftRight - leftStart;
  const availableWidth = visualRight - leftStart;
  const widthRatio = availableWidth > 0 ? usedWidth / availableWidth : 0;
  // 高斯函数，中心 0.92, sigma 0.08 —— 接近 92% 填充为最佳
  const widthDeviation = (widthRatio - 0.92) / 0.08;
  let visualWidthScore = Math.exp(-0.5 * widthDeviation * widthDeviation);
  // 过度溢出严重扣分
  if (leftRight > visualRight) {
    visualWidthScore = 0;
    reasons.push("overflow");
  } else if (widthRatio >= 0.80 && widthRatio <= 1.0) {
    reasons.push("widthGood");
  } else if (widthRatio < 0.5) {
    reasons.push("widthTooNarrow");
  }

  // 2) Whitespace Score
  let whitespaceScore = 1.0;
  if (leftWords.length >= 2) {
    // 计算词间空隙的平均值和方差
    const gaps: number[] = [];
    for (let g = 1; g < leftWords.length; g++) {
      const prevRight = leftWords[g - 1].bbox.x + leftWords[g - 1].bbox.width;
      const currLeft = leftWords[g].bbox.x;
      gaps.push(currLeft - prevRight);
    }
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const avgCharWidth = leftWords.reduce((s, w) => s + w.bbox.width / Math.max(1, w.text.length), 0) / leftWords.length;
    // 理想空隙 ≈ 0.3-0.5 倍平均字符宽度
    const gapRatio = avgCharWidth > 0 ? avgGap / avgCharWidth : 0;
    // 越接近 0.35 越好
    const gapDeviation = (gapRatio - 0.35) / 0.2;
    whitespaceScore = Math.exp(-0.5 * gapDeviation * gapDeviation);

    if (gapRatio >= 0.25 && gapRatio <= 0.55) {
      reasons.push("spacingGood");
    } else if (gapRatio > 1.0) {
      reasons.push("spacingWide");
    }
  }

  // 3) Phrase Score（Sprint 33.3.2: 集成 Phrase Cohesion Engine）
  let phraseScore = 1.0;
  if (rightWords.length > 0) {
    const lastLeft = leftWords[leftWords.length - 1];
    const firstRight = rightWords[0];

    const lastLeftClean = lastLeft.text.toLowerCase().replace(/[,.;:!?)]$/, "");
    const firstRightClean = firstRight.text.toLowerCase().replace(/[,.;:!?)]$/, "");

    // Sprint 33.3.2: 优先使用 phrase-cohesion 检查
    const cohesionScore = getPhraseScore(leftWords, firstRight);
    if (cohesionScore > 0 || isKeepTogether(lastLeftClean, firstRightClean) || isProtectedPair(lastLeftClean, firstRightClean)) {
      phraseScore = 0.0;
      reasons.push("brokenProtectedPhrase");
    } else {
      reasons.push("preservePhrase");
    }
  } else {
    reasons.push("preservePhrase");
  }

  // Sprint 33.3.2: 行末介词软惩罚（降为 0.02，减少对短词分行的偏袒）
  const lastLeftLower = leftWords[leftWords.length - 1].text.toLowerCase().replace(/[,.;:!?)]$/, "");
  if (PT_PREPOSITIONS.has(lastLeftLower) && phraseScore > 0) {
    phraseScore = Math.max(0, phraseScore - 0.02);
    reasons.push("endsWithPreposition");
  }

  // Sprint 33.3.2: 单短词惩罚（禁止孤立 "a"/"de" 等成行）
  if (rightWords.length === 1) {
    const singleWordText = rightWords[0].text.toLowerCase().replace(/[,.;:!?)]$/, "");
    if (isShortFunctionWord(singleWordText)) {
      phraseScore = Math.max(0, phraseScore - 0.15);
      reasons.push("singleShortWordNextLine");
    }
  }

  // 4) OCR Boundary Score（soft hint only）
  let ocrBoundaryScore = 0.0;
  if (needsSplit) {
    // OCR 原始行在这里变化 → 匹配 OCR 边界
    // 检查 leftWords 的最后一个词和 rightWords 的第一个词是否在 OCR 中分属不同行
    const lastLeftOLI = leftWords[leftWords.length - 1].originalLineIndex;
    const firstRightOLI = rightWords[0].originalLineIndex;
    if (lastLeftOLI !== firstRightOLI) {
      // 断点恰好匹配 OCR 原行边界
      ocrBoundaryScore = 1.0;
      reasons.push("ocrLineMatch");
    } else {
      // 断点不在 OCR 原边界上
      reasons.push("ocrLineMismatch");
    }
  } else {
    // OCR 中没有断点差异，不适用
    ocrBoundaryScore = 0.5;
    reasons.push("ocrLineMatch");
  }

  // 加权求和
  const total =
    config.visualWidthWeight * visualWidthScore +
    config.whitespaceWeight * whitespaceScore +
    config.phraseWeight * phraseScore +
    config.originalLinePenalty * ocrBoundaryScore;

  return {
    total,
    visualWidthScore,
    whitespaceScore,
    phraseScore,
    ocrBoundaryScore,
    reasons,
  };
}

// ── Utility: compute line max right ──────────────────────────

/** 计算词序列的最右边缘 */
function computeLineMaxRight(words: OCRWord[]): number {
  let maxRight = 0;
  for (const w of words) {
    const r = w.bbox.x + w.bbox.width;
    if (r > maxRight) maxRight = r;
  }
  return maxRight;
}

/** 检查 currentLineWords 末尾词与 nextWord 是否跨 OCR 原始行 */
function findOCROriginalLineChange(
  currentLineWords: OCRWord[],
  nextWord: OCRWord,
): boolean {
  if (currentLineWords.length === 0) return false;
  const lastOLI = currentLineWords[currentLineWords.length - 1].originalLineIndex;
  return lastOLI !== nextWord.originalLineIndex;
}

// ── Build Line ───────────────────────────────────────────────

/**
 * Sprint 33.3.1: 使用 joinWords 拼接文本，正确处理标点间距。
 */
function buildLine(words: OCRWord[], lineIndex: number): ReconstructedLine {
  if (words.length === 0) {
    return {
      words: [],
      text: "",
      bbox: { x: 0, y: 0, width: 0, height: 0 },
      glyphStartIndex: 0,
      glyphEndIndex: 0,
      lineIndex,
    };
  }

  const xs = words.map((w) => w.bbox.x);
  const ys = words.map((w) => w.bbox.y);
  const rights = words.map((w) => w.bbox.x + w.bbox.width);
  const bottoms = words.map((w) => w.bbox.y + w.bbox.height);

  // Sprint 33.3.1: 使用 joinWords 替代简单 join(" ")
  const text = joinWords(words);

  return {
    words,
    text,
    bbox: {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...rights) - Math.min(...xs),
      height: Math.max(...bottoms) - Math.min(...ys),
    },
    glyphStartIndex: words[0].glyphStartIndex,
    glyphEndIndex: words[words.length - 1].glyphEndIndex,
    lineIndex,
  };
}

// ── Sprint 33.3.2: Single Word Penalty ─────────────────────────

/**
 * 禁止孤立短词成行。
 *
 * 若单行只有一个短虚词（"a" / "de" / "e" 等），返回 -100。
 * 用于 post-process 合并阶段评估。
 */
export function singleWordPenalty(words: OCRWord[]): number {
  if (words.length !== 1) return 0;
  const text = words[0].text.toLowerCase().replace(/[,.;:!?)]$/, "").trim();
  if (text.length === 0) return -100; // 空白行
  if (isShortFunctionWord(text)) return -100;
  if (text.length <= 2) return -80;   // 极短词也是可疑的
  return 0;
}

// ── Sprint 33.3.2: Line Stability Score ────────────────────────

/**
 * Sprint 33.3.2: 综合行稳定性评分。
 *
 * 评估一个完整的行排列（如原始 + 候选方案），四个维度：
 *   widthScore   (0.35): 行宽填充度（接近 visualRight 为佳）
 *   phraseScore  (0.35): 短语内聚度（protected pair 同行加分）
 *   balanceScore (0.20): 行间长度均衡度
 *   ocrMatchScore(0.10): OCR 原始行匹配度
 *
 * 返回 0-100 的归一化得分。
 */
export function calculateLineStability(
  lineWordsArr: OCRWord[][],
  visualRight: number,
): number {
  if (lineWordsArr.length === 0) return 0;

  // 1) Width Score: 每行填充度
  let totalWidthScore = 0;
  for (const lineWords of lineWordsArr) {
    if (lineWords.length === 0) continue;
    const lineRight = computeLineMaxRight(lineWords);
    const lineLeft = lineWords[0].bbox.x;
    const used = lineRight - lineLeft;
    const available = visualRight - lineLeft;
    const ratio = available > 0 ? Math.min(1, used / available) : 0;
    // 高斯：中心 0.90, sigma 0.10
    const dev = (ratio - 0.90) / 0.10;
    totalWidthScore += Math.exp(-0.5 * dev * dev);
  }
  const avgWidthScore = totalWidthScore / Math.max(1, lineWordsArr.length);

  // 2) Phrase Cohesion Score: 行间跨边界短语
  let totalPhraseScore = 0;
  let totalBoundaries = 0;
  for (let li = 0; li < lineWordsArr.length - 1; li++) {
    const currLine = lineWordsArr[li];
    const nextLine = lineWordsArr[li + 1];
    if (currLine.length === 0 || nextLine.length === 0) continue;
    totalBoundaries++;

    const cohesion = getPhraseScore(currLine, nextLine[0]);
    // cohesion=50 → 1.0, cohesion=0 → 0.5 (normal)
    totalPhraseScore += cohesion > 0 ? 0.0 : 0.5;
  }
  const avgPhraseScore = totalBoundaries > 0 ? totalPhraseScore / totalBoundaries : 0.5;

  // 3) Balance Score: 行间字数方差
  const wordCounts = lineWordsArr.map((lw) => lw.length);
  const avgWords = wordCounts.reduce((s, c) => s + c, 0) / Math.max(1, wordCounts.length);
  const variance = wordCounts.reduce((s, c) => s + (c - avgWords) ** 2, 0) / Math.max(1, wordCounts.length);
  // 方差归一化：完美均匀 → 1.0，极端差异 → 0.0
  const balanceScore = Math.max(0, 1 - Math.sqrt(variance) / Math.max(1, avgWords));

  // 4) OCR Match (soft hint)
  const ocrScore = 0.5; // 默认中等

  // 加权求和 → 0-1 → 0-100
  const rawScore =
    0.35 * avgWidthScore +
    0.35 * avgPhraseScore +
    0.20 * balanceScore +
    0.10 * ocrScore;

  return Math.round(rawScore * 100);
}

// ── Sprint 33.3.2: Line Merge Fallback ─────────────────────────

/**
 * 短行合并回退机制。
 *
 * 在 splitOverflowLinesByScore 之后调用。
 * 检测短行（1 词且是虚词），尝试将其合并到上一行。
 * 若合并后不溢出 visualRight，则应用合并。
 *
 * 优先级：
 *   1. 短语内聚（getPhraseScore > 0）
 *   2. 单行短词惩罚
 *   3. 视觉溢出检查
 */
function mergeShortLines(
  lines: OCRWord[][],
  visualRight: number,
): OCRWord[][] {
  if (lines.length <= 1) return lines;

  const result: OCRWord[][] = [];

  for (let i = 0; i < lines.length; i++) {
    const currLine = lines[i];

    // 检查当前行是否是孤立短词
    if (i > 0 && currLine.length === 1) {
      const prevLine = result[result.length - 1];

      // 短语内聚检查：前一行末尾词 + 当前词是否应合在一起
      const cohesion = getPhraseScore(prevLine, currLine[0]);

      // 尝试合并
      const merged = [...prevLine, ...currLine];
      const mergedRight = computeLineMaxRight(merged);

      if (mergedRight <= visualRight && cohesion >= 0) {
        // 可以合并且不溢出
        result[result.length - 1] = merged;
        continue;
      }

      // 如果短语内聚强（+50），即使稍微溢出也合并
      if (cohesion >= 50) {
        result[result.length - 1] = merged;
        continue;
      }
    }

    result.push(currLine);
  }

  return result;
}

// ── Diagnostics ─────────────────────────────────────────────────

function groupOriginalOCRLines(words: OCRWord[]): string[] {
  const map = new Map<number, string[]>();
  for (const w of words) {
    const idx = w.originalLineIndex;
    if (!map.has(idx)) map.set(idx, []);
    map.get(idx)!.push(w.text);
  }
  const indices = [...map.keys()].sort((a, b) => a - b);
  return indices.map((i) => map.get(i)!.join(" "));
}

// ── Exported for testing ────────────────────────────────────────

export { yClusterWords, mergeShortLines };
export { PT_PREPOSITIONS, PT_KEEP_TOGETHER, isKeepTogether, SHORT_FUNCTION_WORDS, isShortFunctionWord };
