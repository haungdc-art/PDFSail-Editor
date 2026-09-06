/**
 * ProductionWiring — Sprint36 · Task RG-5A
 *
 * 把 Runtime Validation 旁路接入真实生产链路（不影响生产行为）。
 *
 *   Production（OCR blocks + pdfDoc）
 *        ↓
 *   runDualRun（Old/New 独立 Runtime）
 *        ↓
 *   RuntimeTelemetry.record（Raw Events）
 *        ↓
 *   ObservationEvidence（累积）
 *
 * 【RG-5A Story Goal】Connect Runtime Validation into the real production
 * pipeline without changing production behavior.
 *
 * 【约束】
 *   - 不影响业务：全程 try/catch，任何失败不影响生产。
 *   - Old Path 保持 100% Active（本模块只旁路观察，不改旧调用）。
 *   - 只产生真实 Observation Evidence，不输出 Ready/Not Ready（Release 属 RG-5B）。
 *   - 不修改生产文件（geometry-pipeline / PDFEditor 主流程）。
 */

import type { OcrTextBlock } from "../ocr/ocr-storage";
import type { GeometryExecutor } from "./real-geometry-consumer";
import { buildGeometryForBlocks } from "../ocr/geometry-pipeline";
import { runDualRun } from "./dual-run";
import { runtimeTelemetry } from "./runtime-telemetry";

/**
 * Production Wiring 输入 — 生产环境提供的真实数据。
 */
export interface ProductionWiringInput {
  /** 文档 id（用于 Telemetry 记录） */
  docId: string;
  /** 该文档的 OCR blocks（真实生产数据，已带 OCR geometry 临时字段） */
  ocrBlocks: OcrTextBlock[];
  /** 按页码渲染页面 canvas（生产环境提供，如 renderPageToCanvas(pdf, pageNum)） */
  renderCanvas: (pageNum: number) => Promise<HTMLCanvasElement>;
}

/** 默认 Old/New Executor（当前阶段共用 buildGeometryForBlocks，见 ADR-014） */
const makeDefaultExecutor = (): GeometryExecutor => ({
  execute(request) {
    buildGeometryForBlocks(request.blocks, request.canvas);
  },
});

/**
 * 执行旁路 Production Wiring。
 *
 * 只观察，不改变生产行为。任何异常被吞掉（不影响生产）。
 *
 * @param input 生产数据（OCR blocks + canvas 渲染器 + docId）
 */
export async function runProductionWiring(input: ProductionWiringInput): Promise<void> {
  try {
    // 按页码分组 blocks（不可变 snapshot 的原料）
    const byPage = new Map<number, OcrTextBlock[]>();
    for (const b of input.ocrBlocks) {
      const page = b.page ?? 1;
      if (!byPage.has(page)) byPage.set(page, []);
      byPage.get(page)!.push(b);
    }

    for (const [pageNum, pageBlocks] of byPage) {
      try {
        const canvas = await input.renderCanvas(pageNum);
        if (!canvas) continue;

        // 同一 immutable snapshot 驱动 Old 与 New（独立 Executor）
        const report = runDualRun(
          { blocks: pageBlocks, canvas },
          makeDefaultExecutor,
          makeDefaultExecutor,
        );

        // 记录 Telemetry（只记录，不分析）
        runtimeTelemetry.record(input.docId, pageNum, report);
      } catch {
        // 单页旁路失败不影响生产（吞掉）
      }
    }
  } catch {
    // 整体旁路失败不影响生产（吞掉）
  }
}
