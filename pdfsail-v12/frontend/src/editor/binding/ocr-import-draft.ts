/**
 * ocr-import-draft.ts — Manual OCR → Core Migration · Step 2a
 *（契约：docs/architecture/manual-ocr-core-migration-contract.md §4，Rev 0.3 定型 / Rev 0.4 实现）
 *
 * 归一化管线的**唯一实现**（顺序严格 = 契约约束 7）：
 *
 *   Raw OCR blocks（useOCR runInlineOCR 产物，Canvas Space，无 source）
 *     ↓ ① granularity       （G=word 默认；L1/L2/L3 fallback；intra-granularity 精确去重）
 *     ↓ ② cross-granularity （超集-子集消除：行/词双重表示只留选定粒度）
 *     ↓ ③ geometric merge   （同文本 + 重叠/近贴合并；跨列 gap 绝不桥接；不同文本绝不拼接）
 *     ↓ ④ identity          （source:"ocr" + deterministic id = "ocr_" + FNV-1a 64 → base36）
 *     ↓ ⑤ geometry validate （Canvas Space 边界：部分越界 clamp、>50% 越界 drop）
 *     ↓
 *   NormalizedOcrDraft  ← intermediate semantic draft（**不是** Core object）
 *
 * ── 红线（契约 §4.5 约束 9 + 用户边界）──────────────────────────────
 *   · 本模块产出 **intermediate draft**，绝不停在这里之后：
 *     不产生 Core object、不触碰 EditorDocument / Command / History / docBlocks / useOCR。
 *     （§5 Core Object Contract = Step 2b；§6 Command = Step 2c，均未实现。）
 *   · 纯函数、确定性：无随机 id（raw 的 uuid id 一律忽略重派）、无时间、无 DOM。
 *   · fail-safe：无法证明「超集/重复」关系时**保留**原 block（绝不静默丢文本——
 *     静默丢文本正是本迁移要修的 bug，宁重复不丢失）。
 *
 * ── OQ 缺省值（契约 §12，provisional，均具名常量可复核）────────────
 *   OQ1 gap_thresh      → OCR_MERGE_GAP_PX = 4（列间隙 ≫ 此值，绝不误桥接）
 *   OQ2 CJK 检测        → Unicode Script：Han / Hiragana / Katakana / Hangul（无空格脚本）
 *   OQ3 τ_conf / τ_count → OCR_TAU_CONF = 35（tesseract 0-100 刻度，与 useOCR 过滤同源）、
 *                          OCR_TAU_COUNT = 64（Step 1 E1：W3 10 词不得触发）
 *   OQ4 id 哈希         → FNV-1a 64（UTF-16 code unit 流）→ base36；坐标 round 取整
 *   OQ5 越界边界        → 与 Canvas 交集 < 50% 面积 drop，否则 clamp
 *   OQ6 旋转            → rotation 恒 0（OCR 不产生旋转；raw 无 rotation 字段）
 *   OQ7 page 基准       → raw.page **原样透传**（1-based 映射待 §5 与 Core 收口，本层不猜）
 */

// ── 输入（契约 §4.3：W3/W4 raw block 形状，结构化最小面）─────────────

/** Raw OCR block（useOCR `runInlineOCR` 产物形状；额外字段如 type/id 会被忽略）。 */
export interface OcrImportRawBlock {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  page: number;
  /** 引擎置信度（0-100 刻度，可选；仅 L2 判定消费，缺失则跳过置信条件）。 */
  confidence?: number;
}

/** Canvas Space（top-left / y-down / px）页面边界（契约 C3：只校验/裁剪，不做坐标转换）。 */
export interface OcrImportCanvas {
  width: number;
  height: number;
}

// ── 输出（契约 §4.5 schema，逐字段一致）─────────────────────────────

/** Normalized OCR Draft item = intermediate semantic draft，NOT final Core object。 */
export interface NormalizedOcrDraftItem {
  source: "ocr";
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  page: number;
  rotation: 0;
  id: string;
}

