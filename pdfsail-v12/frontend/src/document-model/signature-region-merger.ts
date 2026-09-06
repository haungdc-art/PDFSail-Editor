/**
 * SignatureRegionMerger — Sprint 12, 15, 19, 20
 *
 * 签名区域识别与合并。
 *
 * Sprint 20 新增:
 *   - detectCompositeSignatureRegions() — 将多个 OCR block 理解为单个复合签名区域.
 *   - 增强空间聚类（垂直堆叠 80px、水平重叠 > 0.3）.
 *   - 语义去重匹配（compareBlockSimilarity）.
 *
 * 数据流（Sprint 20）:
 *   EditableBlock[] → candidate filter → spatial clustering →
 *   semantic duplicate matching → SignatureCompositeRegion[]
 *
 * 旧版（保留向后兼容）:
 *   detectSignatureRegions() → SignatureRegion[]
 */

import type { EditableBlock } from "./types";
import type {
  SignatureCompositeRegion,
  CompositeRegionResult,
  CompositeRegionDebug,
} from "./signature-composite-region";

// ────────────────────────────────────────────────────────────
// Sprint 12: Legacy SignatureRegion (kept for backward compat)
// ────────────────────────────────────────────────────────────

/** 签名区域（单个 cluster） */
export interface SignatureRegion {
  id: string;
  bbox: { x: number; y: number; width: number; height: number };
  originalSourceBlocks: EditableBlock[];
  editableTextBlocks: EditableBlock[];
  suppressedBlocks: EditableBlock[];
  isMixed: boolean;
  confidence: number;
}

export interface DetectSignatureRegionResult {
  regions: SignatureRegion[];
  suppressedGlyphBlockIds: Set<string>;
  debug: any[];
}

export { detectSignatureRegions };
export type { SignatureRegion as SignatureRegionExport };

// ────────────────────────────────────────────────────────────
// Sprint 20 配置常量
// ────────────────────────────────────────────────────────────

/** 垂直间距阈值 (px)，小于此值则视为同一堆叠 */
const VERTICAL_GAP_MAX = 80;

/** 水平重叠阈值，大于此值则视为同一行 */
const HORIZONTAL_OVERLAP_MIN = 0.3;

/** 语义相似度阈值，大于此值则视为重复 */
const DUPLICATE_SIMILARITY_THRESHOLD = 0.6;

/** 签名关键词 */
const SIGNATURE_KEYWORDS = [
  "Dr", "Dra", "Dr.",
  "CRM", "CRM-",
  "Médico", "Medico", "MEDICO", "MÉDICO",
  "Aguiar",
  "Assinatura", "Assinado",
  "Signature", "Signed",
  "Firma",
];

/** 底部区域阈值（y > pageHeight * BOTTOM_REGION_RATIO） */
const BOTTOM_REGION_RATIO = 0.7;

// ────────────────────────────────────────────────────────────
// Sprint 12: 旧版检测逻辑（保持向后兼容）
// ────────────────────────────────────────────────────────────

function detectSignatureRegions(
  blocks: EditableBlock[],
  pageHeight: number,
): DetectSignatureRegionResult {
  const sigCandidates = filterCandidates(blocks, pageHeight);
  const clusters = clusterSignatureBlocks(sigCandidates);
  const regions: SignatureRegion[] = [];
  const suppressedIds = new Set<string>();

  for (const cluster of clusters) {
    const printed: EditableBlock[] = [];
    const handwritten: EditableBlock[] = [];

    for (const b of cluster) {
      const txt = extractText(b);
      if (isHandwrittenBlock(txt)) {
        handwritten.push(b);
      } else {
        printed.push(b);
      }
    }

    if (printed.length === 0 || handwritten.length === 0) continue;

    const allSrc = [...printed, ...handwritten];
    const bbox = computeBBox(allSrc);
    const isMixed = printed.length > 0 && handwritten.length > 0;

    regions.push({
      id: `sig_region_${regions.length}`,
      bbox,
      originalSourceBlocks: allSrc,
      editableTextBlocks: printed,
      suppressedBlocks: handwritten,
      isMixed,
      confidence: isMixed ? 0.9 : 0.6,
    });

    for (const h of handwritten) suppressedIds.add(h.id);
  }

  return { regions, suppressedGlyphBlockIds: suppressedIds, debug: [] };
}

