/**
 * geometry-pipeline.ts — Geometry Analyzer（P0-010）
 *
 * 职责：从 OCR block 的原始 Facts（text / bbox / label / image crop / provider angle）
 *       计算几何信息（rotation / transform / confidence）。
 *
 * ADR-004「Geometry Is Fact, Not Policy」：
 *   - Geometry Analyzer 只做 Enrichment（增加 geometry 字段）。
 *   - 本模块不输出 signature / paragraph / stamp（那是 Region Policy 的职责）。
 *   - Decision Gate（shouldAnalyze）与 Algorithm Selector（chooseGeometryStrategy）
 *     均基于 OCR Facts，不依赖 classifyRegion() / needsGeometryDetection()。
 */

import type { OcrTextBlock } from "./ocr-storage";
import {
  detectGeometry,
  angleToTransformMatrix,
} from "../document-model/geometry-detector";
import {
  analyzeSignatureGeometryCandidates,
  evaluateAgreement,
  type GeometryAnalysis,
  type GeometryCandidate,
  type CandidateAgreement,
} from "../document-model/signature-geometry-analyzer";
import { GeometryDecisionReason, type GeometryDecisionTraceBuilder } from "../document-model/geometry-decision-trace";

/** OCR 渲染视口缩放（与 ocr-utils.ts RENDER_SCALE 一致） */
const RENDER_SCALE = 2.0;
/** 编辑器 canvas 缩放（与 ocr-utils.ts EDITOR_SCALE 一致） */
const EDITOR_SCALE = 1.5;

/**
 * Decision Gate — 判断是否需要对 block 进行 Geometry 检测（P0-010 Commit 2C）。
 *
 * 基于 OCR Facts（通过 chooseGeometryStrategy）判断是否有可执行的检测策略。
 * 不依赖 classifyRegion() / needsGeometryDetection()。
 *
 * @param block OCR block（OCR Facts）
 * @param pageHeight 页面高度（canvas-pixel space）
 * @returns 是否进入 Geometry Pipeline
 */
export function shouldAnalyze(
  block: OcrTextBlock,
  pageHeight: number
): boolean {
  // P0-010 Commit 2C：Gate 与 Selector 统一，都基于 OCR Facts（不依赖 classifyRegion）。
  // shouldAnalyze = chooseGeometryStrategy 非 Skip，即"是否有可执行的检测策略"。
  const strategy = chooseGeometryStrategy(block, pageHeight);
  // Task-W2-3C Trace：打印"为什么 Skip"的具体 reason，而非仅 Skip。
  if (strategy === "Skip") {
    const labelLower = (block.label || "").toLowerCase().trim();
    const text = block.text || "";
    const providerAngle = (block as any)._providerAngle as number | undefined;
    let skipReason: string;
    if (labelLower && ["signature", "sign", "signed_name", "autograph", "stamp", "seal", "red_seal", "redstamp"].includes(labelLower)) {
      skipReason = "SkipByUnknown"; // label 命中但 strategy 仍 Skip，理论不应发生
    } else if (providerAngle !== undefined && !isNaN(providerAngle) && Math.abs(providerAngle) > 0.1) {
      skipReason = "SkipByUnknown"; // providerAngle 明显倾斜仍 Skip，理论不应发生
    } else if (/seal|stamp|official seal|公章|专用章|医疗专用章|诊断专用章|证明专用章/i.test(text)) {
      skipReason = "SkipByUnknown";
    } else if (/dr\.|dra\.|doutor|doutora|crm|m[eé]dico|m[eé]dica|physician|physician signature|attending physician/i.test(text)) {
      skipReason = "SkipByBottomPosition"; // 医生关键词命中但不在底部
    } else if (providerAngle !== undefined && Math.abs(providerAngle) > 0.1) {
      skipReason = "SkipByUnknown";
    } else {
      skipReason = "SkipByNoSignal"; // label/text/angle 均无签名信号
    }
    console.log(
      `[SignatureRotationTrace] Stage:ShouldAnalyze Block:${block.id} ` +
        `label:${JSON.stringify(block.label)} text:${JSON.stringify(text.slice(0, 30))} ` +
        `providerAngle:${providerAngle} strategy:Skip reason:${skipReason}`,
    );
  }
  return strategy !== "Skip";
}

/** Geometry 检测策略（P0-010 Commit 2B） */
export type GeometryStrategy =
  | "SignatureImage"   // 签名 → analyzeSignatureGeometry
  | "StampImage"       // 印章 → detectGeometry
  | "Skip";            // 其他 → 不检测

