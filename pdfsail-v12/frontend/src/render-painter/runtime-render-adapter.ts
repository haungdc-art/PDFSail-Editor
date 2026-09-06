/**
 * runtime-render-adapter.ts — RuntimeRenderAdapter（Sprint-123 · Task-2）
 *
 * ADR-045 · Sprint-123 · PM 最后一个冻结边界。
 *
 * ## 职责
 * `SceneRuntime → RenderObject[]` 的**纯投影（Projection）**，不是业务逻辑。
 *
 * ## 为什么必须有 Adapter
 * - **Runtime 世界**（SceneNode / Visibility / Transform / HitTest / Dirty）≠ **渲染世界**（GlyphObject / MaskObject / PatchObject）
 * - 若 Painter 直接 `switch(node.kind)`，就会知道 Runtime，未来 HitTest/Animation/GPU/Selection 都会进 Painter。
 * - Adapter 隔离二者，Painter 仍只知道 RenderObject（保持 Input Freeze）。
 *
 * ## 投影规则（PM 指定）
 * - `visible=false` → 不生成 RenderObject
 * - glyph node → GlyphObject
 * - image node → PatchObject
 * - mask node → MaskObject
 *
 * ## 约束
 * - 纯函数（ADR-005）：输入 Runtime 视图，输出 RenderObject[]。
 * - 不修改 Runtime / Painter / Builder。
 * - 不依赖 EditableDocument。
 * - 不实现 SceneNode / SceneGraph / SceneRuntimeBuilder（那些属 Sprint-124 Runtime 层）。
 *
 * 说明：本文件定义 Adapter 的**输入投影契约**（RuntimeRenderNode），
 * 它是未来 SceneRuntime 的轻量视图，不含 SceneGraph/Node 实现。
 */

import type { GlyphObject, MaskObject, PatchObject, RenderObject } from "../render-object/render-object";

/** Runtime 渲染节点的投影输入（Adapter 的输入契约，轻量，非 SceneGraph 实现） */
export interface RuntimeRenderNode {
  /** 节点类型（渲染意图） */
  readonly kind: "glyph" | "image" | "mask";
  /** 是否可见（Runtime 运行态） */
  readonly visible: boolean;
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** glyph 专属 */
  readonly char?: string;
  readonly blockId?: string;
  readonly lineId?: string;
  readonly fontSize?: number;
  readonly lineHeight?: number;
  readonly baseline?: number;
  readonly ascent?: number;
  readonly descent?: number;
  readonly advanceWidth?: number;
  readonly letterSpacing?: number;
  readonly style?: Readonly<Record<string, unknown>>;
  readonly rotation?: number;
  /** image 专属（patch 图像引用，本期占位） */
  readonly patchRef?: string;
}

/** SceneRuntime 视图（Adapter 输入：页级运行时节点集合） */
export interface SceneRuntimeView {
  readonly page: number;
  readonly nodes: readonly RuntimeRenderNode[];
}

/** glyph 节点投影为 GlyphObject */
function projectGlyph(node: RuntimeRenderNode): GlyphObject {
  return {
    kind: "glyph",
    id: node.id,
    char: node.char ?? "",
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    bounds: { x: node.x, y: node.y, width: node.width, height: node.height },
    baseline: node.baseline,
    blockId: node.blockId ?? "",
    lineId: node.lineId ?? "",
    metrics: {
      fontSize: node.fontSize ?? 12,
      lineHeight: node.lineHeight ?? 1.2,
      baseline: node.baseline ?? 0,
      ascent: node.ascent ?? 0,
      descent: node.descent ?? 0,
      advanceWidth: node.advanceWidth ?? 0,
      letterSpacing: node.letterSpacing ?? 0,
    },
    style: node.style ?? {},
    coverage: {
      visualCoverageId: `${node.id}-coverage`,
      maskBounds: { x: node.x, y: node.y, width: node.width, height: node.height },
      patchBounds: { x: node.x, y: node.y, width: node.width, height: node.height },
      coverageBounds: { x: node.x, y: node.y, width: node.width, height: node.height },
      confidence: 1,
    },
    rotation: node.rotation,
  };
}

/** image 节点投影为 PatchObject */
function projectPatch(node: RuntimeRenderNode): PatchObject {
  const bounds = { x: node.x, y: node.y, width: node.width, height: node.height };
  return {
    kind: "patch",
    id: node.id,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    bounds,
    blockId: node.blockId ?? "",
    coverage: {
      visualCoverageId: `${node.id}-coverage`,
      maskBounds: bounds,
      patchBounds: bounds,
      coverageBounds: bounds,
      confidence: 1,
    },
    patchRef: node.patchRef,
  };
}

/** mask 节点投影为 MaskObject */
function projectMask(node: RuntimeRenderNode): MaskObject {
  const bounds = { x: node.x, y: node.y, width: node.width, height: node.height };
  return {
    kind: "mask",
    id: node.id,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    bounds,
    blockId: node.blockId ?? "",
    coverage: {
      visualCoverageId: `${node.id}-coverage`,
      maskBounds: bounds,
      patchBounds: bounds,
      coverageBounds: bounds,
      confidence: 1,
    },
  };
}

/**
 * RuntimeRenderAdapter：SceneRuntime → RenderObject[]（纯投影）。
 *
 * 投影规则：
 *   - visible=false → 不生成 RenderObject
 *   - glyph node → GlyphObject
 *   - image node → PatchObject
 *   - mask node → MaskObject
 *
 * @param view SceneRuntime 视图（Adapter 输入）
 * @returns RenderObject[]（Painter 唯一输入）
 */
export function projectSceneRuntimeToRenderObjects(view: SceneRuntimeView): RenderObject[] {
  const objects: RenderObject[] = [];
  for (const node of view.nodes) {
    if (!node.visible) continue; // 不可见 → 不生成
    switch (node.kind) {
      case "glyph":
        objects.push(projectGlyph(node));
        break;
      case "image":
        objects.push(projectPatch(node));
        break;
      case "mask":
        objects.push(projectMask(node));
        break;
    }
  }
  return objects;
}
