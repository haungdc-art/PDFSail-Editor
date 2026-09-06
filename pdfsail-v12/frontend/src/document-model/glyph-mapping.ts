/**
 * Original Glyph Mapping — Task 3
 *
 * 建立 OriginalGlyph → NewGlyph 的映射关系。
 *
 * 场景：用户编辑文本（如 JENNIFER → MARIA）
 *   原文：J E N N I F E R（8 个 glyph）
 *   新文：M A R I A（5 个 glyph）
 *
 * 要求：
 *   - 保持位置（新 glyph 锚定到原 glyph 的起始位置）
 *   - 保持字体（styleRef 不变）
 *   - 保持高度（lineHeight 不变）
 *   - 不影响下一行（行 Y 坐标和高度不变）
 *
 * 映射策略：
 *   1. 字符级映射：新文本的每个字符锚定到原文本对应位置的 glyph
 *   2. 长度变化处理：
 *      - 新文本更短（JENNIFER→MARIA）：剩余原 glyph 位置留空（不移动后续文本）
 *      - 新文本更长（MARIA→JENNIFER）：超出部分在行尾追加（不换行，Preserve 模式禁止 reflow）
 *   3. 位置锚定：新 glyph 的 x = 原 glyph 的 originalBBox.x
 *   4. 宽度重算：新 glyph 的 width = measureText(newChar)
 *
 * 输入：
 *   - originalGlyphs: 原始 glyph 数组
 *   - newText: 用户输入的新文本
 *   - style: 样式
 *   - styleRef: 样式索引
 *
 * 输出：
 *   - newGlyphs: 新 glyph 数组（保持原始位置锚定）
 */

import type { EditableGlyph, EditableStyle, BBox, TransformMatrix } from "./types";
import { IDENTITY_TRANSFORM } from "./types";
import { measureCharWidth } from "./text-measurement";

/**
 * 获取原 glyph 的可用宽度（优先 bbox.width，其次 metrics.advanceWidth）。
 */
function getOriginalGlyphWidth(glyph: EditableGlyph | undefined): number {
  if (!glyph) return 0;
  return glyph.bbox?.width ?? glyph.metrics?.advanceWidth ?? 0;
}

/**
 * M7.8-049: 清除 glyph metrics 中「绑定到具体原字符」的字符码身份字段。
 *
 * 仅用于插入字形（orig === undefined）：它继承末尾原 glyph 的 metrics 时，会把末尾字形的
 * `pdfCharCode`（字符码）一并带过来。导出若按该 stale CID 编码，插入字符会被渲染成「末尾字形」——
 *   · Bidens → Bidens de：插入的 space/d/e 误用 s 的 CID(115) → "Bidenssss"
 *   · 69 → 619：插入的 1 误用 9 的 CID(57) → "699"
 *
 * 字体身份(fontIdentity)、几何(pdfTransform)、度量(advanceWidth) 等与「具体字符」无关，
 * 必须保留，使 tryNativeLineReplay 仍能经 ident.unicodeToCharCode.get(char) 重新推导正确码。
 * 不删除整个 metrics（其余字段编辑/导出仍需要）。
 */
function clearStaleCharCodeFromMetrics(
  metrics: GlyphMetrics | undefined,
): GlyphMetrics | undefined {
  if (!metrics || metrics.pdfCharCode === undefined) return metrics;
  const { pdfCharCode: _drop, ...rest } = metrics;
  return rest;
}

/**
 * 解析 replacement 字符应占用的宽度。
 *
 * 原则：保持原 PDF 行的排版网格不变，避免用 CSS fallback 字体重新测量导致整行漂移。
 * - 若对应位置存在原 glyph 且其宽度有效，直接沿用该宽度；
 * - 若原 glyph 缺失（新增字符）或宽度异常：
 *     0) M7.9-NEWCHAR-SAMECHAR-FIX：优先取同行「同字符」原 glyph 的平均宽度 ——
 *        同一字体/字号下字符 advance 恒定（kerning 影响可忽略），这是最精确的估计；
 *     1) 次选取插入位置相邻原 glyph 宽度的平均（最贴近真实 text run）；
 *     2) 相邻不存在时，用同行有效宽度的中位数（避免表格布局中的超大空格把算术平均拉偏）；
 * - 仍无有效宽度时，才使用 measureCharWidth 作为最后 fallback。
 */
