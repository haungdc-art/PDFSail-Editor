/**
 * Semantic Analyzer — Sprint 8 Task 2 + Task 3
 *
 * 从 EditableDocument 分析出 SemanticDocument。
 *
 * Task 2: Semantic Analyzer
 *   输入：EditableDocument
 *   输出：SemanticDocument
 *   规则：结合 text + layout + position + pattern
 *
 * Task 3: Glyph → SemanticObject 映射
 *   每个 SemanticObject 通过 sourceGlyphs 关联到具体 glyph
 *
 * 识别策略：
 *   1. 日期模式匹配（DD/MM/YYYY、MM/DD/YYYY、YYYY-MM-DD 等）
 *   2. 姓名关键词匹配（"JENNIFER"、"Patient:"、"Name:"）
 *   3. 地址模式匹配（街道/城市/邮编）
 *   4. 签名区域检测（空白 + 下方有姓名）
 *   5. 表格检测（等距排列的文本块）
 *   6. CID/ID 模式匹配
 *
 * 置信度计算：
 *   - pattern 匹配：0.9
 *   - keyword 匹配：0.8
 *   - layout 推断：0.6
 *   - position 推断：0.5
 */

import type {
  EditableDocument,
  EditableBlock,
  EditableLine,
  EditableGlyph,
  BBox,
} from "./types";
import type {
  SemanticDocument,
  AnySemanticObject,
  DateFieldObject,
  NameFieldObject,
  AddressFieldObject,
  SignatureFieldObject,
  TextFieldObject,
  GlyphRef,
  SemanticObjectType,
} from "./semantic-types";

// ── 日期模式 ──

/** 常见日期正则 */
const DATE_PATTERNS: Array<{ regex: RegExp; format: string }> = [
  { regex: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, format: "DD/MM/YYYY" },
  { regex: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, format: "YYYY-MM-DD" },
  { regex: /\b(\d{1,2})-(\d{1,2})-(\d{4})\b/g, format: "DD-MM-YYYY" },
  { regex: /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g, format: "DD.MM.YYYY" },
];

// ── 姓名关键词 ──

/** 姓名标签关键词（后跟姓名） */
const NAME_KEYWORDS = [
  { regex: /(?:patient|paciente|nome|name)\s*:?\s*([A-Z][A-Z\s]+)/gi, role: "patient" as const },
  { regex: /(?:doctor|dr|médico|medico)\s*:?\s*([A-Z][A-Z\s]+)/gi, role: "doctor" as const },
  { regex: /(?:assinado|signed|signature)\s*:?\s*([A-Z][A-Z\s]+)/gi, role: "signer" as const },
];

/** 全大写姓名（至少 2 个词，每词 ≥3 字符） */
const UPPERCASE_NAME_REGEX = /\b([A-Z]{3,}(?:\s+[A-Z]{3,})+)\b/g;

// ── CID/ID 模式 ──

const CID_REGEX = /\b(?:CID|CID-10|CID10)\s*:?\s*([A-Z]\d{2}(?:\.\d{1,2})?)/gi;
const ID_REGEX = /\b(?:ID|RG|CPF|CNPJ)\s*:?\s*([\w.-]+)/gi;

// ── 地址模式 ──

const ZIP_REGEX = /\b(\d{5}-\d{3})\b/g; // 巴西邮编 CEP
const STREET_REGEX = /(?:rua|av|avenida|street|st)\s+([\w\s]+),?\s*(\d+)/gi;

// ── 主入口 ──

/**
 * 分析 EditableDocument，生成 SemanticDocument
 *
 * @param doc EditableDocument
 * @returns SemanticDocument（含 SemanticObject[]）
 */
