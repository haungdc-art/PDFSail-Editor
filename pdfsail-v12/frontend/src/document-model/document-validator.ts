/**
 * document-validator.ts — Document Validator（Sprint-118）
 *
 * PM Mission：当前 Document 是不是完整 Document？（不是 Editable Text，而是完整 Document Scene）
 * 这是 Builder 之前的 Gate：Document Builder → Document Validator(PASS?) → Scene Contract → Factory → Builder
 *
 * 关键：Builder 不应该负责检查 Header/Footer/Logo/图片 —— 这些在 Builder 之前全部检查完。
 * 如果 Document 不完整（如 Header Missing），Builder 根本不应启动。
 *
 * 注意：Document Completeness ≠ Scene Completeness。
 *   - Scene Completeness：验证 Scene Builder 是否按 Contract 建好（Builder 之后）
 *   - Document Completeness：验证 Document Builder 是否生成完整 Document（Builder 之前）
 *
 * 纯函数（ADR-005），Node 可测。
 */

/** Document 中用户可感知的完整对象清单 */
export interface DocumentCompleteness {
  header: boolean;
  footer: boolean;
  background: boolean;
  glyph: boolean;
  signature: boolean;
  image: boolean;
  decoration: boolean;
  annotation: boolean;
  form: boolean;
}

/** Document Validator 结果 */
export interface DocumentValidation {
  /** 各对象是否存在 */
  completeness: DocumentCompleteness;
  /** 缺失对象列表 */
  missing: (keyof DocumentCompleteness)[];
  /** 是否完整（无缺失） */
  pass: boolean;
  /** 完整度 0~100 */
  ratio: number;
}

/** 需要检查的 Document 对象类别 */
const CATEGORIES: (keyof DocumentCompleteness)[] = [
  "header", "footer", "background", "glyph", "signature", "image", "decoration", "annotation", "form",
];

/**
 * 验证 Document 是否完整。
 * @param doc Document 对象（含 pages/blocks/objects）
 * @param opts 如何判断每类对象存在（注入检测函数，允许不同 Document 结构）
 */
export function validateDocument(
  doc: { pages?: any[] } | null,
  detector: (doc: any, category: keyof DocumentCompleteness) => boolean,
): DocumentValidation {
  const completeness: DocumentCompleteness = {
    header: false, footer: false, background: false, glyph: false,
    signature: false, image: false, decoration: false, annotation: false, form: false,
  };
  for (const cat of CATEGORIES) {
    completeness[cat] = !!doc && detector(doc, cat);
  }
  const missing = CATEGORIES.filter((c) => !completeness[c]);
  const present = CATEGORIES.filter((c) => completeness[c]).length;
  const ratio = Math.round((present / CATEGORIES.length) * 1000) / 10;
  return { completeness, missing, pass: missing.length === 0, ratio };
}

/** 默认 detector：基于 Document 的 blocks 类型判断（当前 Document Builder 只生成 text block） */
export function defaultDocumentDetector(doc: any, category: keyof DocumentCompleteness): boolean {
  const pages = doc?.pages ?? [];
  const blocks: any[] = [];
  for (const pg of pages) for (const blk of pg.blocks ?? []) blocks.push(blk);

  // 统计文本 glyph（正文）
  let glyphCount = 0;
  for (const blk of blocks) for (const ln of blk.lines ?? []) glyphCount += ln.glyphs?.length ?? 0;

  switch (category) {
    case "glyph": return glyphCount > 0;
    // 当前 Document Builder 只生成 text block —— header/footer/background/image 等都不存在
    case "header": return blocks.some((b) => (b.regionType ?? b.type) === "header");
    case "footer": return blocks.some((b) => (b.regionType ?? b.type) === "footer");
    case "background": return blocks.some((b) => b.type === "image" || b.type === "background" || b.type === "pdf-fallback");
    case "signature": return blocks.some((b) => (b.regionType ?? b.type) === "signature");
    case "image": return blocks.some((b) => b.type === "image");
    case "decoration": return blocks.some((b) => (b.regionType ?? b.type) === "decoration");
    case "annotation": return blocks.some((b) => b.type === "annotation" || b.type === "comment");
    case "form": return blocks.some((b) => b.type === "form");
  }
}

/** 把 Document 的原始统计包装为 detector 可用的结构（简化入口） */
export function completenessFromCounts(counts: Partial<Record<keyof DocumentCompleteness, number>>): DocumentCompleteness {
  const out = { header: false, footer: false, background: false, glyph: false, signature: false, image: false, decoration: false, annotation: false, form: false } as DocumentCompleteness;
  for (const k of CATEGORIES) out[k] = (counts[k] ?? 0) > 0;
  return out;
}