function resolveReplacementCharWidth(
  newChar: string,
  originalGlyph: EditableGlyph | undefined,
  allOriginalGlyphs: EditableGlyph[],
  style: EditableStyle,
  insertIndex?: number
): number {
  const originalWidth = getOriginalGlyphWidth(originalGlyph);

  // 先计算同行宽度的中位数，作为异常值判定基准。
  const validWidths = allOriginalGlyphs
    .map((g) => getOriginalGlyphWidth(g))
    .filter((w) => w > 0.001)
    .sort((a, b) => a - b);
  const medianW = (() => {
    if (validWidths.length === 0) return 0;
    const mid = Math.floor(validWidths.length / 2);
    return validWidths.length % 2 === 0
      ? (validWidths[mid - 1] + validWidths[mid]) / 2
      : validWidths[mid];
  })();
  const isLayoutGlyph =
    originalGlyph &&
    (originalGlyph.char === " " || originalGlyph.originalChar === " ") &&
    originalWidth > Math.max(medianW * 2.5, medianW + 30);

  // 对应位置存在正常原 glyph：沿用其宽度。
  // 若原 glyph 是表格布局用的超宽空格，则不能沿用，否则普通字符会占据数百 pt 的宽区域。
  if (originalWidth > 0.001 && !isLayoutGlyph) return originalWidth;

  // 新增字符 / 替换布局空格：
  const isNormalWidth = (w: number) => w > 0.001 && w <= Math.max(medianW * 2.5, medianW + 30);

  // M7.9-NEWCHAR-SAMECHAR-FIX：新增字符优先用同行「同字符」原 glyph 的平均宽度。
  // 同一字体/字号下字符 advance 恒定（kerning 影响 ≈0），同行已有的同字符就是最真实的宽度。
  // 旧启发式（相邻平均）在字符宽度差异大的行里误差巨大 —— 实测表格行 "…Catumbi " 后
  // 新增 "de"，插入点相邻只有行尾空格（宽 5.43），d/e 均继承 5.43，而同字体真实
  // "d"/"e" 宽 7.34/7.35 → 新字符间距缩水 26%，肉眼可见粘连（边沿重叠）。
  if (allOriginalGlyphs.length > 0) {
    const sameChar = allOriginalGlyphs.filter((g) => {
      if (g.char !== newChar && g.originalChar !== newChar) return false;
      return isNormalWidth(getOriginalGlyphWidth(g));
    });
    if (sameChar.length > 0) {
      const avg =
        sameChar.reduce((sum, g) => sum + getOriginalGlyphWidth(g), 0) / sameChar.length;
      if (avg > 0.001) return avg;
    }
  }

  // 新增字符：次选用插入位置相邻、宽度正常的原 glyph 的平均宽度。
  // 表格 PDF 常用一个超宽空格（数百 pt）把描述列和数量列撑开，若纳入平均会把新增字符
  // 宽度拉得极大，导致 suffix shift 过大、字符间距被异常拉开。
  if (insertIndex !== undefined && insertIndex >= 0 && allOriginalGlyphs.length > 0) {
    const clamped = Math.min(insertIndex, allOriginalGlyphs.length - 1);
    const neighbors = [
      allOriginalGlyphs[clamped - 1],
      allOriginalGlyphs[clamped],
      allOriginalGlyphs[clamped + 1],
    ]
      .filter((g): g is EditableGlyph => !!g && isNormalWidth(getOriginalGlyphWidth(g)));
    if (neighbors.length > 0) {
      const avg = neighbors.reduce((sum, g) => sum + getOriginalGlyphWidth(g), 0) / neighbors.length;
      if (avg > 0.001) return avg;
    }
  }

  // 回退：同行正常宽度的中位数（robust 估计，抵抗表格布局中的异常宽空格）
  if (validWidths.length > 0) {
    const mid = Math.floor(validWidths.length / 2);
    const median = validWidths.length % 2 === 0
      ? (validWidths[mid - 1] + validWidths[mid]) / 2
      : validWidths[mid];
    if (median > 0.001) return median;
  }

  return measureCharWidth(newChar, style);
}

/**
 * 映射结果
 */
export interface GlyphMappingResult {
  /** 新 glyph 数组（保持原始位置锚定） */
  newGlyphs: EditableGlyph[];
  /** 被修改的 glyph 索引列表 */
  modifiedIndices: number[];
  /** 原 glyph 数量 */
  originalCount: number;
  /** 新 glyph 数量 */
  newCount: number;
  /**
   * M7.8-042-ORPHAN：本次映射中被丢弃的原 glyph 的 operatorId（去重、剔除 undefined）。
   * 新文本比原文本短（删除字符）时产生 —— 这些原算子仍留在 PDF content stream 里，
   * 必须在导出时剥离，否则原字符残留成重影（实测 "100%"→"99%" 残留孤立 "%"）。
   */
  droppedOperatorIds?: string[];
}

/**
 * 把新文本映射到原 glyph 位置。
 *
 * @param originalGlyphs 原 glyph 数组（含 originalBBox）
 * @param newText 新文本
 * @param style 样式（用于 measureText）
 * @param styleRef 样式索引
 * @returns GlyphMappingResult
 *
 * 规则：
 *   1. 新文本的每个字符锚定到原 glyph 的 originalBBox.x
 *   2. 字符宽度用 measureText 重算
 *   3. 保持 lineHeight（从原 glyph 继承）
 *   4. 新文本更短 → 剩余原位置留空
 *   5. 新文本更长 → 超出部分在行尾追加（不换行）
 */