export type OcrGranularity = "word" | "line";
export type OcrGranularityReason =
  | "empty"
  | "default-word"
  | "L1-cjk-no-space"
  | "L2-quality"
  | "L3-line-only";

export interface NormalizedOcrDraft {
  granularity: OcrGranularity;
  granularityReason: OcrGranularityReason;
  items: NormalizedOcrDraftItem[];
  dropped: {
    /** F5：空文本 / 纯空白。 */
    emptyText: number;
    /** 非有限 / 非正几何。 */
    invalidGeometry: number;
    /** ① 同粒度 文本+几何 精确重复（F7）。 */
    dedupedExact: number;
    /** ② 未选定粒度层级的超集/子集。 */
    crossGranularity: number;
    /** ③ 被合并吸收的重复变体（F4）。 */
    mergedAway: number;
    /** ⑤ 完全/过半越界。 */
    outOfBounds: number;
  };
}

// ── OQ 缺省常量（provisional）──────────────────────────────────────

/** OQ1：③ 合并允许的最大水平近贴间隙 px（重叠为负间隙恒 ≤ 此值；列间隙 ≫ 此值）。 */
export const OCR_MERGE_GAP_PX = 4;
/** OQ3：词级平均置信下限（tesseract 0-100 刻度，与 useOCR 的 >35 过滤同源）。 */
export const OCR_TAU_CONF = 35;
/** OQ3：词块数上限（超过且存在行级 → L2）。Step 1 E1 的 W3=10 词必须不触发。 */
export const OCR_TAU_COUNT = 64;
/** 子集包含判定：B 落入 A 的面积比例下限。 */
export const OCR_CONTAINMENT_RATIO = 0.9;
/** OQ5：与 Canvas 交集面积比例低于此值 → drop，否则 clamp。 */
export const OCR_OUT_OF_BOUNDS_DROP_RATIO = 0.5;
/** ③ 合并的同行-run 判定：垂直重叠 ≥ min(h) × 此值。 */
export const OCR_MERGE_VERTICAL_OVERLAP_RATIO = 0.5;

// ── 内部几何 / 文本工具（纯，零 DOM）────────────────────────────────

interface RawBox {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  page: number;
  confidence?: number;
  lineClass: boolean;
}

const areaOf = (b: { w: number; h: number }): number => Math.max(b.w, 0) * Math.max(b.h, 0);

function intersectionArea(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): number {
  const l = Math.max(a.x, b.x);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const t = Math.max(a.y, b.y);
  const bo = Math.min(a.y + a.h, b.y + b.h);
  return l < r && t < bo ? (r - l) * (bo - t) : 0;
}

/** contains(A,B)：B ≥90% 落入 A 且 B 严格更小（防同尺寸互包含）。 */
function contains(a: RawBox, b: RawBox): boolean {
  const bArea = areaOf(b);
  if (bArea <= 0 || areaOf(a) <= bArea) return false;
  return intersectionArea(a, b) / bArea >= OCR_CONTAINMENT_RATIO;
}

/** 内部空白（首尾空白不算）：词级 block 不含内部空白，行级通常含。 */
function hasInternalWhitespace(text: string): boolean {
  return /\S\s+\S/.test(text);
}

/** OQ2：CJK / 无空格脚本检测（Han / Hiragana / Katakana / Hangul）。 */
function containsCjkScript(text: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
}

/** 空白不敏感归一（超集文本比对口径：join("") 与含空格变体等价）。 */
function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

/** FNV-1a 64（UTF-16 code unit 流）→ base36。OQ4：确定性、非随机、跨输入幂等。 */
function fnv1a64Base36(input: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(36);
}

const r = (v: number): number => Math.round(v);

// ── ① granularity ──────────────────────────────────────────────────

