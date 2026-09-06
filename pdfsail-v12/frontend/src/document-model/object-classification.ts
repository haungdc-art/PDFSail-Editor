/**
 * object-classification.ts — Object Classification Engine（Sprint-113/114）
 *
 * PM Mission：Raw Inventory 里每个 Raw Object 到底属于哪个 Scene Object。
 * 返回 **SceneIntent**（{kind, confidence}），而非裸 type ——
 * 这样 Classification 未来升级为 ML/LLM/Vision 时，Scene Builder 无需改动（永远消费 SceneIntent）。
 *
 * 流程：Raw Inventory → Raw Object → Object Classification → SceneIntent → Scene Builder → Scene Object
 *
 * 分类依据（几何启发 + 签名标记，第一版）：
 *   - 全页大图（coverage≥90%）→ pdf-fallback
 *   - 签名（rotation/标记）→ signature
 *   - 页眉/页脚小图 → decoration
 *   - 正文内嵌 → image
 *
 * 纯函数（ADR-005），Node 可测。
 */

/** Scene Object 类型（PM 定义） */
export type ClassifiedObjectType =
  | "glyph"
  | "vector"
  | "pdf-fallback"
  | "signature"
  | "decoration"
  | "image"
  | "annotation";

/**
 * SceneIntent —— Classification 输出（PM 定义）。
 * Scene Builder 只消费 SceneIntent，不关心分类如何实现。
 */
export interface SceneIntent {
  readonly kind: ClassifiedObjectType;
  /** 置信度 0~1 */
  readonly confidence: number;
  readonly reason: string;
}

/** Raw Image 元数据（供分类） */
export interface RawImageMeta {
  bbox: { x: number; y: number; width: number; height: number };
  pageSize: { width: number; height: number };
  isSignature?: boolean;
  rotation?: number;
}

/** 分类 Raw Image → SceneIntent（kind + confidence） */
export function classifyRawImage(meta: RawImageMeta): SceneIntent {
  const { bbox, pageSize } = meta;
  const pageW = pageSize.width, pageH = pageSize.height;
  if (pageW <= 0 || pageH <= 0) return { kind: "image", confidence: 0.3, reason: "page size unknown" };

  const coverage = (bbox.width * bbox.height) / (pageW * pageH);

  // 1) 全页大图（≥90%）→ pdf-fallback（扫描位图/整页背景）。置信度高因几何确定性。
  if (coverage >= 0.9) {
    return { kind: "pdf-fallback", confidence: 0.95, reason: `full-page bitmap (coverage ${(coverage * 100).toFixed(0)}%)` };
  }
  // 2) 签名 → signature（有 rotation 或 isSignature 标记）。置信度 0.85（几何不确定，依赖标记）。
  if (meta.isSignature || (meta.rotation !== undefined && Math.abs(meta.rotation) > 0.001)) {
    return { kind: "signature", confidence: 0.85, reason: "detected signature (rotation or marker)" };
  }
  // 3) 页眉/页脚小图 → decoration。置信度较低（0.6，可能误判正文小图）。
  const inHeader = bbox.y < pageH * 0.1 && bbox.height < pageH * 0.2;
  const inFooter = bbox.y + bbox.height > pageH * 0.9 && bbox.height < pageH * 0.2;
  if ((inHeader || inFooter) && coverage < 0.2) {
    return { kind: "decoration", confidence: 0.6, reason: `header/footer decoration (y=${bbox.y.toFixed(0)})` };
  }
  // 4) 其余 → image（内嵌照片/内容图）。置信度 0.5（最不确定，需更多特征）。
  return { kind: "image", confidence: 0.5, reason: `embedded image (coverage ${(coverage * 100).toFixed(0)}%)` };
}

/** SceneIntent 聚合 → ExpectedScene 计数（供 Completeness） */
export function intentsToExpected(intents: readonly SceneIntent[]): Record<string, number> {
  const out: Record<string, number> = {
    glyph: 0, vector: 0, "pdf-fallback": 0, signature: 0, decoration: 0, image: 0, annotation: 0,
  };
  for (const i of intents) out[i.kind] = (out[i.kind] ?? 0) + 1;
  return out;
}
