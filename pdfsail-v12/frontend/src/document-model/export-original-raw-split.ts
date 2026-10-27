/**
 * export-original-raw-split.ts — P0-EXPORT-FONT-2 ① · original-raw / fallback 分片（纯函数）
 *
 * ══ 背景（FONT-1 判定 B + forensic 证据链）═════════════════════════════
 *   编辑行的字符分两类：
 *     · original glyph：import 时由原 PDF 对象图直接写入
 *       `pdfCharCode`（原 CID）+ `pdfTransform`（原矩阵）—— **第一手事实**
 *     · new glyph：用户插入的字符（如「长」），原字体子集里**本来就没有**
 *       ⇒ 无 pdfCharCode ⇒ 只能走 fallback CID（NotoSansSC 等）
 *
 *   现状缺陷：`planCidCoverageRuns` 的 `sources` 里没有原字体（fontkit 无法解析
 *   CID Type0 subset ⇒ `createCidFontSource` = null）⇒ **整行**被 fallback covers()
 *   接管 ⇒ 导出 PDF 该行字体 = NotoSansSC ⇒ provenance 在产物中不可恢复
 *   ⇒ reload 后 replay 门控（fontIdentity.fontRef）失败 ⇒ R-A anchor×2 + L3 + R-C。
 *
 * ══ 本模块的职责（用户裁决的收窄）═════════════════════════════════════
 *   在 glyph 层把一行切分为有序 run：
 *
 *     Line
 *      ├─ run(kind="original-raw")  ← 原 glyph 原样直发（emitRawCidGlyphs 路径）
 *      │     · pdfCharCode / pdfTransform / x / y **逐字节保留**
 *      │     · 不经过 fontkit、不经过 assembleCidFont、不重新编码
 *      └─ run(kind="fallback")      ← 新字符拼接成 text，交给既有 fallback pipeline
 *            · 覆盖度分片仍由 planCidCoverageRuns 负责（**本模块不做** covers 判定）
 *
 *   ⚠️ Planner（planCidCoverageRuns）**零改动**；fallback covers() 行为**零改动**；
 *      本模块只回答「哪些字符属于哪一类」，不决定字体资产。
 *
 * ══ 几何不变量（FONT-2 验收硬条件）════════════════════════════════════
 *   original-raw run 内：
 *     ΔpdfCharCode = 0 · ΔpdfTransform = 0 · Δx = 0 · Δy = 0
 *   （新字符使用 fallback 的真实 advance，不要求满足原字体 advance）
 *
 * 硬边界：0 DOM / 0 React / 0 fontkit / 0 pdf-lib / 0 Core import。
 */

/** 一行中的一个 glyph（只取本模块需要的最小投影；与 EditableGlyph 字段兼容） */
export interface OriginalRawGlyphInput {
  readonly char: string;
  /** 原 PDF CID（import 时写入；新字符没有 ⇒ undefined） */
  readonly pdfCharCode?: number;
  /** 原 PDF 文本矩阵（import 时写入；与 pdfCharCode 同生共死） */
  readonly pdfTransform?: readonly number[];
}

/** original-raw run：原 glyph 原样直发（raw-CID） */
export interface OriginalRawRun {
  readonly kind: "original-raw";
  /** ★ 输入 glyph 的**原样引用投影**：cid/transform/x/y 不得有任何换算 */
  readonly glyphs: ReadonlyArray<{
    readonly char: string;
    readonly cid: number;
    readonly transform: readonly number[];
  }>;
}

/** fallback run：新字符文本，交给既有 planCidCoverageRuns / assembleCidFont */
export interface FallbackRun {
  readonly kind: "fallback";
  readonly text: string;
}

export type OriginalRawSplitRun = OriginalRawRun | FallbackRun;

/** 单字符分类：有完整 raw-CID 事实 ⇒ original；否则 ⇒ fallback */
export function classifyGlyphForExport(g: OriginalRawGlyphInput): "original-raw" | "fallback" {
  return typeof g.pdfCharCode === "number" &&
    Number.isFinite(g.pdfCharCode) &&
    Array.isArray(g.pdfTransform) &&
    g.pdfTransform.length === 6 &&
    g.pdfTransform.every((n) => Number.isFinite(n))
    ? "original-raw"
    : "fallback";
}

/**
 * 把一行 glyph 切分为有序 run。
 *
 * ★ 规则：
 *   · 相邻同类字符合并为一个 run（run 顺序 = 字符顺序，不重排）
 *   · original-raw run 的 cid/transform 是**输入的原样值**（几何不变量）
 *   · fallback run 的 text 是**字符拼接**（覆盖度分片交给 planner）
 *   · 孤立/残缺 pdfTransform ⇒ 按 fallback 处理（fail-open 到既有管线，绝不猜 CID）
 */
export function splitOriginalRawRuns(
  glyphs: readonly OriginalRawGlyphInput[]
): OriginalRawSplitRun[] {
  const runs: OriginalRawSplitRun[] = [];
  let rawBuf: Array<{ char: string; cid: number; transform: readonly number[] }> = [];
  let fbBuf = "";

  const flush = (): void => {
    if (rawBuf.length > 0) {
      runs.push({ kind: "original-raw", glyphs: rawBuf });
      rawBuf = [];
    }
    if (fbBuf.length > 0) {
      runs.push({ kind: "fallback", text: fbBuf });
      fbBuf = "";
    }
  };

  for (const g of glyphs) {
    if (classifyGlyphForExport(g) === "original-raw") {
      if (fbBuf.length > 0) flush(); // 类别切换：先收尾 fallback 段
      rawBuf.push({
        char: g.char,
        cid: g.pdfCharCode!,
        transform: g.pdfTransform as readonly number[],
      });
    } else {
      if (rawBuf.length > 0) flush(); // 类别切换：先收尾 raw 段
      fbBuf += g.char;
    }
  }
  flush();
  return runs;
}

/**
 * 便于验收的摘要：各 kind 的字符数 /「长」计数。
 * （FONT-2 验证矩阵用：rawCIDCount = N · fallbackCount = M，而非 N+M 全进 fallback）
 */
export function summarizeSplit(runs: readonly OriginalRawSplitRun[]): {
  originalRawGlyphs: number;
  fallbackChars: number;
  runCount: number;
  order: Array<"original-raw" | "fallback">;
} {
  let originalRawGlyphs = 0;
  let fallbackChars = 0;
  const order: Array<"original-raw" | "fallback"> = [];
  for (const r of runs) {
    order.push(r.kind);
    if (r.kind === "original-raw") originalRawGlyphs += r.glyphs.length;
    else fallbackChars += r.text.length;
  }
  return { originalRawGlyphs, fallbackChars, runCount: runs.length, order };
}