/** 行级分类：内部空白 或 几何容器（同页包含 ≥2 个其他更小 block ≥90%）。 */
function classifyLineLevel(blocks: RawBox[]): void {
  for (const a of blocks) {
    if (hasInternalWhitespace(a.text)) {
      a.lineClass = true;
      continue;
    }
    let contained = 0;
    for (const b of blocks) {
      if (b === a || b.page !== a.page) continue;
      if (contains(a, b)) contained += 1;
      if (contained >= 2) break;
    }
    a.lineClass = contained >= 2;
  }
}

function selectGranularity(
  blocks: readonly RawBox[]
): { granularity: OcrGranularity; reason: OcrGranularityReason } {
  if (blocks.length === 0) return { granularity: "word", reason: "empty" };
  const lineBlocks = blocks.filter((b) => b.lineClass);
  const wordBlocks = blocks.filter((b) => !b.lineClass);
  const anyInternalWhitespace = blocks.some((b) => hasInternalWhitespace(b.text));

  // L1：CJK / 无空格脚本 且 无词间空格 → 词分割退化。
  if (!anyInternalWhitespace && blocks.some((b) => containsCjkScript(b.text))) {
    return { granularity: "line", reason: "L1-cjk-no-space" };
  }
  // L2：词级质量不足（置信均值 < τ_conf）或（词块数 > τ_count 且存在行级）。
  const confidences = wordBlocks
    .map((b) => b.confidence)
    .filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  const lowConfidence = confidences.length > 0 && confidences.reduce((s, c) => s + c, 0) / confidences.length < OCR_TAU_CONF;
  if (lowConfidence || (wordBlocks.length > OCR_TAU_COUNT && lineBlocks.length > 0)) {
    return { granularity: "line", reason: "L2-quality" };
  }
  // L3：无词级层级（引擎仅出行）。
  if (wordBlocks.length === 0) {
    return { granularity: "line", reason: "L3-line-only" };
  }
  return { granularity: "word", reason: "default-word" };
}

// ── ② cross-granularity（超集-子集消除，fail-safe）──────────────────

/** 行 block 按 y 带 + x 排序后的空白不敏感拼接（超集文本比对口径）。 */
function concatTextOfSorted(blocks: RawBox[]): string {
  const sorted = [...blocks].sort((a, b) => a.y - b.y || a.x - b.x);
  // y 接近的归同一带再按 x 排（同基线词序）。
  const bands: RawBox[][] = [];
  for (const b of sorted) {
    const band = bands[bands.length - 1];
    if (band) {
      const bandTop = Math.min(...band.map((x) => x.y));
      const tol = Math.max(4, Math.min(band[0].h, b.h) * 0.6);
      if (Math.abs(b.y - bandTop) <= tol) {
        band.push(b);
        continue;
      }
    }
    bands.push([b]);
  }
  return bands.map((band) => band.sort((p, q) => p.x - q.x).map((x) => stripWhitespace(x.text)).join("")).join("");
}

function crossGranularityDedupe(blocks: RawBox[], granularity: OcrGranularity): { kept: RawBox[]; dropped: number } {
  const kept: RawBox[] = [];
  let dropped = 0;
  if (granularity === "word") {
    // G=word：丢弃「词级超集」行级 block（E1）。仅当 文本拼接精确匹配 + 几何包含 ≥2 词
    // 才判定冗余；不匹配则保留（fail-safe，宁重复不丢文本）。
    const words = blocks.filter((b) => !b.lineClass);
    for (const b of blocks) {
      if (!b.lineClass) {
        kept.push(b);
        continue;
      }
      const inside = words.filter((w) => w.page === b.page && contains(b, w));
      const isSuperset = inside.length >= 1 && stripWhitespace(b.text) === concatTextOfSorted(inside);
      if (isSuperset) dropped += 1;
      else kept.push(b);
    }
    return { kept, dropped };
  }
  // G=line：丢弃「行级子集」词级 block（几何包含 + 文本子串双条件，fail-safe）。
  const lines = blocks.filter((b) => b.lineClass);
  for (const b of blocks) {
    if (b.lineClass) {
      kept.push(b);
      continue;
    }
    const host = lines.find((l) => l.page === b.page && contains(l, b) && stripWhitespace(l.text).includes(stripWhitespace(b.text)));
    if (host) dropped += 1;
    else kept.push(b);
  }
  return { kept, dropped };
}