export function analyzeDocument(doc: EditableDocument): SemanticDocument {
  const objects: AnySemanticObject[] = [];
  let objectIndex = 0;

  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.type !== "text") continue;

      // 获取 block 的完整文本
      const blockText = block.lines
        .map((l) => l.glyphs.map((g) => g.char).join(""))
        .join("\n");

      // 1. 日期识别
      const dateObjects = detectDates(block, page.index, objectIndex);
      objects.push(...dateObjects);
      objectIndex += dateObjects.length;

      // 2. 姓名识别
      const nameObjects = detectNames(block, blockText, page.index, objectIndex);
      objects.push(...nameObjects);
      objectIndex += nameObjects.length;

      // 3. CID/ID 识别（作为 TextField）
      const cidObjects = detectCIDs(block, page.index, objectIndex);
      objects.push(...cidObjects);
      objectIndex += cidObjects.length;

      // 4. 地址识别
      const addressObjects = detectAddresses(block, page.index, objectIndex);
      objects.push(...addressObjects);
      objectIndex += addressObjects.length;

      // 5. 签名区域检测
      const sigObjects = detectSignatures(block, blockText, page.index, objectIndex);
      objects.push(...sigObjects);
      objectIndex += sigObjects.length;
    }
  }

  // 统计
  const typeCounts = countByType(objects);

  return {
    document: doc,
    objects,
    metadata: {
      analyzedAt: Date.now(),
      objectCount: objects.length,
      typeCounts,
    },
  };
}

// ── 日期识别 ──

function detectDates(
  block: EditableBlock,
  page: number,
  baseIndex: number
): DateFieldObject[] {
  const objects: DateFieldObject[] = [];

  for (const line of block.lines) {
    const lineText = line.glyphs.map((g) => g.char).join("");

    for (const { regex, format } of DATE_PATTERNS) {
      // 重置 regex（全局匹配需重置 lastIndex）
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(lineText)) !== null) {
        const matchedText = match[0];
        const startIndex = match.index;

        // 收集对应的 glyph refs
        const glyphs = collectGlyphRefs(line, block.id, startIndex, matchedText.length);

        if (glyphs.length === 0) continue;

        const bbox = computeGlyphsBBox(line, startIndex, matchedText.length);

        // 解析日期为 ISO 格式
        const parsedDate = parseDate(matchedText, format);

        objects.push({
          id: `date_${page}_${baseIndex}_${objects.length}`,
          type: "dateField",
          value: matchedText,
          originalValue: matchedText,
          label: "Date",
          sourceBlocks: [block.id],
          sourceGlyphs: glyphs,
          bbox,
          confidence: 0.9,
          detectedBy: "pattern",
          page,
          modified: false,
          format,
          parsedDate,
        });
      }
    }
  }

  return objects;
}

// ── 姓名识别 ──

function detectNames(
  block: EditableBlock,
  blockText: string,
  page: number,
  baseIndex: number
): NameFieldObject[] {
  const objects: NameFieldObject[] = [];

  // 关键词匹配（如 "Patient: JENNIFER MARTINS"）
  for (const { regex, role } of NAME_KEYWORDS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(blockText)) !== null) {
      const name = match[1].trim();
      if (name.length < 3) continue;

      // 找到姓名在哪个 line
      for (const line of block.lines) {
        const lineText = line.glyphs.map((g) => g.char).join("");
        const nameStart = lineText.indexOf(name);
        if (nameStart === -1) continue;

        const glyphs = collectGlyphRefs(line, block.id, nameStart, name.length);
        if (glyphs.length === 0) continue;

        const bbox = computeGlyphsBBox(line, nameStart, name.length);

        objects.push({
          id: `name_${page}_${baseIndex}_${objects.length}`,
          type: "nameField",
          value: name,
          originalValue: name,
          label: role === "patient" ? "Patient Name" : role === "doctor" ? "Doctor Name" : "Name",
          sourceBlocks: [block.id],
          sourceGlyphs: glyphs,
          bbox,
          confidence: 0.8,
          detectedBy: "keyword",
          page,
          modified: false,
          nameRole: role,
        });
        break;
      }
    }
  }

  // 全大写姓名匹配（如 "JENNIFER MARTINS DE OLIVEIRA"）
  UPPERCASE_NAME_REGEX.lastIndex = 0;
  let upperMatch: RegExpExecArray | null;
  while ((upperMatch = UPPERCASE_NAME_REGEX.exec(blockText)) !== null) {
    const name = upperMatch[1].trim();

    // 去重：如果已被关键词匹配捕获，跳过
    if (objects.some((o) => o.value === name)) continue;

    for (const line of block.lines) {
      const lineText = line.glyphs.map((g) => g.char).join("");
      const nameStart = lineText.indexOf(name);
      if (nameStart === -1) continue;

      const glyphs = collectGlyphRefs(line, block.id, nameStart, name.length);
      if (glyphs.length === 0) continue;

      const bbox = computeGlyphsBBox(line, nameStart, name.length);

      objects.push({
        id: `name_upper_${page}_${baseIndex}_${objects.length}`,
        type: "nameField",
        value: name,
        originalValue: name,
        label: "Name",
        sourceBlocks: [block.id],
        sourceGlyphs: glyphs,
        bbox,
        confidence: 0.6,
        detectedBy: "pattern",
        page,
        modified: false,
        nameRole: "unknown",
      });
      break;
    }
  }

  return objects;
}

