/**
 * EngineCapability — Story-2C (Capability Definition)
 *
 * 只定义"引擎具备什么能力"，不定义"某个对象该做什么"。
 *
 * 关键区分：
 *   - Capability 是【Engine Capability】（引擎能力），不是【Business Capability】。
 *   - 例如 "Printed Text 能 OCR / 能 Geometry / 能 Metadata"，是所有引擎都能处理。
 *   - 本层只做 Definition（接口 + Matrix 配置），【不含 Resolver / 算法】。
 *
 * ────────────────────────────────────────────────────────────────
 * 命名规范（项目统一）：
 *   *Facts       记录观测
 *   *Semantic    理解"它是什么"
 *   *Capability  定义"引擎能做什么"   ← 本文件
 *   *Decision    决定"现在要做什么"
 *   *Strategy    决定"由谁来做"
 *   *Pipeline    执行，不判断
 * ────────────────────────────────────────────────────────────────
 *
 * 分层（Story 拆分）：
 *   Story-2C  Capability Definition（本文件）：接口 + Matrix，纯数据，无算法
 *   Story-2D  Capability Resolver：VisualSemantic → EngineCapability（查表）
 *   Story-2E  Strategy Decision：Capability + Runtime → Need
 *
 * 本文件【禁止】出现 Resolver 逻辑 / switch 规则 —— 那是 Story-2D。
 */

import { VisualObjectType } from "./visual-semantic";

/**
 * 引擎能力（Engine Capability）。
 *
 * 描述"当前 Engine 体系支持哪些处理"，与具体对象无关。
 * 用 supports（支持）而不是 can（能），因为这里不是"对象能不能"，
 * 而是"引擎支不支持"。
 *
 * 不存在 needGeometry 等决策字段 —— need 属于 Story-2E。
 */
export interface EngineCapability {
  /** 几何引擎是否支持（旋转 / 倾斜 / 缩放检测） */
  readonly supportsGeometry: boolean;
  /** OCR 引擎是否支持（文本识别） */
  readonly supportsOCR: boolean;
  /** 元数据引擎是否支持（字体 / 嵌入信息 / 矢量属性） */
  readonly supportsMetadata: boolean;
  /** 解码引擎是否支持（QR / 条形码） */
  readonly supportsDecode: boolean;
}

/**
 * 能力提供者（CapabilityProvider） — Dependency Inversion。
 *
 * Resolver 只依赖本 Provider，不直接依赖具体的能力数据源
 * （Matrix / JSON / YAML / Database / Remote Config / Plugin）。
 *
 * 未来更换能力来源时，只需替换 Provider 实现，Resolver 不动。
 */
export interface CapabilityProvider {
  /** 按对象类型获取引擎能力 */
  getCapability(objectType: VisualObjectType): EngineCapability;
}

/**
 * 默认能力配置（DefaultCapabilityProfile） — 纯配置，非算法。
 *
 * 按 VisualObjectType 查表，返回该对象类型的基线引擎能力。
 * 只定义"这类 Object 天然具备哪些能力"，不结合 Representation，
 * 不做任何运行时判断。
 *
 * 这是【数据】，不是【逻辑】。未来新增 Seal / Formula / Chart 等对象，
 * 只需在此追加一行，无需改动任何 Resolver / Decision 逻辑。
 *
 * 这是 Default Profile；未来可有 MedicalProfile / InvoiceProfile /
 * OCRProfile / LiteProfile / EnterpriseProfile 等，但均以本表为基线。
 */
export const DefaultCapabilityProfile: Record<VisualObjectType, EngineCapability> = {
  // 签名：几何（旋转检测）+ OCR（文本）+ 元数据（电子签）均可能
  [VisualObjectType.Signature]: {
    supportsGeometry: true,
    supportsOCR: true,
    supportsMetadata: true,
    supportsDecode: false,
  },

  // 印章：几何（形状/位置）+ OCR（印章内文字）+ 元数据（矢量印章）
  [VisualObjectType.Stamp]: {
    supportsGeometry: true,
    supportsOCR: true,
    supportsMetadata: true,
    supportsDecode: false,
  },

  // Logo：几何 + 元数据；Logo 本身无文本，OCR 视情况
  [VisualObjectType.Logo]: {
    supportsGeometry: true,
    supportsOCR: false,
    supportsMetadata: true,
    supportsDecode: false,
  },

  // QRCode / Barcode：解码是核心能力；旁边文字可 OCR
  [VisualObjectType.QRCode]: {
    supportsGeometry: false,
    supportsOCR: true,
    supportsMetadata: false,
    supportsDecode: true,
  },
  [VisualObjectType.Barcode]: {
    supportsGeometry: false,
    supportsOCR: true,
    supportsMetadata: false,
    supportsDecode: true,
  },

  // 水印：几何（透视/位置），可被元数据描述，无文本可 OCR
  [VisualObjectType.Watermark]: {
    supportsGeometry: true,
    supportsOCR: false,
    supportsMetadata: true,
    supportsDecode: false,
  },

  // Checkbox / Annotation / Highlight：几何（位置/尺寸）+ 元数据，无 OCR 主体
  [VisualObjectType.Checkbox]: {
    supportsGeometry: true,
    supportsOCR: false,
    supportsMetadata: true,
    supportsDecode: false,
  },
  [VisualObjectType.Annotation]: {
    supportsGeometry: true,
    supportsOCR: false,
    supportsMetadata: true,
    supportsDecode: false,
  },
  [VisualObjectType.Highlight]: {
    supportsGeometry: true,
    supportsOCR: false,
    supportsMetadata: true,
    supportsDecode: false,
  },

  // 一般图像：几何 + 元数据；若有文本则 OCR，作为通用能力保留
  [VisualObjectType.Image]: {
    supportsGeometry: true,
    supportsOCR: true,
    supportsMetadata: true,
    supportsDecode: false,
  },

  // Text：OCR 核心；若为手写/倾斜，Geometry 也有价值；元数据可描述字体
  [VisualObjectType.Text]: {
    supportsGeometry: true,
    supportsOCR: true,
    supportsMetadata: true,
    supportsDecode: false,
  },

  // Unknown：无法判断，全部保守为不支持
  [VisualObjectType.Unknown]: {
    supportsGeometry: false,
    supportsOCR: false,
    supportsMetadata: false,
    supportsDecode: false,
  },
};

/**
 * 基于 DefaultCapabilityProfile 的能力提供者实现。
 *
 * 未来若能力来源换成 JSON / Database / Remote Config / Plugin，
 * 只需替换 Provider 实现，Resolver 无需改动。
 */
export class DefaultCapabilityProvider implements CapabilityProvider {
  getCapability(objectType: VisualObjectType): EngineCapability {
    // 查表必然命中（DefaultCapabilityProfile 覆盖全部 VisualObjectType），防御性回退 Unknown
    return DefaultCapabilityProfile[objectType] ?? DefaultCapabilityProfile.Unknown;
  }
}
