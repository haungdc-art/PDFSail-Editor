/**
 * DocumentSchema — Sprint 9 Task 1 + Task 4
 *
 * Task 1: DocumentSchema Model
 *   - documentType：文档类型
 *   - entities：期望的语义实体
 *   - relationships：实体间关系
 *
 * Task 4: Document Type Detection
 *   - medical certificate（医疗证明）
 *   - invoice（发票）
 *   - contract（合同）
 *   - resume（简历）
 *
 * 文档类型检测策略：
 *   1. 关键词匹配（如 "atesto"、"medical certificate"）
 *   2. 语义对象组合（如 有 DateField + NameField + SignatureField → 医疗证明）
 *   3. LLM 推断（通过 /api/llm/detect-document-type）
 */

import type { SemanticDocument, AnySemanticObject } from "./semantic-types";

/** 文档类型 */
export type DocumentType =
  | "medical_certificate"
  | "invoice"
  | "contract"
  | "resume"
  | "unknown";

/** 期望的语义实体定义 */
export interface EntityExpectation {
  /** 实体类型 */
  type: AnySemanticObject["type"];
  /** 是否必需 */
  required: boolean;
  /** 标签关键词（用于匹配 label） */
  labelKeywords?: string[];
  /** 描述 */
  description?: string;
}

/** 实体间关系 */
export interface EntityRelationship {
  /** 源实体类型 */
  from: AnySemanticObject["type"];
  /** 目标实体类型 */
  to: AnySemanticObject["type"];
  /** 关系类型 */
  relation: "belongs_to" | "signed_by" | "issued_to" | "references";
  /** 描述 */
  description?: string;
}

/** DocumentSchema — 文档模式定义 */
export interface DocumentSchema {
  /** 文档类型 */
  documentType: DocumentType;
  /** 类型标签（人类可读） */
  typeLabel: string;
  /** 期望的语义实体 */
  entities: EntityExpectation[];
  /** 实体间关系 */
  relationships: EntityRelationship[];
  /** 检测置信度 */
  confidence: number;
  /** 检测来源 */
  detectedBy: "keyword" | "entity_combination" | "llm";
}

// ── 文档类型 Schema 定义 ──

/** 医疗证明 Schema */
const MEDICAL_CERTIFICATE_SCHEMA: Omit<DocumentSchema, "confidence" | "detectedBy"> = {
  documentType: "medical_certificate",
  typeLabel: "Medical Certificate",
  entities: [
    { type: "nameField", required: true, labelKeywords: ["patient", "name", "paciente", "nome"], description: "Patient name" },
    { type: "dateField", required: true, labelKeywords: ["date", "data", "afastamento"], description: "Absence/consultation date" },
    { type: "textField", required: true, labelKeywords: ["cid", "diagnosis"], description: "CID/diagnosis code" },
    { type: "signatureField", required: true, labelKeywords: ["signature", "assinatura"], description: "Doctor signature" },
    { type: "nameField", required: false, labelKeywords: ["doctor", "dr", "médico"], description: "Doctor name" },
  ],
  relationships: [
    { from: "signatureField", to: "nameField", relation: "signed_by", description: "Doctor signs the certificate" },
    { from: "dateField", to: "nameField", relation: "belongs_to", description: "Date belongs to patient" },
  ],
};

/** 发票 Schema */
const INVOICE_SCHEMA: Omit<DocumentSchema, "confidence" | "detectedBy"> = {
  documentType: "invoice",
  typeLabel: "Invoice",
  entities: [
    { type: "textField", required: true, labelKeywords: ["invoice", "fatura", "bill"], description: "Invoice number" },
    { type: "dateField", required: true, labelKeywords: ["date", "data", "due"], description: "Issue/due date" },
    { type: "nameField", required: true, labelKeywords: ["client", "customer", "cliente"], description: "Client name" },
    { type: "addressField", required: false, labelKeywords: ["address", "endereço"], description: "Billing address" },
    { type: "tableField", required: false, description: "Itemized charges" },
    { type: "textField", required: true, labelKeywords: ["total", "amount", "valor"], description: "Total amount" },
  ],
  relationships: [
    { from: "tableField", to: "textField", relation: "references", description: "Items sum to total" },
    { from: "dateField", to: "nameField", relation: "belongs_to", description: "Date belongs to client" },
  ],
};

/** 合同 Schema */
const CONTRACT_SCHEMA: Omit<DocumentSchema, "confidence" | "detectedBy"> = {
  documentType: "contract",
  typeLabel: "Contract",
  entities: [
    { type: "textField", required: true, labelKeywords: ["contract", "contrato", "agreement"], description: "Contract title" },
    { type: "dateField", required: true, labelKeywords: ["date", "data", "effective"], description: "Effective date" },
    { type: "nameField", required: true, labelKeywords: ["party", "parte", "lessor"], description: "Party A" },
    { type: "nameField", required: true, labelKeywords: ["party", "parte", "lessee"], description: "Party B" },
    { type: "signatureField", required: true, labelKeywords: ["signature", "assinatura"], description: "Signatures" },
  ],
  relationships: [
    { from: "signatureField", to: "nameField", relation: "signed_by", description: "Parties sign the contract" },
  ],
};