/** OCR label → 预设策略（OCR Facts 直接映射，不经 classifyRegion） */
const LABEL_STRATEGY: Record<string, GeometryStrategy> = {
  signature: "SignatureImage",
  sign: "SignatureImage",
  signed_name: "SignatureImage",
  autograph: "SignatureImage",
  stamp: "StampImage",
  seal: "StampImage",
  red_seal: "StampImage",
  redstamp: "StampImage",
};

/** 医生签名特征关键词（与 signature-layout-normalizer 一致，基于 OCR Facts） */
const DOCTOR_KEYWORD_RE =
  /dr\.|dra\.|doutor|doutora|crm|m[eé]dico|m[eé]dica|physician|physician signature|attending physician/i;

/** 印章关键词（基于 OCR Facts） */
const STAMP_KEYWORD_RE = /seal|stamp|official seal|公章|专用章|医疗专用章|诊断专用章|证明专用章/i;

/** 是否位于页面底部区域（签名常见位置） */
function isBottomArea(y: number, h: number, pageHeight: number): boolean {
  return pageHeight > 0 && y + h > pageHeight * 0.7;
}

/**
 * Algorithm Selector — 选择 Geometry 检测策略（P0-010 Commit 2C）。
 *
 * 依赖 OCR Facts（label / text / bbox / providerAngle），**不依赖 classifyRegion()**。
 * 这样 Dr. Jefferson（GLM label="text"，被 classifyRegion 判为 paragraph）
 * 也能通过医生关键词 + 底部位置进入 SignatureImage，从而真正进入 analyzeSignatureGeometry()。
 *
 * 优先级：
 *   1. OCR 原始 label 直接映射（signature → SignatureImage，stamp → StampImage）
 *   2. 文本关键词 + 位置（医生签名 → SignatureImage，印章 → StampImage）
 *   3. providerAngle 明显倾斜 → SignatureImage（候选旋转文本）
 *   4. 其他 → Skip
 */
export function chooseGeometryStrategy(
  block: OcrTextBlock,
  pageHeight: number,
  trace?: GeometryDecisionTraceBuilder
): GeometryStrategy {
  // 1. OCR 原始 label 直接映射（OCR Facts，不经 classifyRegion）
  if (block.label) {
    const labelLower = block.label.toLowerCase().trim();
    const mapped = LABEL_STRATEGY[labelLower];
    if (mapped) {
      // Task-W2-3C Trace-2：打印入参 + 返回值
      console.log(
        `[SignatureRotationTrace] Stage:ChooseStrategy Block:${block.id} ` +
          `label:${JSON.stringify(block.label)} providerAngle:${(block as any)._providerAngle} ` +
          `text:${JSON.stringify((block.text || "").slice(0, 30))} strategy:${mapped} via:Label`,
      );
      return mapped;
    }
  }

  const text = block.text || "";

  // 2. 文本关键词 + 位置：医生签名 / 印章
  if (STAMP_KEYWORD_RE.test(text)) {
    console.log(
      `[SignatureRotationTrace] Stage:ChooseStrategy Block:${block.id} ` +
        `label:${JSON.stringify(block.label)} providerAngle:${(block as any)._providerAngle} ` +
        `text:${JSON.stringify(text.slice(0, 30))} strategy:StampImage via:StampKeyword`,
    );
    return "StampImage";
  }
  if (DOCTOR_KEYWORD_RE.test(text) && isBottomArea(block.y, block.h, pageHeight)) {
    console.log(
      `[SignatureRotationTrace] Stage:ChooseStrategy Block:${block.id} ` +
        `label:${JSON.stringify(block.label)} providerAngle:${(block as any)._providerAngle} ` +
        `text:${JSON.stringify(text.slice(0, 30))} strategy:SignatureImage via:DoctorKeyword`,
    );
    return "SignatureImage";
  }

  // 3. providerAngle 明显倾斜 → 候选旋转文本（签名/手写）
  const providerAngle = (block as any)._providerAngle as number | undefined;
  if (providerAngle !== undefined && !isNaN(providerAngle) && Math.abs(providerAngle) > 0.1) {
    console.log(
      `[SignatureRotationTrace] Stage:ChooseStrategy Block:${block.id} ` +
        `label:${JSON.stringify(block.label)} providerAngle:${providerAngle} ` +
        `text:${JSON.stringify(text.slice(0, 30))} strategy:SignatureImage via:ProviderAngle`,
    );
    return "SignatureImage";
  }

  // 4. 其他 → Skip
  console.log(
    `[SignatureRotationTrace] Stage:ChooseStrategy Block:${block.id} ` +
      `label:${JSON.stringify(block.label)} providerAngle:${providerAngle} ` +
      `text:${JSON.stringify(text.slice(0, 30))} strategy:Skip`,
  );
  return "Skip";
}

