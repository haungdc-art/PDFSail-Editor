/**
 * scene-object-factory.ts — Scene Object Factory（Sprint-117）
 *
 * PM Mission：`consume(SceneContract) → produce(SceneObjects)`。
 * Factory 是 Scene Contract 与 Scene Object 实例之间的转化层。
 *
 * 职责：
 *   - Factory 可以依赖 PDF Adapter / OCR / Cache / Bitmap / Image Decoder
 *   - Scene Builder 永远不能依赖这些（只拿 SceneObject[] 后 draw()）
 *
 * 关键：
 *   - Builder 绝不查 pdf.js / decode bitmap / attach matrix —— 这些都是 Factory 职责。
 *   - 否则 Builder 变胖，分层失效。
 *
 * 链路：
 *   Scene Contract → Object Factory → Scene Object[] → Scene Builder(draw) → Painter → Reveal
 *
 * 纯函数 + 可注入数据源（ADR-005），Node 可测。
 */
import type { SceneContract } from "./scene-contract";

/** 实际可绘制的 Scene Object 实例（Builder 消费） */
export type SceneObject =
  | { kind: "PdfFallbackObject"; bitmap: unknown; width: number; height: number }
  | { kind: "GlyphObject"; text: string; x: number; y: number; fontSize: number }
  | { kind: "SignatureObject"; bitmap: unknown; rotation: number; x: number; y: number; width: number; height: number }
  | { kind: "DecorationObject"; bitmap?: unknown; x: number; y: number; width: number; height: number }
  | { kind: "ImageObject"; bitmap: unknown; x: number; y: number; width: number; height: number }
  | { kind: "TableObject"; rows: number; cols: number; bbox: { x: number; y: number; width: number; height: number } }
  | { kind: "AnnotationObject"; text: string; x: number; y: number }
  | { kind: "FormObject"; fields: number; bbox: { x: number; y: number; width: number; height: number } };

/** Factory 依赖的数据源（注入，避免硬编码 pdf.js） */
export interface SceneObjectDataSources {
  /** 获取位图（PdfFallback / Signature / Image / Decoration 的 bitmap） */
  getBitmap: (source?: string) => unknown;
  /** 获取 glyph 文本（GlyphObject） */
  getGlyphText: () => string;
  /** 获取表格结构（TableObject） */
  getTableShape: () => { rows: number; cols: number; bbox: { x: number; y: number; width: number; height: number } };
}

/** 根据 Contract 中一个 Object 规格，调用数据源，产出 SceneObject 实例 */
export function produceSceneObject(
  spec: { type: SceneContract["objects"][number]["type"]; count?: number; rotation?: number; source?: string },
  sources: SceneObjectDataSources,
): SceneObject {
  switch (spec.type) {
    case "PdfFallbackObject":
      return { kind: "PdfFallbackObject", bitmap: sources.getBitmap(spec.source), width: 595, height: 842 };
    case "GlyphObject":
      return { kind: "GlyphObject", text: sources.getGlyphText(), x: 0, y: 0, fontSize: 12 };
    case "SignatureObject": {
      const shape = sources.getTableShape(); // 复用尺寸（简化）
      return { kind: "SignatureObject", bitmap: sources.getBitmap(spec.source), rotation: spec.rotation ?? 0, x: 0, y: 0, width: shape.bbox.width, height: shape.bbox.height };
    }
    case "DecorationObject":
      return { kind: "DecorationObject", bitmap: sources.getBitmap(spec.source), x: 0, y: 0, width: 40, height: 20 };
    case "ImageObject":
      return { kind: "ImageObject", bitmap: sources.getBitmap(spec.source), x: 0, y: 0, width: 100, height: 100 };
    case "TableObject": {
      const t = sources.getTableShape();
      return { kind: "TableObject", rows: t.rows, cols: t.cols, bbox: t.bbox };
    }
    case "AnnotationObject":
      return { kind: "AnnotationObject", text: "annotation", x: 0, y: 0 };
    case "FormObject":
      return { kind: "FormObject", fields: 0, bbox: { x: 0, y: 0, width: 0, height: 0 } };
  }
}

/** Factory 入口：consume(SceneContract) → produce(SceneObject[]) */
export function consumeSceneContract(
  contract: SceneContract,
  sources: SceneObjectDataSources,
): SceneObject[] {
  const objects: SceneObject[] = [];
  for (const spec of contract.objects) {
    for (let i = 0; i < (spec.count ?? 1); i++) {
      objects.push(produceSceneObject(spec, sources));
    }
  }
  return objects;
}