// ────────────────────────────────────────────────────────────
// Sprint 20: 复合签名区域检测
// ────────────────────────────────────────────────────────────

/**
 * 检测复合签名区域。
 *
 * 将空间上相邻、语义上相关的多个 OCR block 合并为单个
 * SignatureCompositeRegion，解决 "1 个物理签名 → 7 个 OCR block"
 * 被误判为多个独立区域的问题。
 */
function detectCompositeSignatureRegions(
  blocks: EditableBlock[],
  pageHeight: number,
): CompositeRegionResult {
  const candidates = filterCandidates(blocks, pageHeight);
  // Task-W2-3D Trace：打印 filterCandidates 后幸存 candidate 总数
  console.log(
    `[MergeTrace] Stage:Filter Result candidateCount:${candidates.length} / total:${blocks.length} ` +
      `candidateIds:[${candidates.map(b => b.id).join(",")}]`,
  );
  const clusters = enhancedCluster(candidates);

  const regions: SignatureCompositeRegion[] = [];
  const suppressedIds = new Set<string>();
  const debugRegions: CompositeRegionDebug["regions"] = [];

  for (let ci = 0; ci < clusters.length; ci++) {
    const cluster = clusters[ci];
    // Task-W2-3D Trace-M3：打印每个 cluster 的成员（含真正的签名 block 是否被聚类进来）
    console.log(
      `[MergeTrace] Stage:Cluster cluster_${ci} size:${cluster.length} ` +
        `ids:[${cluster.map(b => b.id).join(",")}] ` +
        `texts:[${cluster.map(b => JSON.stringify(extractText(b).slice(0, 30))).join(" | ")}]`,
    );
    if (cluster.length < 2) continue;

    // 根据块特性分类
    const printed: EditableBlock[] = [];
    const handwritten: EditableBlock[] = [];
    for (const b of cluster) {
      if (isHandwrittenBlock(extractText(b))) {
        handwritten.push(b);
      } else {
        printed.push(b);
      }
    }

    // 去重匹配: 在 printed 和 handwritten 之间找语义重复对
    const similarityPairs: Array<{
      blockIdA: string; blockIdB: string;
      textA: string; textB: string; similarity: number;
    }> = [];

    const actualDuplicates = new Set<string>();
    const keptPrinted = new Set<string>();

    for (const p of printed) {
      const pText = extractText(p);
      for (const h of handwritten) {
        const hText = extractText(h);
        const sim = compareBlockSimilarity(pText, hText);
        if (sim > DUPLICATE_SIMILARITY_THRESHOLD) {
          similarityPairs.push({
            blockIdA: p.id, blockIdB: h.id,
            textA: pText, textB: hText, similarity: sim,
          });
          actualDuplicates.add(h.id);
          keptPrinted.add(p.id);
        }
      }
    }

    // 未匹配到 printed 的 handwritten 也视为重复（可能是所有行都是手写的情况）
    for (const h of handwritten) {
      if (!actualDuplicates.has(h.id)) {
        actualDuplicates.add(h.id);
      }
    }

    // 构建 region —— 合并所有 source blocks
    const sourceBlockIds = cluster.map(b => b.id);
    const editableBlockIds = cluster
      .filter(b => !actualDuplicates.has(b.id))
      .map(b => b.id);
    const duplicateBlockIds = [...actualDuplicates];

    const allBbox = computeBBox(cluster);

    // 检测旋转（优先从 handwritten blocks 检测）  
    const rotationBBox = handwritten.length > 0
      ? computeBBox(handwritten)
      : computeBBox(printed);

    let rotation = { angle: 0, confidence: 0 };
    if (handwritten.length > 0 || printed.length > 0) {
      rotation = detectRegionRotation(
        cluster,
        rotationBBox,
      );
    }

    const mode: "printed" | "handwritten" | "mixed" =
      printed.length > 0 && duplicateBlockIds.length > 0
        ? "mixed"
        : printed.length > 0
          ? "printed"
          : "handwritten";

    const conf = computeConfidence(cluster, mode);

    // P0-006（Signature Policy V2）：
    // 所有 source blocks 都存在（不因 Policy 隐藏/删除）。
    // defaultEditableBlockId 只决定"默认编辑哪个 block"，不决定任何 block 是否存在。
    const defaultEditableBlockId =
      editableBlockIds.length > 0
        ? editableBlockIds[0]
        : (cluster[0]?.id ?? "");

    regions.push({
      id: `composite_sig_${ci}`,
      bbox: allBbox,
      sourceBlockIds,
      sourceBlocks: cluster,
      editableBlockIds,
      duplicateBlockIds,
      defaultEditableBlockId,
      rotation,
      confidence: conf,
      mode,
    });

    // Task-W2-3B Trace：记录 Region 输出 rotation 与 editableBlockIds
    console.log(
      `[SignatureRotationTrace] Stage:Region RegionId:composite_sig_${ci} ` +
        `rotation:${rotation.angle.toFixed ? rotation.angle.toFixed(3) : rotation.angle} ` +
        `editableBlockIds:[${editableBlockIds.join(",")}]`,
    );

    // 收集 debug 信息
    const editableTexts = cluster
      .filter(b => editableBlockIds.includes(b.id))
      .map(b => extractText(b));
    const duplicateTexts = cluster
      .filter(b => duplicateBlockIds.includes(b.id))
      .map(b => extractText(b));

    debugRegions.push({
      bbox: allBbox,
      mode,
      sourceBlocks: sourceBlockIds,
      editable: editableBlockIds,
      duplicate: duplicateBlockIds,
      editableTexts,
      duplicateTexts,
      rotation,
      confidence: conf,
      similarityPairs,
    });

    for (const id of duplicateBlockIds) suppressedIds.add(id);
  }

  const debug: CompositeRegionDebug = {
    candidateBlockCount: candidates.length,
    clusterCount: clusters.length,
    regionCount: regions.length,
    regions: debugRegions,
  };

  return { regions, suppressedGlyphBlockIds: suppressedIds, debug };
}