export function mapNewTextToOriginalGlyphs(
  originalGlyphs: EditableGlyph[],
  newText: string,
  style: EditableStyle,
  styleRef: number,
  range?: { start: number; end: number }
): GlyphMappingResult {
  const newChars = Array.from(newText);
  const newGlyphs: EditableGlyph[] = [];
  const modifiedIndices: number[] = [];

  // 从第一个原 glyph 获取行基准信息
  const firstOriginal = originalGlyphs[0];
  if (!firstOriginal) {
    // 无原 glyph（空行），从头创建
    return createGlyphsForEmptyLine(newChars, style, styleRef, 0, 0);
  }

  // ── M4-FIX-005: 精确区间 mutation ──
  // 当提供 range（原选区的 glyph 区间 [start, end]，end 含）时：
  //   未选中的 prefix/suffix 保持原对象（identity + originalBBox + bbox + transform 全部保留），
  //   仅 replacement 区间从原选区起始位置重新锚定排布。
  // 消除"整行按新文本整体 i 重新锚定导致未选中字符几何漂移"的问题。
  // 注意：不做 reflow（Preserve 模式）；replacement 比原选区短时后续留空，suffix 保持原位。
  if (range) {
    const start = Math.max(0, Math.min(range.start, originalGlyphs.length - 1));
    // 允许 end < start：表示在 start 处插入（空 range），suffix = slice(end+1) 整体右移。
    // 原 clamp `Math.max(start, …)` 会把插入点 end=start-1 拉回 start，导致 suffix 重复/重叠（压缩 bug）。
    const end = range.end < range.start
      ? Math.min(range.end, originalGlyphs.length - 1)
      : Math.max(start, Math.min(range.end, originalGlyphs.length - 1));

    // 原选区之后保留的 suffix 原对象（end 含 → suffix 从 end+1 起，含原空格等分隔符）
    const suffixGlyphs = originalGlyphs.slice(end + 1);
    // ── M7.7-004: 从整行 newText 提取 replacement 部分（Text Run Preservation）──
    // 契约：newText = prefix(原) + replacement + suffix(原)。
    // 此前用 `newText.length - suffixGlyphs.length` 直接当 suffix 起点，
    // 依赖"newText 尾部 = 原 suffix 完整保留"。但输入框会修剪行尾空白，
    // 且 replacement 长度 ≠ 原选区长度时该公式错位 → 把原 suffix 首字符
    //（如 "JENNIFER " 的后置空格）误当作 replacement 的一部分 → "MARY MARTINS" 粘连。
    // 修复：取 newText 尾部与原 suffix 的**最长公共后缀 L**（比较时忽略行尾空白），
    //   replacement = newText[start, newText.length - L]。
    //   suffixGlyphs 仍是原对象（原空格/分隔符几何完整保留）→ 原生 Tj/TJ 重建可恢复 TJ spacing。
    const suffixText = suffixGlyphs.map((g) => g.char).join("");
    const stripTrailingWs = (s: string) => s.replace(/\s+$/, "");
    const newTail = stripTrailingWs(newText.slice(start));
    const suffixTrimmed = stripTrailingWs(suffixText);
    let commonSuffixLen = 0;
    const maxCommon = Math.min(newTail.length, suffixTrimmed.length);
    while (
      commonSuffixLen < maxCommon &&
      newTail[newTail.length - 1 - commonSuffixLen] ===
        suffixTrimmed[suffixTrimmed.length - 1 - commonSuffixLen]
    ) {
      commonSuffixLen++;
    }
    const replacementText = newText.slice(start, newText.length - commonSuffixLen);

    const prefixGlyphs = originalGlyphs.slice(0, start);

    // M7.7-003 (最小 Mutation 修复): 替换 glyph 继承原 glyph 的 transform + metrics。
    //   行内 glyph 共享同一 transform（pdf-native-adapter 按 text item 统一赋值）→
    //   用锚定 glyph（range 起始 originalGlyphs[start]）的 transform/metrics；
    //   replacement 超出原 glyph 数量时也沿用锚定 glyph（旋转行行内共享同一矩阵）。
    //   不重置为 IDENTITY_TRANSFORM —— 保证编辑后 caret/selection/input 仍沿文字方向
    //   （Case 4: 再次编辑 caret rotation 保持），且 metrics.pdfTransform/fontIdentity
    //   不丢失（Export 可恢复原始 Tm / 字体身份）。
    const anchorGlyph = originalGlyphs[start];
    // M7.8-035R2: 新增字符（replacement 比原选区长）必须沿用**原选区末尾 glyph**
    // 的 transform/metrics/baseline，而不是 range 起始 glyph。真实 PDF 里 range 可能
    // 跨越多个 pdf.js text item（如 " flows. This...by ensuring" 中起始是 space run
    // x=275.62，末尾是 text run x=278.46）。若新增 's' 继承起始 space 的 pdfTransform，
    // Export 会把它画到 x=275.62（"This" 前面），造成用户看到的错位/无法复制。
    const lastAnchorGlyph = originalGlyphs[end] ?? anchorGlyph;
    const baseTransform: TransformMatrix = anchorGlyph?.transform ?? firstOriginal.transform ?? IDENTITY_TRANSFORM;
    const baseMetrics = anchorGlyph?.metrics ?? firstOriginal.metrics;
    const fallbackTransform: TransformMatrix = lastAnchorGlyph?.transform ?? baseTransform;
    const fallbackMetrics = lastAnchorGlyph?.metrics ?? baseMetrics;
    const fallbackBaseline = lastAnchorGlyph?.baseline ?? anchorGlyph?.baseline;

    // 锚定 replacement 到原选区起始位置（不覆盖 suffix 的原位置）
    // 注意：空 range 插入时 start 位置原 glyph 的 originalBBox 可能未填充，
    // 优先用 originalBBox，缺失时回退到 bbox.x，绝不要回退到 firstOriginal.x（会把插入字符放到行首）。
    const anchorX = originalGlyphs[start]?.originalBBox?.x
      ?? originalGlyphs[start]?.bbox?.x
      ?? firstOriginal.originalBBox?.x
      ?? firstOriginal.bbox.x;
    const lineHeight = firstOriginal.bbox.height;
    const lineY = firstOriginal.bbox.y;

    let currentX = anchorX;
    const replacementGlyphs: EditableGlyph[] = [];
    Array.from(replacementText).forEach((newChar, i) => {
      // M7.8-037 (Provenance Propagation): 仅区间 [start, end] 内的原 glyph 才参与映射；
      //   超出 end 的 replacement 字符属于「插入」（无对应原 glyph）→ orig 必须为 undefined，
      //   否则会复用 originalGlyphs[start+i]（即 suffix 区域的原 glyph）→ 错绑其 operatorId，
      //   并导致 suffix 几何被重复计入（插入字符本应从 currentX 顺延，而非复制 suffix glyph）。
      const origIndex = start + i;
      const orig = origIndex <= end ? originalGlyphs[origIndex] : undefined;
      const charWidth = resolveReplacementCharWidth(newChar, orig, originalGlyphs, style, origIndex);
      // M7.8-035R: 保留每个原 glyph 的真实几何（x/y/height/baseline），只改 char + 自然 advance；
      //   绝不用 cumulative currentX 从锚点重新排版整行（旧实现会让编辑字符的宽度差传导到其后所有 glyph → 整行右移，即 BUG-1）。
      //   超出原选区的新增字符才从 currentX 顺延（使用行首的 y/height 兜底）。
      // M7.8-035R: 锚定到原 glyph 的 bbox（导入时必有；originalBBox 可能未填充，不能强依赖它）。
      const useOrigPos = !!orig && !!orig.bbox;
      const glyphBBox: BBox = {
        x: useOrigPos ? orig!.bbox.x : currentX,
        y: useOrigPos ? orig!.bbox.y : lineY,
        width: charWidth,
        height: useOrigPos ? orig!.bbox.height : lineHeight,
      };
      // M7.7-010B: 保留字符级 styleRef。每个 replacement glyph 继承原始位置 glyph 的 styleRef。
      // 如果 replacement 比原选区长（如 "Architecture"→"Architecture2"），
      // 超出原始 glyph 数组范围的字符使用最后一个原始 glyph 的 styleRef（行尾常规样式）。
      // 这比用第一个 glyph 的 styleRef 更合理，因为新增字符通常在行尾。
      const glyphStyleRef = (() => {
        if (orig?.styleRef !== undefined) return orig.styleRef;
        const lastGlyph = originalGlyphs[originalGlyphs.length - 1];
        if (lastGlyph?.styleRef !== undefined) return lastGlyph.styleRef;
        return styleRef;
      })();
      // M7.7-010.8: 继承原始位置 glyph 的 baseline（CSS 基线坐标）。
      // 确保 commit 后 glyph span 的 baseline 数据不丢失，用于 renderer 正确对齐。
      const glyphBaseline = orig?.baseline ?? fallbackBaseline;
      const glyph: EditableGlyph = {
        char: newChar,
        // M7.8-037 (Provenance Propagation): 每个 replacement glyph 必须继承其对应
        //   原位置 glyph 的 operatorId / operatorCharIndex —— 否则 Export 的
        //   stripReplacedTextOperators 无法按 operator provenance 剥离原算子 → 重影回归。
        //   注意：跨 operator 行（一行含多个 Tj/TJ）必须「逐 glyph」继承对应原 glyph 的
        //   operatorId（不能统一用 anchorGlyph 的 operatorId），否则整行 provenance 会被错绑到
        //   一个 operator → strip 误删/漏删。orig 为 undefined（replacement 超出原选区，新增字符）
        //   时保持 undefined（属「插入」，无原文算子可剥）。
        operatorId: orig?.operatorId,
        operatorCharIndex: orig?.operatorCharIndex,
        // M7.8-022A: originalChar 必须保留「原 PDF 字符」，不能写成 newChar。
        // 此前 originalChar = newChar 造成一级根因链：
        //   1) native-export-policy.buildNativeExportPlan 在 nativeReplacementState.originalText
        //      缺失（attemptNativeReplaceForLine 未成功，st 为 undefined）时，
        //      回退到 line.glyphs.map(g => g.originalChar ?? g.char).join("") 
        //   2) 该拼接被本处污染 → 拼出的是「新文本」而非原 PDF 文本
        //   3) native-batch-replace.resolveBoundRun 用这个「新文本」去匹配原 PDF 的 Tj/TJ 算子
        //      （r.operatorText === group.originalText）→ 匹配失败(not-found)或命中错误算子
        //   4) 结果：原 PDF 其他算子的文字仍留在原位 + 新文字画到错误位置
        //      → 用户看到「原文残留 + 修改行下移/换行」。
        // 保留原字符后，回退拼接得到的才是真正的原文，native 匹配得以正确工作。
        // 超出原选区的新增字符（orig 为 undefined）没有原字符，沿用 newChar。
        // M7.8-041-FIX-STALE：插入字符（orig 为 undefined，超出原选区）没有「原字符」，
        // 必须置 undefined（不能写成 newChar）。否则导出 strip 的文本兜底会以 newChar 当原文字，
        // 拼出 "4 Bidens 69r" 这类被插入字符污染的串，无法在流中匹配到原算子 → 整行不被
        // 判定为剥离干净 → 仍画白矩 mask 擦掉表格线。
        originalChar: orig ? (orig.originalChar ?? orig.char) : undefined,
        bbox: { ...glyphBBox },
        originalBBox: { ...glyphBBox },
        styleRef: glyphStyleRef,
        // M7.8-035R: 仅「真正改了字符」的 glyph 标 modified=true；前缀/后缀在 return 处重置为 false，
        //   避免第二次提交把第一次已提交字形重新纳入 mask 而遮住其下半部分（BUG-2）。
        modified: newChar !== (orig?.originalChar ?? orig?.char),
        // M7.7-003: 继承原 glyph transform（旋转/倾斜身份保持）
        // M7.8-035R2: 新增字符用 range 末尾 glyph 的 transform，避免落到错误 text run。
        transform: orig?.transform ?? fallbackTransform,
        // M7.7-010.8: 继承 baseline（原始 PDF baseline 坐标）
        baseline: glyphBaseline,
      };
      // M7.7-003: 继承 metrics（pdfTransform/fontIdentity 保持 → Export 可恢复原始 Tm/字体）
      // M7.8-035R2: 新增字符用 range 末尾 glyph 的 metrics，保证 pdfTransform 与行尾一致。
      const glyphMetrics = orig?.metrics ?? fallbackMetrics;
      if (glyphMetrics) {
        // M7.8-049: 仅当「字符已变化」或「orig 缺失/无 metrics」时清除 stale pdfCharCode。
        // 字符未变的字形（原 glyph 直接复用 / 仅改样式）保留自身正确的 pdfCharCode；
        // 字符变化的替换字形（如 69→619 中 '1' 替换 '9'，orig 仍存在但 char≠origChar）
        // 其 orig.metrics.pdfCharCode 是「旧字符」的码，必须清除 —— 否则 overlay 直发会把它
        // 渲染成旧字符（"699"/"Bidenssss"）；native replay 仍可经 unicodeToCharCode 重新推导正确码。
        // 插入字形(orig===undefined)同理清除。fontIdentity/pdfTransform/advanceWidth 始终保留。
        const charChanged = newChar !== (orig?.originalChar ?? orig?.char);
        const needsStrip = charChanged || !orig || !orig.metrics;
        glyph.metrics = needsStrip ? clearStaleCharCodeFromMetrics(glyphMetrics) : glyphMetrics;
      }
      replacementGlyphs.push(glyph);
      modifiedIndices.push(start + i);
      // M7.8-035R: 原 glyph 沿用其原始宽度（避免差值传导到后续）；新增字符才按自然宽度累加
      currentX = useOrigPos ? orig!.bbox.x + orig!.bbox.width : currentX + charWidth;
    });

    // ── M7.8-041-FIX: 后缀 glyph 按「替换宽度差」整体右移/左移 ──
    // 根因：插入/删除字符后，replacement 占据的宽度 ≠ 原选区宽度，但 suffix 仍停留在
    //   原 bbox.x → 与 replacement（尤其插入字符）重叠（视觉「压缩/粘连」）或留空洞。
    // M7.8-035R 为避免 BUG-1（整行右移）刻意不位移 suffix，但那仅在 replacement 与原选区
    //   等宽（shift=0）时成立；插入/删除必须位移 suffix 才能不重叠。
    // shift = 替换后总宽 − 原选区总宽：
    //   · shift=0（等宽替换，如 "79"→"78"）→ suffix 不动（仍正确，BUG-1 不复现）
    //   · shift>0（插入，如 "79"→"79123"）→ suffix 右移
    //   · shift<0（删除，如 "79123"→"79"）→ suffix 左移
    // 位移同时作用于 bbox / originalBBox / CSS transform[4] / metrics.pdfTransform[4]，
    // 保证编辑器显示与导出 Tm 一致。
    const originalRangeWidth = originalGlyphs
      .slice(start, end + 1)
      .reduce((sum, g) => sum + (g.bbox?.width ?? 0), 0);
    const replacementWidth = currentX - anchorX;
    const shift = replacementWidth - originalRangeWidth;

    // M7.8-043-FIX: 多列 / 表格文本「列对齐」保护。
    // 旧实现把 suffix（编辑点之后的全部 glyph）按同一 shift 整体平移，导致编辑某一列后，
    // 后续列（如「数量」列，文字居中）被整体推离原始列位置 → 列对齐 / 居中丢失
    // （用户报告导出 PDF 的「69」未居中，实测右偏 23.6pt）。
    // 修复：按「原始坐标」检测列边界——若某 suffix glyph 的原始左边界与上一 glyph
    // 原始右边界的间距远大于正常字距（列间隙，通常数百 pt vs 正常 < medianW*N），
    // 则该 glyph 及其之后属于另一个列，保持原始位置（不平移）。
    // 同列内仍按 shift 平移，保证普通单段文本（段落 / 单词）的重排不重叠（BUG-1 不复现）。
    const sortedW = originalGlyphs
      .map((g) => g.bbox?.width ?? 0)
      .filter((w) => w > 0.001)
      .sort((a, b) => a - b);
    const medianW = sortedW.length ? sortedW[Math.floor(sortedW.length / 2)] : 0;
    const colGapThreshold = Math.max(medianW * 4, 30);

    const applyShift = (g: EditableGlyph): EditableGlyph => {
      if (Math.abs(shift) < 0.01) return { ...g, modified: false };
      const ng: EditableGlyph = { ...g, modified: false };
      if (ng.bbox) ng.bbox = { ...ng.bbox, x: ng.bbox.x + shift };
      if (ng.originalBBox) ng.originalBBox = { ...ng.originalBBox, x: ng.originalBBox.x + shift };
      if (ng.transform) {
        ng.transform = [
          ng.transform[0], ng.transform[1], ng.transform[2], ng.transform[3],
          ng.transform[4] + shift, ng.transform[5],
        ];
      }
      if (ng.metrics?.pdfTransform) {
        const pt = ng.metrics.pdfTransform;
        ng.metrics = {
          ...ng.metrics,
          pdfTransform: [pt[0], pt[1], pt[2], pt[3], pt[4] + shift, pt[5]] as TransformMatrix,
        };
      }
      return ng;
    };

    // 按原始坐标顺序遍历 suffix：遇到列间隙即停止平移（之后所有 glyph 保持原位置）。
    //
    // M7.9-COLGAP-FIX：原实现只识别「空隙型」列间隙（gap = left - prevRight 很大），
    // 但表格列间隙常常由**超宽空格 operator** 撑开 —— 空格左边界紧邻前文（gap≈0），
    // 靠自身巨大宽度（实测 354.66pt）把下一列推到远处。此类间隙原检测完全漏掉，
    // 导致后续列被整体平移 shift（实测：「Begônia」→「Begônia fr」后数量列「10」右移 16pt）。
    // 修复：把「空白字符且宽度 > colGapThreshold」也判定为列分隔；并让**紧邻编辑区的
    // 第一个**列间隙吸收 shift（x 平移 shift、宽度反向补偿 shift），使其右边界保持不变，
    // 从而后续列完全停留在原始列位置（表格列对齐语义：列间隙伸缩，列位置不动）。
    const shiftedSuffix: EditableGlyph[] = [];
    let prevRight = anchorX + originalRangeWidth; // 已编辑区域在原始坐标下的右边界
    let stopShift = false;
    let absorbed = false; // 是否已有列间隙吸收过 shift（只吸收一次，避免多个间隙重复补偿）
    const minGapWidth = Math.max(medianW * 0.5, 1); // 列间隙压缩后的最小保留宽度

    /** 让列间隙吸收 shift：x 平移 shift，宽度反向补偿 shift → 右边界不变，后续列不动。 */
    const absorbShiftIntoGap = (g: EditableGlyph): EditableGlyph => {
      const ng: EditableGlyph = { ...g, modified: false };
      const w = ng.bbox?.width ?? 0;
      const newW = Math.max(minGapWidth, w - shift);
      if (ng.bbox) ng.bbox = { ...ng.bbox, x: ng.bbox.x + shift, width: newW };
      if (ng.originalBBox)
        ng.originalBBox = { ...ng.originalBBox, x: ng.originalBBox.x + shift, width: newW };
      if (ng.transform) {
        ng.transform = [
          ng.transform[0], ng.transform[1], ng.transform[2], ng.transform[3],
          ng.transform[4] + shift, ng.transform[5],
        ];
      }
      if (ng.metrics?.pdfTransform) {
        const pt = ng.metrics.pdfTransform;
        ng.metrics = {
          ...ng.metrics,
          pdfTransform: [pt[0], pt[1], pt[2], pt[3], pt[4] + shift, pt[5]] as TransformMatrix,
        };
      }
      return ng;
    };

    for (const g of suffixGlyphs) {
      const ob = g.originalBBox ?? g.bbox;
      const left = ob?.x ?? 0;
      const w = ob?.width ?? 0;
      const gap = left - prevRight;
      // 超宽空格＝列分隔（列间隙由该空格自身宽度撑开，而非 glyph 之间的空隙）。
      const isWideSpaceGap =
        (g.char === " " || g.originalChar === " ") && w > colGapThreshold;
      if (!stopShift && (gap > colGapThreshold || isWideSpaceGap)) {
        if (isWideSpaceGap && !absorbed) {
          shiftedSuffix.push(absorbShiftIntoGap(g)); // 该间隙吸收 shift，右边界保持不变
          absorbed = true;
        } else {
          shiftedSuffix.push({ ...g, modified: false });
        }
        stopShift = true; // 之后所有列保持原位置
      } else {
        shiftedSuffix.push(stopShift ? { ...g, modified: false } : applyShift(g));
      }
      prevRight = left + w; // 用原始右边界推进（列间隙存在于原始坐标）
    }

    // M7.8-042-ORPHAN：replacement 比原选区 [start..end] 短时，尾部原 glyph
    // （如 "100%"→"99%" 的原 "%"）被丢弃，其 operatorId 不再出现在新 glyph 数组里。
    // 这些「孤儿算子」仍留在 content stream → 必须收集并交导出剥离，否则原字符残留成重影。
    const consumedCount = replacementGlyphs.length;
    const droppedOperatorIds =
      start + consumedCount <= end
        ? originalGlyphs
            .slice(start + consumedCount, end + 1)
            .map((g) => g.operatorId)
            .filter((id): id is string => typeof id === "string" && id.length > 0)
            .filter((id, i, arr) => arr.indexOf(id) === i)
        : [];

    return {
      // M7.8-035R: 前缀 glyph 保持原位（编辑前内容不动）。
      //   后缀 glyph（含上一轮已提交的编辑）重置 modified=false 并按 shift 位移
      //   （跨列时停止平移，保持列对齐），确保下一轮提交只为「本轮真正改动的 glyph」生成 mask
      //   （修复 BUG-2 二次提交遮挡第一次）。
      newGlyphs: [
        ...prefixGlyphs.map((g) => ({ ...g, modified: false })),
        ...replacementGlyphs,
        ...shiftedSuffix,
      ],
      modifiedIndices,
      originalCount: originalGlyphs.length,
      newCount: prefixGlyphs.length + replacementGlyphs.length + suffixGlyphs.length,
      droppedOperatorIds,
    };
  }

  const lineHeight = firstOriginal.bbox.height;
  const lineY = firstOriginal.bbox.y;
  const startX = firstOriginal.originalBBox?.x ?? firstOriginal.bbox.x;
  // M7.8-035R2: 整行重写/行尾追加时，新增字符应沿用行**末尾** glyph 的 transform/metrics/baseline，
  // 而不是行首 glyph。行首可能是另一个 text run（如本 PDF 行首 "system" run x=53.56），
  // 而行尾 "ensuring" run x=278.46；若追加 's' 继承行首 run，会画到行首。
  const lastOriginal = originalGlyphs[originalGlyphs.length - 1];

  let currentX = startX;

  newChars.forEach((newChar, i) => {
    const originalGlyph = originalGlyphs[i];
    const charWidth = resolveReplacementCharWidth(newChar, originalGlyph, originalGlyphs, style, i);

    // 锚定到原 glyph 的 originalBBox.x（保持位置）
    const anchorX = originalGlyph
      ? (originalGlyph.originalBBox?.x ?? originalGlyph.bbox.x)
      : currentX; // 超出原 glyph 数量时，在行尾追加

    const glyphBBox: BBox = {
      x: anchorX,
      y: lineY,
      width: charWidth,
      height: lineHeight,
    };

    const originalChar = originalGlyph?.originalChar ?? originalGlyph?.char;
    const isModified = newChar !== originalChar;

    if (isModified && originalGlyph) {
      modifiedIndices.push(i);
    }

    const nextGlyph: EditableGlyph = {
      char: newChar,
      originalChar,
      bbox: { ...glyphBBox },
      // originalBBox 保持原 glyph 的（用于 Diff 和回退）
      originalBBox: originalGlyph
        ? { ...(originalGlyph.originalBBox ?? originalGlyph.bbox) }
        : { ...glyphBBox },
      styleRef,
      modified: isModified,
      // 编辑后保留原 glyph 的 transform（旋转/倾斜角度不变）
      // M7.8-035R2: 新增字符沿用行尾 glyph 的 transform，避免落到错误 text run。
      transform: originalGlyph?.transform ?? lastOriginal?.transform ?? IDENTITY_TRANSFORM,
      // M7.7-010.8: 继承 baseline（原始 PDF baseline 坐标）
      baseline: originalGlyph?.baseline ?? lastOriginal?.baseline,
      // M7.8-037 (Provenance Propagation): 整行重写路径同样逐 glyph 继承对应原 glyph 的
      //   operatorId / operatorCharIndex（跨 operator 行防止错绑到一个 operator）。
      //   originalGlyph 为 undefined（行尾追加的新字符）时保持 undefined（插入，无原文算子）。
      operatorId: originalGlyph?.operatorId,
      operatorCharIndex: originalGlyph?.operatorCharIndex,
    };
    // ── M7.8-034 Phase C: 继承原 glyph 的 metrics（pdfTransform / fontIdentity / advanceWidth）──
    // 非 range 路径（整行重写 / 行尾 append）此前完全没有继承 metrics，
    // 导致编辑后每个 glyph 的 metrics 全部丢失：
    //   → export 命令的 fontIdentity 为 undefined
    //   → Phase C「原字体 + raw CID + trueAdvance + 原 baseline」无法触发
    //   → 只能回落 Standard 14 / PNG 重绘 → 用户报告的「导出后字体/大小/样式全变」。
    // M7.8-035R2: 新增字符（originalGlyph 为 undefined）沿用行**尾** glyph 的 metrics，
    // 保证追加字符位于正确的 text run（而不是行首 run）。
    const inheritedMetrics = originalGlyph?.metrics ?? lastOriginal?.metrics ?? firstOriginal.metrics;
    if (inheritedMetrics) {
      // M7.8-049: 字符变化 / 行尾追加(originalGlyph===undefined)时清除 stale pdfCharCode，
      // 字符未变的字形保留自身正确的 pdfCharCode，行为不变。fontIdentity 等始终保留。
      const charChanged = newChar !== (originalGlyph?.originalChar ?? originalGlyph?.char);
      const needsStrip = charChanged || !originalGlyph || !originalGlyph.metrics;
      nextGlyph.metrics = needsStrip ? clearStaleCharCodeFromMetrics(inheritedMetrics) : inheritedMetrics;
    }
    newGlyphs.push(nextGlyph);

    // 下一个字符的 x：如果下一个原 glyph 存在，用其 originalBBox.x；
    // 否则累加当前宽度（行尾追加）
    const nextOriginal = originalGlyphs[i + 1];
    if (nextOriginal) {
      currentX = nextOriginal.originalBBox?.x ?? nextOriginal.bbox.x;
    } else {
      currentX = anchorX + charWidth;
    }
  });

  // M7.8-042-ORPHAN：整行重写比原文短时（如 "abcdef"→"abc"），尾部原 glyph 被丢弃，
  // 其 operatorId 同样成为孤儿 → 收集交导出剥离，防止原字符残留成重影。
  const wholeLineDropped =
    newChars.length < originalGlyphs.length
      ? originalGlyphs
          .slice(newChars.length)
          .map((g) => g.operatorId)
          .filter((id): id is string => typeof id === "string" && id.length > 0)
          .filter((id, i, arr) => arr.indexOf(id) === i)
      : [];

  return {
    newGlyphs,
    modifiedIndices,
    originalCount: originalGlyphs.length,
    newCount: newGlyphs.length,
    droppedOperatorIds: wholeLineDropped,
  };
}

