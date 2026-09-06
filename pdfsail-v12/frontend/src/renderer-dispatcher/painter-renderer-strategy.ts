/**
 * painter-renderer-strategy.ts — PainterRendererStrategy（Sprint-73 Task-001）
 *
 * 目的：把 RenderCommand 转换为 RenderObject，走 Painter，输出 PaintOutput。
 *
 * PM Architecture Decision（Sprint-73）：
 *   PainterRendererStrategy
 *        ↓
 *   RenderObject
 *        ↓
 *   Painter
 *        ↓
 *   PaintOutput
 *
 *   关键：PainterRendererStrategy 负责把 **RenderCommand** 转换成 **RenderObject**。
 *   这是 Painter Mainline 第一次真正开始。
 *
 * 转换规则（RenderCommand → RenderObject）：
 *   - DrawGlyphCommand → GlyphObject
 *     - bounds 来自 cmd.x/y/width/height（Pixel 与输入一致）
 *     - coverage 从 glyph bbox 构造（RenderCommand 无 Semantic coverage，
 *       此处用 glyph bbox 作为 mask/patch/coverage 的占位，保证 Painter 可 paint）
 *     - metrics 从 DrawGlyphCommand 的 bbox 高度估算（fontSize ≈ height）
 *
 * PM Rule-014：Migration builds compatibility, not replacement.
 *   - 本任务 **新增** PainterRendererStrategy（New Path），不删 Legacy（Old Path）。
 *   - Legacy 仍默认（Feature Flag 可回滚）。
 *
 * 不依赖 DOM / Canvas / Semantic / Layout。纯函数（ADR-005）。
 */

import type { RendererStrategy, RendererStrategyInput, RendererStrategyResult } from "./renderer-strategy";
import { paintObject } from "../render-painter/render-painter";
import type { PaintOutput } from "../render-painter/render-painter";
import type { GlyphObject, RenderObject } from "../render-object/render-object";
import type { RenderCommand, DrawGlyphCommand } from "../document-model/render-command";
import type { RenderCoverage } from "../render-context/render-context";

/** 从 DrawGlyphCommand 构造占位 coverage（RenderCommand 无 Semantic coverage） */
function glyphCommandToCoverage(cmd: DrawGlyphCommand): RenderCoverage {
  const b = { x: cmd.x, y: cmd.y, width: cmd.width, height: cmd.height };
  return {
    visualCoverageId: `${cmd.blockId}-coverage`,
    maskBounds: b,
    patchBounds: b,
    coverageBounds: b,
    confidence: 1,
  };
}

/** 从 transform matrix 提取 CSS 旋转角度（度，顺时针为正） */
function rotationFromTransform(t?: [number, number, number, number, number, number]): number | undefined {
  if (!t || t.length < 2) return undefined;
  const rad = Math.atan2(t[1], t[0]);
  return (rad * 180) / Math.PI;
}

/** DrawGlyphCommand → GlyphObject */
function toGlyphObject(cmd: DrawGlyphCommand): GlyphObject {
  const bounds = { x: cmd.x, y: cmd.y, width: cmd.width, height: cmd.height };
  const fontSize = cmd.height > 0 ? cmd.height : 12;
  const rotation = rotationFromTransform(cmd.transform);
  return {
    kind: "glyph",
    id: `${cmd.blockId}-${cmd.x}-${cmd.y}-${cmd.char}`,
    char: cmd.char,
    x: cmd.x,
    y: cmd.y,
    width: cmd.width,
    height: cmd.height,
    bounds,
    baseline: cmd.baseline,
    blockId: cmd.blockId,
    lineId: cmd.lineId,
    metrics: {
      fontSize,
      lineHeight: fontSize * 1.2,
      baseline: fontSize * 0.8,
      ascent: fontSize * 0.8,
      descent: fontSize * 0.2,
      advanceWidth: cmd.width,
      letterSpacing: 0,
    },
    style: {},
    coverage: glyphCommandToCoverage(cmd),
    rotation,
  };
}

/**
 * RenderCommand[] → RenderObject[]（Sprint-76：支持 glyph + mask + rotation）。
 * - drawGlyph → GlyphObject（含 rotation，从 transform 提取）
 * - drawLine purpose="mask" → MaskObject（bounds 来自 cmd）
 */
export function commandsToRenderObjects(commands: readonly RenderCommand[]): RenderObject[] {
  const objects: RenderObject[] = [];
  for (const cmd of commands) {
    if (cmd.type === "drawGlyph") {
      objects.push(toGlyphObject(cmd as DrawGlyphCommand));
    } else if (cmd.type === "drawLine" && (cmd as any).purpose === "mask") {
      const c = cmd as any;
      objects.push({
        kind: "mask",
        id: `${c.blockId}-mask`,
        x: c.x,
        y: c.y,
        width: c.width,
        height: c.height,
        bounds: { x: c.x, y: c.y, width: c.width, height: c.height },
        blockId: c.blockId,
        coverage: {
          visualCoverageId: `${c.blockId}-coverage`,
          maskBounds: { x: c.x, y: c.y, width: c.width, height: c.height },
          patchBounds: { x: c.x, y: c.y, width: c.width, height: c.height },
          coverageBounds: { x: c.x, y: c.y, width: c.width, height: c.height },
          confidence: 1,
        },
      });
    }
  }
  return objects;
}

/**
 * PainterRendererStrategy — 把 RenderCommand → RenderObject → Painter → PaintOutput。
 *
 * render() 返回带 PaintOutput 的 RendererStrategyResult。
 * 注意：strategy 字段为 "painter"，renderer 为 "painter"（区别于 legacy 的 "glyph-renderer"）。
 */
export class PainterRendererStrategy implements RendererStrategy {
  readonly kind = "painter";

  render(input: RendererStrategyInput): RendererStrategyResult {
    const objects = commandsToRenderObjects(input.commands);
    const outputs = objects.map(paintObject);
    return {
      strategy: "painter",
      renderer: "painter",
      props: {
        commands: [...input.commands],
        styles: [...input.styles],
      },
      paintOutputs: outputs,
      renderObjects: objects,
    };
  }
}

export { paintObject };