/** Agreement 对 score 的加权（P0-012 Commit 3）：score = confidence + agreement * weight */
const AGREEMENT_WEIGHT = 0.6;

/**
 * chooseBestCandidate — 从 GeometryAnalysis 中选出最优候选（P0-011 Commit 3）。
 *
 * P0-012 Commit 2：签名增加 agreement 参数，但暂时忽略（行为完全一致）。
 * P0-012 Commit 3：真正改变行为。
 *   score = confidence + agreement.agreement * AGREEMENT_WEIGHT
 *   按 score 降序取第一个；把 score 写入所选候选的 metadata.score，供 pipeline 判定。
 *
 * 例（Dr. Jefferson）：baseline confidence=0.15, agreement=0.81
 *   score = 0.15 + 0.81*0.6 = 0.636 ≥ 0.5 → 突破 identity，输出 -7.5°。
 *
 * @param analysis Analyzer 的完整产出
 * @param agreement 候选之间的 Agreement
 * @returns 最优候选（metadata.score 为计算后的 score），或 null（无候选）
 */
export function chooseBestCandidate(
  analysis: GeometryAnalysis,
  agreement?: CandidateAgreement
): GeometryCandidate | null {
  if (!analysis.candidates || analysis.candidates.length === 0) return null;

  const agreementValue = agreement?.agreement ?? 0;

  // 为每个候选计算 score = confidence + agreement * weight
  const scored = analysis.candidates.map(c => {
    const score = c.confidence + agreementValue * AGREEMENT_WEIGHT;
    return { candidate: c, score };
  });

  // 按 score 降序，取第一个
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].candidate;

  // 把 score 写入所选候选 metadata，供 pipeline 判定
  best.metadata = { ...(best.metadata ?? {}), score: Math.round(scored[0].score * 100) / 100 };

  console.log("[P0-012][chooseBestCandidate]", {
    candidates: analysis.candidates.map(c => ({
      method: c.method,
      angle: c.angle,
      confidence: c.confidence,
      score: c.confidence + agreementValue * AGREEMENT_WEIGHT,
    })),
    agreement: agreement ?? null,
    AGREEMENT_WEIGHT,
    chosen: {
      method: best.method,
      angle: best.angle,
      confidence: best.confidence,
      score: best.metadata.score,
    },
  });
  return best;
}

/**
 * 为页面内所有 OCR block 检测几何变换（原地写入 block.geometry）。
 *
 * 输入：
 *   - blocks：同一页的 OCR block（含 _providerAngle / _ocrCanvasBbox 临时字段）
 *   - canvas：整页渲染 canvas（scale=2.0，用于 image crop）
 *
 * 输出：
 *   - 对可检测的 block 写入 geometry；对不可检测的 block 保持 geometry=undefined。
 *   - 清理 _providerAngle / _ocrCanvasBbox 临时字段。
 *
 * @param blocks OCR block 列表（可变，原地写入 geometry）
 * @param canvas 整页渲染 canvas（scale=2.0）
 */