// ── CID/ID 识别 ──

function detectCIDs(
  block: EditableBlock,
  page: number,
  baseIndex: number
): TextFieldObject[] {
  const objects: TextFieldObject[] = [];

  for (const line of block.lines) {
    const lineText = line.glyphs.map((g) => g.char).join("");

    CID_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CID_REGEX.exec(lineText)) !== null) {
      const fullMatch = match[0];
      const startIndex = match.index;
      const glyphs = collectGlyphRefs(line, block.id, startIndex, fullMatch.length);
      if (glyphs.length === 0) continue;

      const bbox = computeGlyphsBBox(line, startIndex, fullMatch.length);

      objects.push({
        id: `cid_${page}_${baseIndex}_${objects.length}`,
        type: "textField",
        value: fullMatch,
        originalValue: fullMatch,
        label: "CID",
        sourceBlocks: [block.id],
        sourceGlyphs: glyphs,
        bbox,
        confidence: 0.9,
        detectedBy: "pattern",
        page,
        modified: false,
        textRole: "value",
      });
    }

    ID_REGEX.lastIndex = 0;
    while ((match = ID_REGEX.exec(lineText)) !== null) {
      const fullMatch = match[0];
      const startIndex = match.index;
      const glyphs = collectGlyphRefs(line, block.id, startIndex, fullMatch.length);
      if (glyphs.length === 0) continue;

      const bbox = computeGlyphsBBox(line, startIndex, fullMatch.length);

      objects.push({
        id: `id_${page}_${baseIndex}_${objects.length}`,
        type: "textField",
        value: fullMatch,
        originalValue: fullMatch,
        label: "ID",
        sourceBlocks: [block.id],
        sourceGlyphs: glyphs,
        bbox,
        confidence: 0.85,
        detectedBy: "pattern",
        page,
        modified: false,
        textRole: "value",
      });
    }
  }

  return objects;
}

// ── 地址识别 ──

function detectAddresses(
  block: EditableBlock,
  page: number,
  baseIndex: number
): AddressFieldObject[] {
  const objects: AddressFieldObject[] = [];

  for (const line of block.lines) {
    const lineText = line.glyphs.map((g) => g.char).join("");

    // 邮编匹配
    ZIP_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ZIP_REGEX.exec(lineText)) !== null) {
      const zip = match[1];
      const startIndex = match.index;
      const glyphs = collectGlyphRefs(line, block.id, startIndex, match[0].length);
      if (glyphs.length === 0) continue;

      const bbox = computeGlyphsBBox(line, startIndex, match[0].length);

      objects.push({
        id: `addr_zip_${page}_${baseIndex}_${objects.length}`,
        type: "addressField",
        value: match[0],
        originalValue: match[0],
        label: "Postal Code",
        sourceBlocks: [block.id],
        sourceGlyphs: glyphs,
        bbox,
        confidence: 0.85,
        detectedBy: "pattern",
        page,
        modified: false,
        components: { zip },
      });
    }
  }

  return objects;
}

// ── 签名区域检测 ──