/**
 * 为空行创建 glyph（无原 glyph 参考时）。
 */
function createGlyphsForEmptyLine(
  chars: string[],
  style: EditableStyle,
  styleRef: number,
  startX: number,
  startY: number
): GlyphMappingResult {
  const lineHeight = style.lineHeight || (style.fontSize || 14) * 1.3;
  const glyphs: EditableGlyph[] = [];
  let currentX = startX;

  chars.forEach((char) => {
    const charWidth = measureCharWidth(char, style);
    const bbox: BBox = {
      x: currentX,
      y: startY,
      width: charWidth,
      height: lineHeight,
    };
    glyphs.push({
      char,
      originalChar: char,
      bbox: { ...bbox },
      originalBBox: { ...bbox },
      styleRef,
      modified: false,
      // 空行创建的 glyph 默认无旋转
      transform: IDENTITY_TRANSFORM,
    });
    currentX += charWidth;
  });

  return {
    newGlyphs: glyphs,
    modifiedIndices: [],
    originalCount: 0,
    newCount: glyphs.length,
  };
}

/**
 * 替换 block 中某行的文本。
 *
 * 用于用户编辑场景：
 *   1. 找到目标行
 *   2. 用 mapNewTextToOriginalGlyphs 映射新文本到原 glyph 位置
 *   3. 替换行的 glyphs
 *   4. 保持行的 bbox 和 style 不变
 *
 * @param block 目标 block
 * @param lineIndex 行索引
 * @param newText 新文本
 * @param styles 文档级样式表
 * @returns 新的 EditableBlock（仅目标行被替换）
 */
