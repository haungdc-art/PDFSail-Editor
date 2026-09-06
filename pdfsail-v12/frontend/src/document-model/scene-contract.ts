/**
 * scene-contract.ts — Scene Contract Definition（Sprint-116）
 *
 * PM Mission：定义 Scene Contract —— 连接 Scene Inventory（业务语言）与 Scene Builder（工程语言）的契约。
 * Scene Builder 是纯消费层，只认识工程类型（PdfFallbackObject 等），
 * 永远不知道 Background / Signature 等业务术语。
 *
 * 链路：
 *   Raw Inventory → Object Classification → Scene Inventory → **Scene Contract** → Scene Builder → Painter → Reveal
 *
 * 为什么必须有这一层：
 *   - 否则 Builder 会写 `if (background) create PdfFallback` 这种业务逻辑（应禁止）
 *   - Builder 只 `consume(SceneContract)`，完全不知道 Inventory/Classification/PDF/OCR
 *   - 以后 AI Document / Workspace / PPT / Word / Excel 共享同一 Scene Builder
 *
 * 纯类型 + 纯函数（ADR-005），Node 可测。
 */

/** 工程 Scene Object 类型（Scene Builder 唯一认识的语言） */
export type SceneObjectType =
  | "PdfFallbackObject"   // 页面光栅底图（扫描件/背景）—— 取代 "background"
  | "GlyphObject"         // 文本 glyph
  | "SignatureObject"     // 签名
  | "DecorationObject"    // 页眉/页脚/logo/装饰
  | "ImageObject"         // 内嵌照片
  | "TableObject"         // 表格结构
  | "AnnotationObject"    // 标注
  | "FormObject";         // 表单

/** Scene Contract 中单个对象的规格 */
export interface SceneObjectSpec {
  /** 工程类型（Builder 唯一认识的） */
  type: SceneObjectType;
  /** 创建者（Owner）—— 当前为 PDF Adapter */
  owner: "PDFAdapter" | "OCR" | "User" | "System";
  /** 是否 Blocking（影响 Reveal Gate：Blocking 对象 ready 才 Reveal） */
  blocking: boolean;
  /** 是否 Required（Required + Blocking 缺失则不能 Reveal） */
  required: boolean;
  /** 期望数量（可选） */
  count?: number;
  /** 旋转角度（Signature 等） */
  rotation?: number;
  /** 来源 Raw 引用（如 Raw Image #3） */
  source?: string;
  /** 描述 */
  note?: string;
}

/** Scene Contract —— 一个页面完整构建所需的全部 Scene Object 规格 */
export interface SceneContract {
  readonly page: number;
  readonly objects: readonly SceneObjectSpec[];
}

/** 空 Scene Contract */
export const EMPTY_SCENE_CONTRACT: SceneContract = { page: 1, objects: [] };

/** 业务 Scene Inventory 计数（Sprint-115 输出） */
export interface SceneInventoryCounts {
  glyph: number;
  signature: number;
  background: number;
  decoration: number;
  image: number;
  table: number;
  annotation: number;
  form: number;
}

/** 业务类型 → 工程类型映射（唯一翻译点，Builder 不参与） */
const BUSINESS_TO_ENGINEERING: Record<keyof SceneInventoryCounts, SceneObjectType | null> = {
  glyph: "GlyphObject",
  signature: "SignatureObject",
  background: "PdfFallbackObject",   // business "background" → engineering "PdfFallbackObject"
  decoration: "DecorationObject",
  image: "ImageObject",
  table: "TableObject",
  annotation: "AnnotationObject",
  form: "FormObject",
};

/** 工程类型默认规格（blocking/required/owner）—— Builder 契约的默认值 */
function defaultSpec(type: SceneObjectType): Partial<SceneObjectSpec> {
  switch (type) {
    case "PdfFallbackObject": return { blocking: true, required: true, owner: "PDFAdapter" };
    case "GlyphObject": return { blocking: true, required: true, owner: "PDFAdapter" };
    case "SignatureObject": return { blocking: true, required: true, owner: "PDFAdapter" };
    case "DecorationObject": return { blocking: false, required: false, owner: "PDFAdapter" };
    case "ImageObject": return { blocking: false, required: false, owner: "PDFAdapter" };
    case "TableObject": return { blocking: true, required: true, owner: "PDFAdapter" };
    case "AnnotationObject": return { blocking: false, required: false, owner: "PDFAdapter" };
    case "FormObject": return { blocking: false, required: false, owner: "PDFAdapter" };
  }
}

/**
 * Scene Inventory（业务）→ Scene Contract（工程）。
 * 这是唯一翻译点。Builder 不参与。
 * @param inventory Scene Inventory 计数（每类业务对象数量）
 * @param page 页号
 * @param extra 额外规格（如 SignatureObject 的 rotation/source）
 */
export function inventoryToContract(
  inventory: SceneInventoryCounts,
  page: number,
  extra?: Partial<Record<SceneObjectType, Partial<SceneObjectSpec>>>,
): SceneContract {
  const objects: SceneObjectSpec[] = [];
  for (const [businessKey, count] of Object.entries(inventory) as [keyof SceneInventoryCounts, number][]) {
    if (count <= 0) continue;
    const engType = BUSINESS_TO_ENGINEERING[businessKey];
    if (!engType) continue;
    const def = defaultSpec(engType);
    objects.push({
      type: engType,
      owner: def.owner ?? "PDFAdapter",
      blocking: def.blocking ?? false,
      required: def.required ?? false,
      count,
      ...(extra?.[engType] ?? {}),
    });
  }
  return { page, objects };
}
