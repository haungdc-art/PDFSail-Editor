/**
 * RealGeometryConsumer — Sprint36 · R1（Bridge）
 *
 * 把 GeometryBatch 翻译为现有 Geometry Engine 的调用方式。
 *
 *   GeometryBatch
 *        ↓
 *   RealGeometryConsumer（Bridge）
 *        ↓
 *   GeometryExecutor（接口，接收 Runtime Request）
 *        ↓
 *   Geometry Engine
 *
 * 【Bridge 纪律（METH-005）】
 *   Bridge translates APIs, Resolver resolves identities, Engine computes algorithms.
 *
 *   Must：
 *     - 实现 GeometryConsumer.consume(batch)
 *     - 把 GeometryBatch 翻译为 GeometryExecutor.execute(request) 的调用
 *
 *   Must NOT：
 *     - 不解析 GeometryTarget（Region→Blocks 属于 GeometryTargetResolver，deferred）
 *     - 不包含业务规则（if(signature) / if(decision.type===...)）
 *     - 不实现几何算法（PCA / 投影剖面 / rotation）
 *     - 不做路由（根据 kind 走不同 Engine）
 *     - 不做缓存 / 配置 / fallback
 *     - 不修改 geometry-pipeline.ts（冻结核心）
 *
 * 【R1 修正】GeometryExecutor 定义成「能力」而非「函数包装」：
 *   - execute(request) 接收 Runtime Request 对象（含 blocks + canvas），
 *     而非固定 execute(blocks, canvas)。
 *   - 未来增加 rotationHint 等，Bridge 不改，Executor 自己演进。
 *
 * 【Vertical Slice Temporary Dependency】
 *   - resolveBlocks 仅为 Temporary Dependency，未来上移至 Document Pipeline。
 *
 * 【Runtime Discipline】Never optimize before parity. 只做 Bridge，不做优化。
 */

import type { GeometryBatch, GeometryConsumer } from "./document-pipeline";
import type { GeometryTarget } from "./geometry-decision-adapter";
import type { OcrTextBlock } from "../ocr/ocr-storage";
import { buildGeometryForBlocks } from "../ocr/geometry-pipeline";

/**
 * Geometry Execution Request — Executor 的运行时输入。
 *
 * 表达"能力"而非"今天的函数签名"：
 *   - 当前含 blocks + canvas。
 *   - 未来可扩展 rotationHint / page / region 等，Bridge 不改，Executor 自己演进。
 *
 * 属于 Runtime 内部实现，非新架构抽象。
 *
 * 【Runtime Guard】
 *   GeometryExecutionRequest is immutable.
 *   Executors may derive outputs (clone / copy / create GeometryResult),
 *   but must never mutate the request or its contained runtime objects.
 *
 *   禁止：request.blocks.push / splice / 修改 geometry / bbox / transform。
 *   否则 Dual Run 中 Old/New 共享可变对象，Parity 比较失效。
 */
export interface GeometryExecutionRequest {
  /** 待分析的 OCR blocks */
  blocks: OcrTextBlock[];
  /** 页面 canvas（几何分析所需图像） */
  canvas: HTMLCanvasElement;
}

/**
 * Geometry Executor — Geometry Engine 的类型化能力入口（Runtime 内部，非新 Port）。
 *
 * Bridge 依赖本接口（能力），不直接绑定 buildGeometryForBlocks。
 * Geometry Engine 重构时只换 Executor 实现，Bridge 不动。
 */
export interface GeometryExecutor {
  /** 执行一次几何分析 */
  execute(request: GeometryExecutionRequest): void;
}

/**
 * Geometry Metric — 单个几何指标的比较结果。
 *
 * 用 PASS / delta 而非 equal，便于未来扩展（如 rotation delta 0.3°）。
 *   - pass：是否一致
 *   - delta：差异值（可选，便于诊断）
 *   - old / new：双方原始值（可选）
 *   - reason：判定原因（如 "within tolerance" / "exceed tolerance"），便于 Debug / Report
 *
 * 【Metrics never modify runtime】Metric 只能 Measure，不能 Repair。
 *   禁止在计算 metric 时 normalize / round / fix / tolerance 修改 Geometry。
 */
export interface GeometryMetric {
  /** 是否一致 */
  pass: boolean;
  /** 差异值（可选） */
  delta?: number;
  /** 旧值（可选） */
  old?: number;
  /** 新值（可选） */
  new?: number;
  /** 判定原因（可选，便于 Debug / Report） */
  reason?: string;
}

/**
 * Geometry Comparison — 新旧 Geometry 输出的一致性指标（R3 前先冻结接口）。
 */
export interface GeometryComparison {
  /** rotation 一致性 */
  rotation?: GeometryMetric;
  /** transform 一致性 */
  transform?: GeometryMetric;
  /** polygon 一致性 */
  polygon?: GeometryMetric;
}

/**
 * RealGeometryConsumer 的依赖（Port 注入）。
 *
 * resolveBlocks 为 Vertical Slice Temporary Dependency，未来上移至 Document Pipeline。
 */
export interface RealGeometryConsumerDeps {
  /** 把 GeometryTarget 解析为 OcrTextBlock[]（当前 1:1 Block，未来 1:N Region） */
  resolveBlocks: (target: GeometryTarget) => OcrTextBlock[];
  /** 获得页面 canvas（Document Pipeline 生命周期可重新渲染） */
  renderCanvas: (pageNum: number) => Promise<HTMLCanvasElement>;
  /** Geometry Executor（默认包装 buildGeometryForBlocks） */
  executor?: GeometryExecutor;
}

/**
 * 创建 RealGeometryConsumer（Bridge）。
 *
 * @param deps 依赖（resolveBlocks + renderCanvas + 可选 executor）
 */
export function createRealGeometryConsumer(deps: RealGeometryConsumerDeps): GeometryConsumer {
  // 默认 Executor：包装现有 buildGeometryForBlocks
  const executor: GeometryExecutor =
    deps.executor ??
    {
      execute(request: GeometryExecutionRequest): void {
        buildGeometryForBlocks(request.blocks, request.canvas);
      },
    };

  return {
    consume(batch: GeometryBatch): void {
      for (const request of batch.requests) {
        const blocks = deps.resolveBlocks(request.target);
        if (blocks.length === 0) continue;
        const pageNum = blocks[0].page ?? 1;
        void deps.renderCanvas(pageNum).then((canvas) => {
          if (canvas) {
            executor.execute({ blocks, canvas });
          }
        });
      }
    },
  };
}