// ── ③ geometric merge（仅 重叠/近贴 + 同文本；绝不语义拼接）─────────

function horizontalGap(a: RawBox, b: RawBox): number {
  return Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w));
}

function verticalOverlapRatio(a: RawBox, b: RawBox): number {
  const ov = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const minH = Math.min(a.h, b.h);
  return minH > 0 ? Math.max(ov, 0) / minH : 0;
}

function geometricMerge(blocks: RawBox[]): { kept: RawBox[]; mergedAway: number } {
  const groups = new Map<string, RawBox[]>();
  for (const b of blocks) {
    const key = `${b.page}|${b.text}`;
    const g = groups.get(key);
    if (g) g.push(b);
    else groups.set(key, [b]);
  }
  const kept: RawBox[] = [];
  let mergedAway = 0;
  for (const group of groups.values()) {
    // 迭代到不动点：近贴/重叠链逐个吸收（union bbox + max fontSize）。
    const pending = [...group];
    while (pending.length > 0) {
      const base = pending.shift()!;
      let changed = true;
      while (changed) {
        changed = false;
        for (let i = 0; i < pending.length; i++) {
          const c = pending[i];
          if (horizontalGap(base, c) <= OCR_MERGE_GAP_PX && verticalOverlapRatio(base, c) >= OCR_MERGE_VERTICAL_OVERLAP_RATIO) {
            const x = Math.min(base.x, c.x);
            const y = Math.min(base.y, c.y);
            base.w = Math.max(base.x + base.w, c.x + c.w) - x;
            base.h = Math.max(base.y + base.h, c.y + c.h) - y;
            base.x = x;
            base.y = y;
            base.fontSize = Math.max(base.fontSize, c.fontSize);
            pending.splice(i, 1);
            mergedAway += 1;
            changed = true;
            break;
          }
        }
      }
      kept.push(base);
    }
  }
  return { kept, mergedAway };
}

// ── ⑤ geometry validation（C3 guard：clamp / drop，不做坐标转换）───

interface ValidatedBox {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  page: number;
}

function validateGeometry(blocks: readonly RawBox[], canvas: OcrImportCanvas): { kept: ValidatedBox[]; dropped: number } {
  const kept: ValidatedBox[] = [];
  let dropped = 0;
  for (const b of blocks) {
    const area = areaOf(b);
    const cl = Math.max(b.x, 0);
    const ct = Math.max(b.y, 0);
    const cr = Math.min(b.x + b.w, canvas.width);
    const cb = Math.min(b.y + b.h, canvas.height);
    const clipped = cr > cl && cb > ct ? (cr - cl) * (cb - ct) : 0;
    // 完全越界 / 过半越界 → drop（OQ5）；部分越界 → clamp。
    if (area <= 0 || clipped / area < OCR_OUT_OF_BOUNDS_DROP_RATIO) {
      dropped += 1;
      continue;
    }
    kept.push({
      text: b.text,
      x: cl,
      y: ct,
      width: cr - cl,
      height: cb - ct,
      fontSize: b.fontSize,
      page: b.page,
    });
  }
  return { kept, dropped };
}

// ── 主入口（管线顺序严格 = 契约约束 7）──────────────────────────────

/**
 * Raw OCR blocks → NormalizedOcrDraft（intermediate semantic draft）。
 *
 * ⛔ 管线终点即本函数返回值：不产生 Core object、不触碰 EditorDocument /
 * Command / History / docBlocks（§5 = Step 2b、§6 = Step 2c，另行收口）。
 */