// ────────────────────────────────────────────────────────────
// 候选过滤
// ────────────────────────────────────────────────────────────

function filterCandidates(blocks: EditableBlock[], pageHeight: number): EditableBlock[] {
  return blocks.filter(b => {
    const text = extractText(b);
    // Task-W2-3D Trace-M1：打印每个 block 的 Keep/Drop 及 Reason
    let reason = "Keep";
    if (!text || text.trim().length === 0) {
      reason = "Drop:EmptyText";
    } else if (matchesKeywords(text, SIGNATURE_KEYWORDS)) {
      reason = "Keep:KeywordMatch";
    } else if (b.bbox.y > pageHeight * BOTTOM_REGION_RATIO) {
      reason = "Keep:BottomArea";
    } else {
      reason = "Drop:NoSignal";
    }
    console.log(
      `[MergeTrace] Stage:FilterCandidates Block:${b.id} ` +
        `text:${JSON.stringify(text.slice(0, 40))} label:${JSON.stringify((b as any).label)} ` +
        `y:${b.bbox.y.toFixed(0)} pageH:${pageHeight.toFixed(0)} ${reason}`,
    );
    if (reason.startsWith("Drop")) return false;
    return true;
  });
}

function matchesKeywords(text: string, keywords: string[]): boolean {
  const upper = text.toUpperCase();
  for (const kw of keywords) {
    if (upper.includes(kw.toUpperCase())) return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────
// Sprint 12: 旧版聚类（保留向后兼容）
// ────────────────────────────────────────────────────────────

function clusterSignatureBlocks(candidates: EditableBlock[]): EditableBlock[][] {
  const clusters: EditableBlock[][] = [];
  const visited = new Set<number>();

  for (let i = 0; i < candidates.length; i++) {
    if (visited.has(i)) continue;
    const cluster: EditableBlock[] = [candidates[i]];
    visited.add(i);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (let j = 0; j < candidates.length; j++) {
        if (visited.has(j)) continue;
        for (const cb of cluster) {
          if (areBlocksClose(cb, candidates[j])) {
            cluster.push(candidates[j]);
            visited.add(j);
            expanded = true;
            break;
          }
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

// Sprint 12 的 space 合并阈值（保留）
function areBlocksClose(a: EditableBlock, b: EditableBlock): boolean {
  const gapX = Math.max(0, Math.max(a.bbox.x, b.bbox.x) -
    Math.min(a.bbox.x + a.bbox.width, b.bbox.x + b.bbox.width));
  const gapY = Math.max(0, Math.max(a.bbox.y, b.bbox.y) -
    Math.min(a.bbox.y + a.bbox.height, b.bbox.y + b.bbox.height));

  const overlapX = computeHorizontalOverlap(a, b);
  return (gapY < 40 && overlapX > 0.3) || (gapY < 20);
}

// ────────────────────────────────────────────────────────────
// Sprint 20: 增强聚类（垂直堆叠 + 水平重叠）
// ────────────────────────────────────────────────────────────

/**
 * 增强空间聚类: 使用更宽松的阈值 + 传递闭包。
 *
 * 规则:
 *   1. 垂直堆叠: vertical gap < 80px → 合并
 *   2. 水平重叠: horizontal overlap > 0.3 → 合并
 *   3. 相邻: gapX < 20px AND gapY < 20px → 合并
 */
function enhancedCluster(candidates: EditableBlock[]): EditableBlock[][] {
  if (candidates.length <= 1) return candidates.map(b => [b]);

  const n = candidates.length;
  const parent = new Array(n).fill(0).map((_, i) => i);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  function union(a: number, b: number) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  }

  // 两两比较
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = candidates[i], b = candidates[j];

      // 规则 1: 垂直堆叠
      if (isVerticallyStacked(a, b)) {
        union(i, j);
        continue;
      }

      // 规则 2: 水平重叠 + 近距离
      const overlapX = computeHorizontalOverlap(a, b);
      const gapY = computeVerticalGap(a, b);
      if (overlapX > HORIZONTAL_OVERLAP_MIN && gapY < VERTICAL_GAP_MAX) {
        union(i, j);
        continue;
      }

      // 规则 3: 相邻检测
      const gapX = computeHorizontalGap(a, b);
      if (gapX < 20 && gapY < 20) {
        union(i, j);
      }
    }
  }

  // 按 root 分组
  const groups = new Map<number, EditableBlock[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(candidates[i]);
  }

  return [...groups.values()];
}

/** 垂直堆叠检测: 水平有重叠 且 垂直间距 < VERTICAL_GAP_MAX */
function isVerticallyStacked(a: EditableBlock, b: EditableBlock): boolean {
  const overlapX = computeHorizontalOverlap(a, b);
  const gapY = computeVerticalGap(a, b);
  return overlapX > 0.1 && gapY < VERTICAL_GAP_MAX;
}

/** 计算两个 bbox 的水平重叠比例 */
function computeHorizontalOverlap(
  a: { bbox: { x: number; width: number } },
  b: { bbox: { x: number; width: number } },
): number {
  const aLeft = a.bbox.x, aRight = a.bbox.x + a.bbox.width;
  const bLeft = b.bbox.x, bRight = b.bbox.x + b.bbox.width;

  const overlap = Math.max(0, Math.min(aRight, bRight) - Math.max(aLeft, bLeft));
  const minWidth = Math.min(a.bbox.width, b.bbox.width);
  return minWidth > 0 ? overlap / minWidth : 0;
}

/** 计算垂直间距（非负数） */
function computeVerticalGap(
  a: { bbox: { y: number; height: number } },
  b: { bbox: { y: number; height: number } },
): number {
  const aTop = a.bbox.y, aBot = a.bbox.y + a.bbox.height;
  const bTop = b.bbox.y, bBot = b.bbox.y + b.bbox.height;
  return Math.max(0, Math.max(aTop, bTop) - Math.min(aBot, bBot));
}

/** 计算水平间距（非负数） */
function computeHorizontalGap(
  a: { bbox: { x: number; width: number } },
  b: { bbox: { x: number; width: number } },
): number {
  const aLeft = a.bbox.x, aRight = a.bbox.x + a.bbox.width;
  const bLeft = b.bbox.x, bRight = b.bbox.x + b.bbox.width;
  return Math.max(0, Math.max(aLeft, bLeft) - Math.min(aRight, bRight));
}

// ────────────────────────────────────────────────────────────
// Sprint 20 Task 4: 语义去重匹配
// ────────────────────────────────────────────────────────────

/**
 * 比较两个文本块的语义相似度。
 *
 * 算法: bigram Jaccard (40%) + word overlap (60%)。
 * 不区分大小写，去除标点。
 *
 *   示例:
 *     "Dr. Jefferson Aguiar Maciel" vs "JEFERSON AGUIAR MACIEL"
 *     → 共享子词 + 共享词: "AGUIAR", "MACIEL" → similarity ≈ 0.65
 */
function compareBlockSimilarity(textA: string, textB: string): number {
  const normA = normalizeText(textA);
  const normB = normalizeText(textB);

  if (!normA || !normB) return 0;
  if (normA === normB) return 1.0;

  // Bigram Jaccard
  const bigramsA = toBigrams(normA);
  const bigramsB = toBigrams(normB);
  let bigramIntersection = 0;
  const used = new Set<number>();
  for (const ba of bigramsA) {
    for (let j = 0; j < bigramsB.length; j++) {
      if (used.has(j)) continue;
      if (ba === bigramsB[j]) { bigramIntersection++; used.add(j); break; }
    }
  }
  const bigramUnion = bigramsA.length + bigramsB.length - bigramIntersection;
  const bigramSim = bigramUnion > 0 ? bigramIntersection / bigramUnion : 0;

  // Word overlap (Jaccard)
  const wordsA = normA.split(/\s+/).filter(w => w.length > 1);
  const wordsB = normB.split(/\s+/).filter(w => w.length > 1);
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  let wordIntersection = 0;
  for (const w of setA) { if (setB.has(w)) wordIntersection++; }
  const wordUnion = setA.size + setB.size - wordIntersection;
  const wordSim = wordUnion > 0 ? wordIntersection / wordUnion : 0;

  return bigramSim * 0.4 + wordSim * 0.6;
}

/** 文本归一化: 转小写、去标点(保留空格和字母数字)、折叠空白 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // 去重音符
    .replace(/[^a-z0-9\s]/g, " ")    // 去标点
    .replace(/\s+/g, " ")
    .trim();
}

/** 生成 bigrams */
function toBigrams(text: string): string[] {
  const bigrams: string[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    bigrams.push(text.substring(i, i + 2));
  }
  return bigrams;
}

// ────────────────────────────────────────────────────────────
// 辅助函数
// ────────────────────────────────────────────────────────────

function extractText(block: EditableBlock): string {
  return block.lines.map(l => l.glyphs.map(g => g.char).join("")).join(" ");
}

/** 判断是否为手写风格 OCR 文本（大写占主导） */
function isHandwrittenBlock(text: string): boolean {
  const alpha = text.replace(/[^a-zA-Z]/g, "");
  if (alpha.length === 0) return false;
  const upperCount = alpha.replace(/[^A-Z]/g, "").length;
  return upperCount / alpha.length > 0.7;
}

function computeBBox(blocks: EditableBlock[]): { x: number; y: number; width: number; height: number } {
  if (blocks.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of blocks) {
    if (b.bbox.x < minX) minX = b.bbox.x;
    if (b.bbox.y < minY) minY = b.bbox.y;
    if (b.bbox.x + b.bbox.width > maxX) maxX = b.bbox.x + b.bbox.width;
    if (b.bbox.y + b.bbox.height > maxY) maxY = b.bbox.y + b.bbox.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 检测区域的基线旋转角度。
 *
 * Sprint34.26（源头修复）：
 * 旧算法把区域内所有行、所有字符混在一起做"一条"线性回归，
 * 导致 slope 反映的是"多行整体排布"（第一行高、最后一行低），
 * 而非单行文字的真实倾斜 —— 被水平打印行稀释成接近 0 的伪角度（如 -1.3°，conf=0.01）。
 *
 * 新算法（按行检测倾斜，通用方法，不针对具体 PDF）：
 *   1. 按 y 聚类把字符分成若干"行"；
 *   2. 对每一行单独做线性回归，得到该行文字的倾斜角；
 *   3. 取所有行的中位数作为区域旋转（抗离群）；
 *   4. confidence 基于各行角度一致性（标准差小 → 高置信度）。
 *
 * 记录：本函数是检测签名/区域旋转的唯一来源，改动已固化（Sprint34.26）。
 */
function detectRegionRotation(
  blocks: EditableBlock[],
  regionBBox: { x: number; y: number; width: number; height: number },
): { angle: number; confidence: number } {
  const points: Array<{ x: number; y: number }> = [];

  for (const block of blocks) {
    for (const line of block.lines) {
      for (const g of line.glyphs) {
        points.push({
          x: g.bbox.x + g.bbox.width / 2,
          y: g.bbox.y + g.bbox.height / 2,
        });
      }
    }
  }

  if (points.length < 3) return { angle: 0, confidence: 0 };

  // ── 1. 按 y 聚类成行 ──
  // 用字符 y 间隙的较小分位数估计"行内垂直步进"，行距阈值 = 其 ~2.5 倍。
  const sortedY = [...points].map((p) => p.y).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sortedY.length; i++) gaps.push(sortedY[i] - sortedY[i - 1]);
  gaps.sort((a, b) => a - b);
  const step = gaps.length > 0 ? gaps[Math.floor(gaps.length * 0.2)] : (regionBBox.height || 10);
  const rowGap = Math.max(step * 2.5, 3);

  const byY = [...points].sort((a, b) => a.y - b.y);
  const rows: Array<Array<{ x: number; y: number }>> = [];
  let cur: Array<{ x: number; y: number }> = [];
  let lastY = -Infinity;
  for (const p of byY) {
    if (cur.length > 0 && p.y - lastY > rowGap) {
      rows.push(cur);
      cur = [];
    }
    cur.push(p);
    lastY = p.y;
  }
  if (cur.length > 0) rows.push(cur);

  // ── 2. 每行单独线性回归，得该行倾斜角 ──
  const angles: number[] = [];
  for (const row of rows) {
    if (row.length < 3) continue; // 单行不足 3 字符无法回归
    const n = row.length;
    const sx = row.reduce((s, p) => s + p.x, 0);
    const sy = row.reduce((s, p) => s + p.y, 0);
    const sxy = row.reduce((s, p) => s + p.x * p.y, 0);
    const sx2 = row.reduce((s, p) => s + p.x * p.x, 0);
    const denom = n * sx2 - sx * sx;
    if (Math.abs(denom) < 1e-9) continue;
    const slope = (n * sxy - sx * sy) / denom;
    // PDF(Y-up)→CSS(Y-down) 翻转后 slope 方向反转，取负与渲染系（CSS 顺时针为正）一致。
    const angle = -Math.atan(slope) * (180 / Math.PI);
    angles.push(angle);
  }

  if (angles.length === 0) return { angle: 0, confidence: 0 };

  // ── 3. 中位数角度（抗离群） ──
  const sortedAngles = [...angles].sort((a, b) => a - b);
  const median =
    sortedAngles.length % 2 === 1
      ? sortedAngles[Math.floor(sortedAngles.length / 2)]
      : (sortedAngles[sortedAngles.length / 2 - 1] + sortedAngles[sortedAngles.length / 2]) / 2;

  // ── 4. confidence 基于角度一致性（标准差小 → 高置信度） ──
  const mean = angles.reduce((s, a) => s + a, 0) / angles.length;
  const variance = angles.reduce((s, a) => s + (a - mean) ** 2, 0) / angles.length;
  const std = Math.sqrt(variance);
  const confidence = Math.min(1, Math.max(0, 1 - std / 5));

  // Sprint34.26 debug: 输出按行检测的统计
  if (typeof console !== "undefined") {
    console.log(
      `%c[Sprint34.26][detectRegionRotation] points=${points.length} rows=${rows.length} angles=[${angles.map((a) => a.toFixed(2)).join(",")}] ` +
        `median=${median.toFixed(2)} conf=${confidence.toFixed(2)}`,
      "color:#f59e0b;",
    );
    const ys = points.map((p) => Math.round(p.y));
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    console.log(`  yRange=${yMin}~${yMax} span=${yMax - yMin} rowGap=${rowGap.toFixed(1)}`);
  }

  return { angle: Math.round(median * 10) / 10, confidence };
}

function computeConfidence(
  cluster: EditableBlock[],
  mode: string,
): number {
  if (mode === "mixed") return 0.9;
  if (mode === "printed") return 0.7;
  // handwritten only: 可能是只有手写签名的区域
  const text = cluster.map(b => extractText(b)).join(" ");
  if (matchesKeywords(text, SIGNATURE_KEYWORDS)) return 0.8;
  return 0.5;
}

// ────────────────────────────────────────────────────────────
// 导出
// ────────────────────────────────────────────────────────────

export { detectCompositeSignatureRegions };
