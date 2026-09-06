/**
 * editable-document-mapper.ts — EditableDocument → DOM 单向 Mapper（Sprint-120 · Phase 1）
 *
 * ADR-045 · Document Object Model (DOM) for AI Documents。
 *
 * 职责只有一句：`EditableDocument → Page[]`。
 * - 它是**唯一**知道 EditableDocument 的地方。
 * - 它不能知道 Painter / Scene / Builder / Export。
 * - 它是**单向**的（EditableDocument → Page），**绝不引入反向转换**（Page → EditableDocument）。
 *   以后 Page 成为唯一 Source 时，删除 Mapper，不做双向同步。
 *
 * 映射规则（PM 批准）：
 *   - editable=true  → ContentLayer
 *   - editable=false → BaseLayer
 *   - Header/Footer 不是类型，是位置（anchor）；归属由 editable 决定，不因在页脚就归为装饰
 *   - footer 可编辑文本 → ContentLayer（editable=true, anchor=BOTTOM），保留可编辑性
 *   - 每页生成一个 PdfFallback（BaseLayer）作为页面光栅底图，满足 >=1 BaseLayer 结构约束
 *
 * 纯函数（ADR-005），Node 可测。
 */

import type { EditableDocument } from "../types";
import { DomPage, DEFAULT_RUNTIME } from "./page";
import { DomObject } from "./object";
import { mapBlockToDomObject } from "./block-mapper";

/** 生成页面光栅底图（BaseLayer PdfFallback，过渡层版本，无 runtimeRef） */
function makePdfFallback(pageIndex: number, width: number, height: number): DomObject {
  return {
    id: `pdf-fallback-page-${pageIndex}`,
    type: "PdfFallback",
    editable: false,
    anchor: "NONE", // 铺满全页，无特定位置锚点
    bbox: { x: 0, y: 0, width, height },
  };
}

/**
 * 单向映射：EditableDocument → DomPage[]（Phase 1 过渡层，证明 DOM 可共存）。
 * 复用 block-mapper 的 Block→Object 映射（单一事实来源），
 * 但保留过渡层自己的 makePdfFallback（无 runtimeRef，因为 mapper 是过渡层，不声明运行期资源）。
 * @param doc EditableDocument（唯一已知的旧模型）
 * @returns DOM Page 数组
 */
export function mapEditableDocumentToDom(doc: EditableDocument): DomPage[] {
  return doc.pages.map((ep) => {
    // 1. 解析每个 block（复用 block-mapper，单一事实来源）
    const contentObjects: DomObject[] = [];
    const baseObjects: DomObject[] = [];

    for (const block of ep.blocks) {
      const obj = mapBlockToDomObject(block, ep);
      // editable=true → ContentLayer；false → BaseLayer
      if (obj.editable) {
        contentObjects.push(obj);
      } else {
        baseObjects.push(obj);
      }
    }

    // 2. 每页强制一个 PdfFallback（BaseLayer），保证结构约束 >=1 BaseLayer
    const baseLayer = [makePdfFallback(ep.index, ep.width, ep.height), ...baseObjects];

    return {
      metadata: { index: ep.index, width: ep.width, height: ep.height },
      layers: {
        base: baseLayer,
        content: contentObjects,
        interaction: [],
        overlay: [],
      },
      runtime: { ...DEFAULT_RUNTIME },
    };
  });
}
