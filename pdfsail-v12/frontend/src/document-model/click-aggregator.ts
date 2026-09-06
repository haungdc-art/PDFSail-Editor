/**
 * ClickAggregator — 点击聚合（Task-009A）
 *
 * 浏览器没有原生 TripleClick 事件（只有 click / dblclick）。
 * 本聚合器把连续点击识别为 single / double / triple，供 Wiring 层使用。
 *
 * 纯计算，无 DOM。可单测。
 *
 * 语义：连续点击在时间窗口内且位置相近 → 聚合为多击。
 * - 第 1 次点击：single（延迟确认，可能升级为 double/triple）
 * - 第 2 次点击：double
 * - 第 3 次点击：triple（并消费，重置）
 */
export type ClickLevel = 1 | 2 | 3;

export interface ClickRecord {
  x: number;
  y: number;
  time: number;
}

export interface ClickAggregatorOptions {
  /** 多击时间窗口（ms） */
  multiClickInterval?: number;
  /** 位置容差（px），多击需在相近位置 */
  positionTolerance?: number;
}

export class ClickAggregator {
  private clicks: ClickRecord[] = [];

  constructor(private opts: ClickAggregatorOptions = {}) {}

  /** 每次点击调用。返回当前聚合等级（1=单击，2=双击，3=三击），并维护内部状态。 */
  recordClick(x: number, y: number, now: number): ClickLevel {
    const interval = this.opts.multiClickInterval ?? 500;
    const tolerance = this.opts.positionTolerance ?? 5;

    // 若上次点击已超时，或位置差异过大 → 视为新的一次点击序列
    const last = this.clicks[this.clicks.length - 1];
    if (last) {
      const timeDiff = now - last.time;
      const posDiff = Math.hypot(x - last.x, y - last.y);
      if (timeDiff > interval || posDiff > tolerance) {
        this.clicks = []; // 新序列
      }
    }

    this.clicks.push({ x, y, time: now });

    // 保持最近 3 次
    if (this.clicks.length > 3) this.clicks.shift();

    // 聚合等级 = 当前序列长度（1/2/3）
    return this.clicks.length as ClickLevel;
  }

  /** 窗口超时后，确认当前点击序列的类型并重置（供 Wiring 派发 delayed single/double） */
  settle(now: number): ClickLevel | null {
    if (this.clicks.length === 0) return null;
    const interval = this.opts.multiClickInterval ?? 500;
    const last = this.clicks[this.clicks.length - 1];
    if (now - last.time >= interval) {
      const level = this.clicks.length as ClickLevel;
      this.clicks = [];
      return level;
    }
    return null; // 还在窗口内，等待更多点击
  }

  /** 强制清空（供 Wiring 在明确单一时调用） */
  reset(): void {
    this.clicks = [];
  }
}