/** 简历 Schema */
const RESUME_SCHEMA: Omit<DocumentSchema, "confidence" | "detectedBy"> = {
  documentType: "resume",
  typeLabel: "Resume",
  entities: [
    { type: "nameField", required: true, labelKeywords: ["name", "nome", "curriculum"], description: "Candidate name" },
    { type: "addressField", required: false, labelKeywords: ["address", "endereço"], description: "Contact address" },
    { type: "dateField", required: false, labelKeywords: ["birth", "nascimento"], description: "Birth date" },
    { type: "textField", required: true, labelKeywords: ["experience", "experiência", "education"], description: "Experience/education" },
  ],
  relationships: [],
};

const ALL_SCHEMAS = [MEDICAL_CERTIFICATE_SCHEMA, INVOICE_SCHEMA, CONTRACT_SCHEMA, RESUME_SCHEMA];

// ── 文档类型检测 ──

/** 关键词检测规则 */
const TYPE_KEYWORDS: Record<DocumentType, string[]> = {
  medical_certificate: ["atesto", "atestado", "medical certificate", "afastamento", "tratamento", "saúde", "cid"],
  invoice: ["invoice", "fatura", "notre fiscal", "total", "amount due", "bill to"],
  contract: ["contract", "contrato", "agreement", "parte", "party", "terms"],
  resume: ["curriculum", "resume", "cv", "experience", "education", "objective"],
  unknown: [],
};

/**
 * 检测文档类型
 *
 * 策略：
 *   1. 关键词匹配（置信度 0.7）
 *   2. 语义对象组合（置信度 0.8）
 *   3. 取最高置信度
 *
 * @param semDoc SemanticDocument
 * @returns DocumentSchema（含检测到的类型 + 期望实体）
 */
export function detectDocumentType(semDoc: SemanticDocument): DocumentSchema {
  const fullText = semDoc.document.pages
    .map((p) => p.blocks.map((b) => b.lines.map((l) => l.glyphs.map((g) => g.char).join("")).join("\n")).join("\n"))
    .join("\n")
    .toLowerCase();

  // 策略 1：关键词匹配
  const keywordScores: Record<DocumentType, number> = {
    medical_certificate: 0,
    invoice: 0,
    contract: 0,
    resume: 0,
    unknown: 0,
  };

  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
    for (const kw of keywords) {
      if (fullText.includes(kw)) {
        keywordScores[type as DocumentType] += 1;
      }
    }
  }

  // 策略 2：语义对象组合
  const objTypes = semDoc.objects.map((o) => o.type);
  const hasName = objTypes.includes("nameField");
  const hasDate = objTypes.includes("dateField");
  const hasSig = objTypes.includes("signatureField");
  const hasAddr = objTypes.includes("addressField");
  const hasTable = objTypes.includes("tableField");

  const combinationScores: Record<DocumentType, number> = {
    medical_certificate: (hasName && hasDate && hasSig ? 3 : 0) + (hasName && hasDate ? 1 : 0),
    invoice: (hasDate && hasTable ? 2 : 0) + (hasAddr ? 1 : 0),
    contract: (hasName && hasDate && hasSig ? 2 : 0),
    resume: (hasName && hasAddr ? 2 : 0),
    unknown: 0,
  };

  // 综合评分
  let bestType: DocumentType = "unknown";
  let bestScore = 0;
  let bestSource: DocumentSchema["detectedBy"] = "keyword";

  for (const type of ["medical_certificate", "invoice", "contract", "resume"] as DocumentType[]) {
    const kwScore = keywordScores[type];
    const combScore = combinationScores[type];
    const total = kwScore + combScore;

    if (total > bestScore) {
      bestScore = total;
      bestType = type;
      bestSource = combScore > kwScore ? "entity_combination" : "keyword";
    }
  }

  // 置信度计算
  const confidence = Math.min(0.9, 0.4 + bestScore * 0.1);

  // 返回对应 Schema
  const schema = ALL_SCHEMAS.find((s) => s.documentType === bestType);
  if (!schema) {
    return {
      documentType: "unknown",
      typeLabel: "Unknown",
      entities: [],
      relationships: [],
      confidence: 0,
      detectedBy: "keyword",
    };
  }

  return {
    ...schema,
    confidence,
    detectedBy: bestSource,
  };
}

/**
 * 验证 SemanticDocument 是否满足 DocumentSchema
 *
 * 检查必需实体是否存在。
 */
export function validateAgainstSchema(
  semDoc: SemanticDocument,
  schema: DocumentSchema
): { valid: boolean; missing: EntityExpectation[]; found: EntityExpectation[] } {
  const missing: EntityExpectation[] = [];
  const found: EntityExpectation[] = [];

  for (const entity of schema.entities) {
    const exists = semDoc.objects.some((o) => {
      if (o.type !== entity.type) return false;
      if (entity.labelKeywords && entity.labelKeywords.length > 0) {
        return entity.labelKeywords.some((kw) =>
          o.label?.toLowerCase().includes(kw.toLowerCase())
        );
      }
      return true;
    });

    if (exists) {
      found.push(entity);
    } else if (entity.required) {
      missing.push(entity);
    }
  }

  return { valid: missing.length === 0, missing, found };
}

/** 获取所有文档类型 Schema */
export function getAllSchemas(): typeof ALL_SCHEMAS {
  return ALL_SCHEMAS;
}