export function buildGeometryForBlocks(
  blocks: OcrTextBlock[],
  canvas: HTMLCanvasElement,
  trace?: GeometryDecisionTraceBuilder
): void {
  // blocks 坐标已在 runPageOCR 内经 EDITOR_SCALE/RENDER_SCALE 缩放（scale=1.5）。
  // canvas 是 scale=2.0。pageHeight 必须与 block 坐标同坐标系（scale=1.5），
  // 否则 isBottomArea / shouldAnalyze 的底部判断会因坐标系错位而失效。
  const pageHeightOcrSpace = canvas.height * (EDITOR_SCALE / RENDER_SCALE); // scale=1.5，与 block 坐标一致
  for (const b of blocks) {
    // P0-010 Commit 2C：统一入口，基于 OCR Facts 判断是否有可执行的检测策略。
    if (!shouldAnalyze(b, pageHeightOcrSpace)) {
      // 非签名/印章区域，清理临时字段，不做 geometry 检测
      delete (b as any)._providerAngle;
      delete (b as any)._ocrCanvasBbox;
      continue;
    }

    // Algorithm Selector（P0-010 Commit 2B）：进入后选择检测策略。
    const strategy = chooseGeometryStrategy(b, pageHeightOcrSpace);
    if (strategy === "Skip") {
      // 理论上 shouldAnalyze=true 后不会到 Skip，防御性处理
      delete (b as any)._providerAngle;
      delete (b as any)._ocrCanvasBbox;
      continue;
    }

    const providerAngle = (b as any)._providerAngle as number | undefined;
    const ocrCanvasBbox = (b as any)._ocrCanvasBbox as { x: number; y: number; w: number; h: number } | undefined;

    // S37-2A ProviderAngle Stage（观察，不影响判断逻辑；Builder 拥有 Trace Schema）
    if (trace) {
      trace.providerAngle({
        input: providerAngle,
        output: providerAngle,
        reason: providerAngle !== undefined
          ? GeometryDecisionReason.FromOCRMetaData
          : GeometryDecisionReason.CandidateRejected,
      });
    }

    // 从原始 page canvas crop 图像区域（用于 image analysis fallback）
    let imageCrop: HTMLCanvasElement | undefined;
    if (ocrCanvasBbox && canvas) {
      try {
        const cropX = Math.max(0, Math.round(ocrCanvasBbox.x));
        const cropY = Math.max(0, Math.round(ocrCanvasBbox.y));
        const cropW = Math.min(Math.round(ocrCanvasBbox.w), canvas.width - cropX);
        const cropH = Math.min(Math.round(ocrCanvasBbox.h), canvas.height - cropY);
        if (cropW > 2 && cropH > 2) {
          imageCrop = document.createElement("canvas");
          imageCrop.width = cropW;
          imageCrop.height = cropH;
          const cropCtx = imageCrop.getContext("2d");
          if (cropCtx) {
            cropCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
          }
        }
      } catch {
        // crop 失败，跳过 image analysis
      }
    }

    // 检测 geometry（P0-010 Commit 2B：Algorithm Selector 由 strategy 决定）
    // - SignatureImage → SignatureGeometryAnalyzer（PCA 矩法，对笔迹鲁棒）
    // - StampImage     → detectGeometry（投影剖面法，对印章图案效果好）
    switch (strategy) {
      case "SignatureImage": {
        // 保持旧行为：需 imageCrop 才走签名分析；无 crop 时回退到 detectGeometry（与旧 else 一致）
        if (!imageCrop) {
          b.geometry = detectGeometry(providerAngle, imageCrop);
          break;
        }
        // ── Debug: 输出 OCR bbox 并保存 crop canvas 到 window ──
        const ocrBbox = { x: b.x, y: b.y, width: b.w, height: b.h };
        const cropSize = { w: imageCrop.width, h: imageCrop.height };
        console.log("[SignatureGeometryAnalyzer] OCR bbox:", ocrBbox);
        // 保存到 window 供开发者检查 crop 是否精确覆盖签名区域
        (window as any).__signatureDebugCrop = imageCrop;

        // 优先使用 OCR provider angle（GLM-OCR 的 angle 字段）
        if (providerAngle !== undefined && !isNaN(providerAngle) && Math.abs(providerAngle) > 0.1) {
          b.geometry = {
            angle: providerAngle,
            transform: angleToTransformMatrix(providerAngle),
          };
          // Task-W2-3B Trace：记录 Geometry 输出角度
          console.log(
            `[SignatureRotationTrace] Stage:Geometry Block:${b.id} ` +
              `angle:${providerAngle.toFixed ? providerAngle.toFixed(3) : providerAngle} ` +
              `transformRotation:${providerAngle.toFixed ? providerAngle.toFixed(3) : providerAngle}`,
          );
          console.log("[SignatureGeometryAnalyzer] debug:", {
            text: b.text.length > 40 ? b.text.slice(0, 37) + "..." : b.text,
            ocrBbox,
            cropSize,
            componentCount: -1,
            method: "provider",
            angle: providerAngle,
            confidence: 1,
          });
        } else {
          // P0-011 Commit 2/3/4：Analyzer 只 Produce Candidates，Pipeline 负责 Choose。
          // P0-012 Commit 2：计算 Agreement 并传入 chooseBestCandidate。
          // P0-012 Commit 3：chooseBestCandidate 用 score = confidence + agreement*weight 排序，
          //   并把 score 写入 candidate.metadata.score；此处用 score 判定 identity。
          const analysis = analyzeSignatureGeometryCandidates(imageCrop);
          const agreement = evaluateAgreement(analysis.candidates);
          const candidate = chooseBestCandidate(analysis, agreement);
          const score = (candidate?.metadata?.score as number) ?? candidate?.confidence ?? 0;

          // S37-2A-2 CandidateGeneration Stage（观察，不影响判断逻辑）
          // 只记录 generatedCount；accepted/rejected 属未来 CandidateFiltering Stage。
          if (trace) {
            trace.candidateGeneration({
              generatedCount: analysis.candidates.length,
              reason: analysis.candidates.length > 0
                ? GeometryDecisionReason.CandidateAccepted
                : GeometryDecisionReason.CandidateRejected,
            });
          }

          // S37-2A-3 Baseline Stage（观察，不影响判断逻辑）
          // 只观察 baseline 候选（regression angle / confidence），不观察下游（pcaAngle）。
          if (trace) {
            const baselineCandidate = analysis.candidates.find((c) => c.method === "baseline");
            if (baselineCandidate) {
              trace.baseline({
                input: analysis.candidates.length,
                observation: { value: baselineCandidate.angle, unit: "degree" },
                confidence: baselineCandidate.confidence,
                output: { angle: baselineCandidate.angle },
                reason: GeometryDecisionReason.BaselineRegression,
              });
            }
          }

          // S37-2A-4 PCA Stage（观察，不影响判断逻辑）
          // 只观察 pca 候选（eigenAngle / confidence），不观察下游（strategy 禁止）。
          if (trace) {
            const pcaCandidate = analysis.candidates.find((c) => c.method === "pca");
            if (pcaCandidate) {
              trace.pca({
                input: { angle: candidate?.angle ?? 0 },
                observation: { value: pcaCandidate.angle, unit: "degree" },
                confidence: pcaCandidate.confidence,
                output: { angle: pcaCandidate.angle },
                reason: GeometryDecisionReason.PCAEigenVector,
              });
            }
          }

          // score < 0.5 或 无候选 → 不信任旋转检测，强制 identity（signature image preserve）
          if (!candidate || score < 0.5) {
            b.geometry = { angle: 0, transform: [1, 0, 0, 1, 0, 0] };
            console.log("[SignatureGeometryAnalyzer] debug (low confidence — fallback to identity):", {
              text: b.text.length > 40 ? b.text.slice(0, 37) + "..." : b.text,
              ocrBbox,
              cropSize,
              componentCount: candidate?.metadata?.componentCount ?? 0,
              method: candidate?.method ?? "none",
              angle: 0,
              confidence: candidate?.confidence ?? 0,
              score,
            });
          } else {
            b.geometry = {
              angle: candidate.angle,
              transform: angleToTransformMatrix(candidate.angle),
            };
            console.log("[SignatureGeometryAnalyzer] debug:", {
              text: b.text.length > 40 ? b.text.slice(0, 37) + "..." : b.text,
              ocrBbox,
              cropSize,
              componentCount: candidate.metadata?.componentCount ?? 0,
              method: candidate.method,
              angle: candidate.angle,
              confidence: candidate.confidence,
              score,
            });

            // S37-2A-5 Normalize Stage（观察，不影响判断逻辑）
            // 【Must Fix】output 记录 Runtime 实际交付给下一 Stage 的值（candidate.angle），
            // 不自算规范化（Trace must observe runtime, never reinterpret runtime）。
            // confidence 留空（确定性转换）。
            if (trace) {
              trace.normalize({
                input: candidate.angle,
                observation: { value: candidate.angle, unit: "degree" },
                output: { angle: candidate.angle }, // Runtime 实际输出
                reason: GeometryDecisionReason.AngleNormalization,
              });
            }
          }
        }
        break;
      }

      case "StampImage":
      default:
        // stamp → 使用原有的 detectGeometry（投影剖面迭代搜索）
        b.geometry = detectGeometry(providerAngle, imageCrop);
        break;
    }

    // S37-2A-6 StrategySelection Stage（观察，不影响判断逻辑）
    // 【Must Fix 1】记录"哪个几何候选成为最终角度"（Candidate Selection），非 GeometryStrategy。
    // 【Must Fix 2】output 必须 === Runtime 实际写入 geometry.angle（最后一个 Stage 的 output 一致性）。
    if (trace) {
      const finalAngle = b.geometry?.angle ?? 0;
      trace.strategySelection({
        input: { angle: finalAngle },
        observation: { value: true, unit: "flag" },
        confidence: 1,
        output: { angle: finalAngle },
        reason: GeometryDecisionReason.HigherConfidence,
      });
    }

    // 清理临时字段
    delete (b as any)._providerAngle;
    delete (b as any)._ocrCanvasBbox;
  }
}