export function replaceLineText(
  block: EditableBlock,
  lineIndex: number,
  newText: string,
  styles?: EditableStyle[],
  range?: { start: number; end: number }
): EditableBlock {
  const line = block.lines[lineIndex];
  if (!line) return block;

  const style = line.style || (styles ? styles[line.glyphs[0]?.styleRef ?? 0] : {}) || {};
  const styleRef = line.glyphs[0]?.styleRef ?? 0;

  const mapResult = mapNewTextToOriginalGlyphs(
    line.glyphs,
    newText,
    style,
    styleRef,
    range
  );
  const { newGlyphs, droppedOperatorIds } = mapResult;

  const newLines = [...block.lines];
  newLines[lineIndex] = {
    ...line,
    glyphs: newGlyphs,
    // M7.8-042-ORPHAN：变短编辑丢弃的原 glyph 算子累加到行，供导出剥离（防重影）。
    droppedOperatorIds:
      droppedOperatorIds && droppedOperatorIds.length > 0
        ? [...(line.droppedOperatorIds ?? []), ...droppedOperatorIds].filter(
            (id, i, arr) => arr.indexOf(id) === i,
          )
        : line.droppedOperatorIds,
    // 保持行 bbox 不变（位置不变，不影响下一行）
  };

  return {
    ...block,
    lines: newLines,
  };
}

/**
 * 在 block 中查找包含指定文本的行并替换。
 *
 * 便捷方法：用户输入 "JENNIFER" → "MARIA"，
 * 自动找到包含 "JENNIFER" 的行并替换。
 *
 * @param block 目标 block
 * @param oldText 要查找的原文
 * @param newText 要替换的新文本
 * @param styles 文档级样式表
 * @returns 新的 EditableBlock（如果找到匹配则替换，否则原样返回）
 */
export function findAndReplaceInBlock(
  block: EditableBlock,
  oldText: string,
  newText: string,
  styles?: EditableStyle[]
): EditableBlock {
  for (let i = 0; i < block.lines.length; i++) {
    const lineText = block.lines[i].glyphs.map((g) => g.char).join("");
    if (lineText.includes(oldText)) {
      const replacedText = lineText.replace(oldText, newText);
      return replaceLineText(block, i, replacedText, styles);
    }
  }
  return block;
}
