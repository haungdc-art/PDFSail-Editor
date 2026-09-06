/**
 * GlyphHitMap — Sprint 6 Task 1 + Task 2
 *
 * Glyph 级命中检测和选择引擎。
 *
 * Task 1: GlyphHitMap
 *   每个 DrawGlyphCommand 生成命中记录：
 *     { glyphId, blockId, lineId, page, bbox }
 *   支持 screen coordinate → glyph 查找
 *
 * Task 2: Glyph Selection
 *   支持 click（单击选中）和 drag selection（拖拽框选）
 *   返回 selected glyphs[]
 *
 * 数据流：
 *   RenderCommand[] → GlyphHitMap → hitTest(x, y) → DrawGlyphCommand
 *                                          → selectRect(x1,y1,x2,y2) → DrawGlyphCommand[]
 *
 * 坐标系：Document Space（CSS 显示坐标，与 GlyphRenderer 一致）
 */

import type { BBox } from "./types";
import type { RenderCommand, DrawGlyphCommand } from "./render-command";
import { isDrawGlyph } from "./render-command";

/** Glyph 命中记录 */
export interface GlyphHitRecord {
  /** 唯一 ID（blockId + lineId + index） */
  glyphId: string;
  /** 所属 block ID */
  blockId: string;
  /** 所属行 ID */
  lineId: string;
  /** 页码 */
  page: number;
  /** glyph bbox（CSS 显示坐标） */
  bbox: BBox;
  /** 原始 DrawGlyphCommand 引用 */
  command: DrawGlyphCommand;
}

/** 选择结果 */
export interface GlyphSelection {
  /** 选中的 glyph 命中记录 */
  hits: GlyphHitRecord[];
  /** 选中的 glyph ID 集合 */
  glyphIds: Set<string>;
  /** 选中的 block ID 集合 */
  blockIds: Set<string>;
}

/**
 * GlyphHitMap — 空间索引结构
 *
 * 从 RenderCommand[] 构建，支持 O(n) 命中检测。
 * 对于大文档可优化为 R-tree / quadtree，Sprint 6 用线性扫描（够用）。
 */
export class GlyphHitMap {
  private records: GlyphHitRecord[] = [];
  private idToRecord = new Map<string, GlyphHitRecord>();

  /**
   * 从 RenderCommand[] 构建命中图
   *
   * @param commands 渲染命令列表
   * @param page 页码（用于命中记录）
   */
  buildFromCommands(commands: RenderCommand[], page: number): void {
    this.records = [];
    this.idToRecord.clear();

    let glyphIndex = 0;
    for (const cmd of commands) {
      if (!isDrawGlyph(cmd)) continue;

      const glyphId = `${cmd.blockId}__${cmd.lineId}__${glyphIndex}`;
      const record: GlyphHitRecord = {
        glyphId,
        blockId: cmd.blockId,
        lineId: cmd.lineId,
        page,
        bbox: {
          x: cmd.x,
          y: cmd.y,
          width: cmd.width,
          height: cmd.height,
        },
        command: cmd,
      };

      this.records.push(record);
      this.idToRecord.set(glyphId, record);
      glyphIndex++;
    }
  }

  /**
   * Task 1: 点命中测试 — screen coordinate → glyph
   *
   * @param x 屏幕 X（Document Space）
   * @param y 屏幕 Y（Document Space）
   * @returns 命中的 glyph 记录，或 null
   */
  hitTest(x: number, y: number): GlyphHitRecord | null {
    // 从后往前遍历（后渲染的在上面，优先命中）
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (
        x >= r.bbox.x &&
        x <= r.bbox.x + r.bbox.width &&
        y >= r.bbox.y &&
        y <= r.bbox.y + r.bbox.height
      ) {
        return r;
      }
    }
    return null;
  }

  /**
   * Task 2: 矩形框选 — 返回与选择矩形相交的所有 glyph
   *
   * @param x1 矩形左上 X
   * @param y1 矩形左上 Y
   * @param x2 矩形右下 X
   * @param y2 矩形右下 Y
   * @returns 选择结果
   */
  selectRect(
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): GlyphSelection {
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);

    const hits: GlyphHitRecord[] = [];
    const glyphIds = new Set<string>();
    const blockIds = new Set<string>();

    for (const r of this.records) {
      // 矩形相交测试
      const intersects =
        r.bbox.x < maxX &&
        r.bbox.x + r.bbox.width > minX &&
        r.bbox.y < maxY &&
        r.bbox.y + r.bbox.height > minY;

      if (intersects) {
        hits.push(r);
        glyphIds.add(r.glyphId);
        blockIds.add(r.blockId);
      }
    }

    return { hits, glyphIds, blockIds };
  }

  /**
   * 单击选择 — 选中单个 glyph
   *
   * @param x 屏幕 X
   * @param y 屏幕 Y
   * @returns 选择结果（可能为空）
   */
  selectPoint(x: number, y: number): GlyphSelection {
    const hit = this.hitTest(x, y);
    if (!hit) {
      return { hits: [], glyphIds: new Set(), blockIds: new Set() };
    }
    return {
      hits: [hit],
      glyphIds: new Set([hit.glyphId]),
      blockIds: new Set([hit.blockId]),
    };
  }

  /**
   * 选中指定 block 的所有 glyph
   */
  selectBlock(blockId: string): GlyphSelection {
    const hits = this.records.filter((r) => r.blockId === blockId);
    return {
      hits,
      glyphIds: new Set(hits.map((h) => h.glyphId)),
      blockIds: new Set([blockId]),
    };
  }

  /**
   * 选中指定行的所有 glyph
   */
  selectLine(blockId: string, lineId: string): GlyphSelection {
    const hits = this.records.filter(
      (r) => r.blockId === blockId && r.lineId === lineId
    );
    return {
      hits,
      glyphIds: new Set(hits.map((h) => h.glyphId)),
      blockIds: new Set([blockId]),
    };
  }

  /**
   * 按 glyphId 获取记录
   */
  getRecord(glyphId: string): GlyphHitRecord | undefined {
    return this.idToRecord.get(glyphId);
  }

  /** 所有记录（只读） */
  getRecords(): readonly GlyphHitRecord[] {
    return this.records;
  }

  /** 记录数量 */
  get size(): number {
    return this.records.length;
  }
}

/**
 * 创建 GlyphHitMap 实例的便捷函数
 */
export function createGlyphHitMap(
  commands: RenderCommand[],
  page: number
): GlyphHitMap {
  const map = new GlyphHitMap();
  map.buildFromCommands(commands, page);
  return map;
}