function detectSignatures(
  block: EditableBlock,
  blockText: string,
  page: number,
  baseIndex: number
): SignatureFieldObject[] {
  const objects: SignatureFieldObject[] = [];

  // 关键词：签名标记
  const sigKeywords = /(?:assinatura|signature|signed by|ass\.)/i;
  if (sigKeywords.test(blockText)) {
    // 整个 block 标记为签名区域
    const allGlyphs = block.lines.flatMap((line, lineIdx) =>
      line.glyphs.map((g, gIdx) => ({
        blockId: block.id,
        lineId: line.id,
        glyphIndex: gIdx,
        char: g.char,
      }))
    );

    objects.push({
      id: `sig_${page}_${baseIndex}_0`,
      type: "signatureField",
      value: blockText,
      originalValue: blockText,
      label: "Signature Area",
      sourceBlocks: [block.id],
      sourceGlyphs: allGlyphs,
      bbox: block.bbox,
      confidence: 0.7,
      detectedBy: "keyword",
      page,
      modified: false,
      signatureType: "handwritten",
      isSigned: true,
    });
  }

  return objects;
}

// ── 辅助函数 ──

/**
 * 收集 line 中指定位置范围的 glyph refs
 */
function collectGlyphRefs(
  line: EditableLine,
  blockId: string,
  startIndex: number,
  length: number
): GlyphRef[] {
  const refs: GlyphRef[] = [];
  const endIndex = Math.min(startIndex + length, line.glyphs.length);

  for (let i = startIndex; i < endIndex; i++) {
    const g = line.glyphs[i];
    if (!g) continue;
    refs.push({
      blockId,
      lineId: line.id,
      glyphIndex: i,
      char: g.char,
    });
  }

  return refs;
}

/**
 * 计算 line 中指定位置范围的 glyph bbox 并集
 */
function computeGlyphsBBox(
  line: EditableLine,
  startIndex: number,
  length: number
): BBox {
  const endIndex = Math.min(startIndex + length, line.glyphs.length);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (let i = startIndex; i < endIndex; i++) {
    const g = line.glyphs[i];
    if (!g) continue;
    minX = Math.min(minX, g.bbox.x);
    minY = Math.min(minY, g.bbox.y);
    maxX = Math.max(maxX, g.bbox.x + g.bbox.width);
    maxY = Math.max(maxY, g.bbox.y + g.bbox.height);
  }

  if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * 解析日期为 ISO 格式
 */
function parseDate(dateStr: string, format: string): string | undefined {
  try {
    const parts = dateStr.split(/[\/\-.]/);
    if (parts.length !== 3) return undefined;

    let day: number, month: number, year: number;

    if (format === "DD/MM/YYYY" || format === "DD-MM-YYYY" || format === "DD.MM.YYYY") {
      day = parseInt(parts[0]);
      month = parseInt(parts[1]);
      year = parseInt(parts[2]);
    } else if (format === "YYYY-MM-DD") {
      year = parseInt(parts[0]);
      month = parseInt(parts[1]);
      day = parseInt(parts[2]);
    } else {
      return undefined;
    }

    if (isNaN(day) || isNaN(month) || isNaN(year)) return undefined;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  } catch {
    return undefined;
  }
}

/**
 * 按类型统计
 */
function countByType(objects: AnySemanticObject[]): Record<SemanticObjectType, number> {
  const counts: Record<SemanticObjectType, number> = {
    textField: 0,
    dateField: 0,
    nameField: 0,
    addressField: 0,
    signatureField: 0,
    tableField: 0,
  };
  for (const obj of objects) {
    counts[obj.type]++;
  }
  return counts;
}

/**
 * 按 ID 查找 SemanticObject
 */
export function findSemanticObject(
  semanticDoc: SemanticDocument,
  objectId: string
): AnySemanticObject | undefined {
  return semanticDoc.objects.find((o) => o.id === objectId);
}

/**
 * 按类型查找 SemanticObject
 */
export function findSemanticObjectsByType(
  semanticDoc: SemanticDocument,
  type: SemanticObjectType
): AnySemanticObject[] {
  return semanticDoc.objects.filter((o) => o.type === type);
}

/**
 * 按标签查找 SemanticObject
 */
export function findSemanticObjectsByLabel(
  semanticDoc: SemanticDocument,
  label: string
): AnySemanticObject[] {
  const lowerLabel = label.toLowerCase();
  return semanticDoc.objects.filter(
    (o) => o.label?.toLowerCase().includes(lowerLabel)
  );
}