export function normalizeOcrImportDraft(
  raw: readonly OcrImportRawBlock[],
  canvas: OcrImportCanvas
): NormalizedOcrDraft {
  const dropped = {
    emptyText: 0,
    invalidGeometry: 0,
    dedupedExact: 0,
    crossGranularity: 0,
    mergedAway: 0,
    outOfBounds: 0,
  };

  // 0/F5 intake：空文本 / 非有限几何在最早丢弃。
  const intake: RawBox[] = [];
  for (const b of raw) {
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (!text) {
      dropped.emptyText += 1;
      continue;
    }
    const finite = [b.x, b.y, b.w, b.h, b.fontSize].every((v) => typeof v === "number" && Number.isFinite(v));
    if (!finite || b.w <= 0 || b.h <= 0) {
      dropped.invalidGeometry += 1;
      continue;
    }
    intake.push({
      text,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      fontSize: b.fontSize,
      page: typeof b.page === "number" && Number.isFinite(b.page) ? b.page : 0,
      confidence: b.confidence,
      lineClass: false,
    });
  }

  // ① granularity：L1/L2/L3 fallback + intra-granularity 精确去重。
  classifyLineLevel(intake);
  const { granularity, reason } = selectGranularity(intake);
  const seen = new Set<string>();
  const afterExact: RawBox[] = [];
  for (const b of intake) {
    const key = `${b.page}|${b.text}|${r(b.x)}|${r(b.y)}|${r(b.w)}|${r(b.h)}`;
    if (seen.has(key)) {
      dropped.dedupedExact += 1;
      continue;
    }
    seen.add(key);
    afterExact.push(b);
  }

  // ② cross-granularity dedupe（超集-子集消除）。
  const afterCross = crossGranularityDedupe(afterExact, granularity);
  dropped.crossGranularity = afterCross.dropped;

  // ③ geometric merge（同文本 + 重叠/近贴；跨列 gap / 不同文本绝不合并）。
  const afterMerge = geometricMerge(afterCross.kept);
  dropped.mergedAway = afterMerge.mergedAway;

  // ④ identity：source:"ocr" + deterministic id（raw 的 uuid id 一律忽略重派）。
  //    id 在 clamp 前派生（契约顺序 ④→⑤；同 raw 输入 ⇒ 同 id，幂等可重跑）。
  const withIds = afterMerge.kept.map((b) => {
    const canonical = ["ocr", String(b.page), b.text, r(b.x), r(b.y), r(b.w), r(b.h), r(b.fontSize)].join("|");
    return { box: b, id: `ocr_${fnv1a64Base36(canonical)}` };
  });

  // ⑤ geometry validation（Canvas Space clamp / drop）。
  const validated = validateGeometry(
    withIds.map((w) => w.box),
    canvas
  );
  dropped.outOfBounds = validated.dropped;
  const idByIndex = new Map<number, string>();
  let vi = 0;
  for (let i = 0; i < withIds.length; i++) {
    const b = withIds[i].box;
    const cr = Math.min(b.x + b.w, canvas.width);
    const cb = Math.min(b.y + b.h, canvas.height);
    const cl = Math.max(b.x, 0);
    const ct = Math.max(b.y, 0);
    const clipped = cr > cl && cb > ct ? (cr - cl) * (cb - ct) : 0;
    const survives = areaOf(b) > 0 && clipped / areaOf(b) >= OCR_OUT_OF_BOUNDS_DROP_RATIO;
    if (survives) {
      idByIndex.set(vi, withIds[i].id);
      vi += 1;
    }
  }

  const items: NormalizedOcrDraftItem[] = validated.kept.map((b, i) => ({
    source: "ocr",
    text: b.text,
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    fontSize: b.fontSize,
    page: b.page,
    rotation: 0,
    id: idByIndex.get(i) ?? `ocr_${fnv1a64Base36(["ocr", String(b.page), b.text, r(b.x), r(b.y), r(b.width), r(b.height), r(b.fontSize)].join("|"))}`,
  }));

  return { granularity, granularityReason: reason, items, dropped };
}
