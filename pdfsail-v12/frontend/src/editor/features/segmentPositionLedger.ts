/**
 * F3B-6.4B-1 — Segment Source Position Ledger
 *
 * 解决的问题（F3B-6.4B-0 阻塞点 B1）：
 *   `Segment.source.startGlyphIndex / endGlyphIndex` 是**原始** line 的 glyph 索引。
 *   一旦某 segment 被 commit（line 长度变化），同 line 上其它 segment 的原始索引就失效了。
 *
 * 语义（关键 —— 不是简单的 `key -> accumulatedShift`）：
 *
 *   currentRange(segment)
 *     = originalRange(segment)
 *     + Σ(delta of segments **whose original range starts before this segment**)
 *
 *   即：ledger 是一个 **original coordinate → current coordinate 的局部映射层**。
 *   这保证：
 *     · 改 A（在 B 前）→ B 的位置随 A 的 delta 移动，A 自己不变；
 *     · 改 B（在 A 后）→ A 的位置**不受** B 影响；
 *     · 再次改 A → B 跟着 A 的新 delta 移动。
 *
 * ⚠️ F3B-6.4B-4.4B —— **时间语义**（本模块最重要的一条）：
 *
 *   `accumulatedDelta` 与 `appliedCommitDeltas` 只统计**当前已应用**的 commits，
 *   而**不是**「曾经发生过的」commits。
 *
 *     commit()   → 累加 + 入 applied 栈
 *     revert()   → 减回 + 移入 reverted 栈（undo）
 *     reapply()  → 再加回 + 回到 applied 栈（redo）
 *
 *   `canonicalized` 是**派生量** = `appliedCommitCount > 0`，
 *   不再是与 history 平行的独立 boolean。
 *
 *   依据（docs/…b4.2 / b4.3）：修复前 ledger 是「commit 历史的纯函数」，
 *   undo 后与当前文档必然发散，导致 E3 静默文本损坏 / E4 导出静默丢弃。
 *
 * 本模块是**纯数据结构**：
 *   · 无 React / 无 DOM / 无 document-model 依赖；
 *   · key 由调用方传入；**约定使用 `sourceSegmentKey(source)`**；
 *   · 不修改 Segment、不改 originalText、不碰 mutation / history / export。
 *
 * ⚠️ F3B-6.4B-4.1 —— identity 分工（**不要合并**）：
 *
 *   · `sourceSegmentKey(source)` = **canonical position identity**（本模块 / canonicalized 过滤）
 *       只由 source 坐标构成，**不得包含 `originalText`**。
 *   · `useSelection.segEditKey(s)` = **legacy replay identity**
 *       （editedSegmentsRef / applySegmentEdits，含 `originalText`），
 *       它服务的是 replay 生命周期，与位置映射无关。
 *
 *   两者各自都有合法用途，硬绑回同一个 key 会破坏其中一个生命周期。
 *
 * 反例（F3B-6.4B-4 实证 U5b）：曾用 `segEditKey` 作 ledger key ——
 * reconciliation 会把 `originalText` 从 "AAAAA" 改写为 "AAA"，
 * 同一段落因此在 commit 前后得到**两个 key** ⇒ ledger 记录失配、
 * 退化成「按 PDF 原始区间重新登记」⇒ 重新编辑时 range 错位 ⇒ 文本损坏。
 */

/** Segment 在**原始** line 上的定位（来自 Segment.source）。 */
export interface SegmentSourceRef {
  blockId: string;
  lineId: string;
  startGlyphIndex: number;
  endGlyphIndex: number;
}

/** glyph 区间（含 end）。 */
export interface GlyphRange {
  readonly start: number;
  readonly end: number;
}

/** ledger 内的一条记录。 */
export interface LedgerRecord {
  readonly key: string;
  /** 同 line 分组键：`${blockId}::${lineId}` */
  readonly lineKey: string;
  /** 原始区间（登记后不可变） */
  readonly original: GlyphRange;
  /** 原始长度 = end - start + 1 */
  readonly originalLength: number;
  /**
   * 该 segment **当前已应用**的 commit 累计位移（相对 originalLength）。
   *
   * F3B-6.4B-4.4B：语义 = 「**当前已应用**的 commits 之和」，**不是**「曾经发生过的」。
   *   · `commit()`   → 累加
   *   · `revert()`   → 减回（undo）
   *   · `reapply()`  → 再加回（redo）
   *
   * `shiftBefore()` 直接对其它 record 的这个值求和 ⇒ 只修正被 undo 的那一条，
   * 下游 segment 的 shift **自动跟随**（record-local，无需遍历 / 重建）。
   */
  accumulatedDelta: number;
  /**
   * 该 record **当前已应用**的 commit delta 栈（LIFO，与 OperationHistory 的 undo 顺序同构）。
   *
   * `appliedCommitCount = appliedCommitDeltas.length` 是 `canonicalized` 的**唯一来源**。
   * ⚠️ 不可用 `accumulatedDelta !== 0` 代替：**等长编辑**的 delta 为 0，
   * 但它确实已 canonical（B-4.3 D2 实测）。
   */
  appliedCommitDeltas: number[];
  /** 被 undo **回退**、尚可 redo 的 delta 栈（LIFO）。本 record 的新 commit 会清空它。 */
  revertedCommitDeltas: number[];
}

/** 同 line 分组键。跨 line 不互相影响即由它保证。 */
export function segmentLineKey(ref: SegmentSourceRef): string {
  return `${ref.blockId}::${ref.lineId}`;
}

/**
 * F3B-6.4B-4.1 —— **canonical position identity**。
 *
 *   `${blockId}::${lineId}::${startGlyphIndex}::${endGlyphIndex}`
 *
 * 这是 ledger 与 canonicalized 过滤应当使用的 key。
 *
 * 为什么必须是这个形状（架构 invariant）：
 *   ledger 记录的是「**原始** Segment 在**当前** EditableDocument 中对应哪个 range」，
 *   因此它的天然身份是 **source 坐标**，而不是显示态文本。
 *   `originalText` 会被 reconciliation 改写（B-3.2），一旦进入 key，
 *   同一段落 commit 前后就会变成两条 identity ⇒ ledger 失配（B-4 实证 U5b）。
 *
 * 稳定性：source 坐标来自 PDF 原文，**跨 reconcile、跨 undo/redo、跨翻页重建都不变**。
 *
 * 纯函数，只处理 source contract，不依赖 `Segment` 类型。
 */
export function sourceSegmentKey(ref: SegmentSourceRef): string {
  return `${segmentLineKey(ref)}::${ref.startGlyphIndex}::${ref.endGlyphIndex}`;
}

/**
 * Segment 原始坐标 → 当前坐标 的映射账本。
 *
 * 典型用法：
 *   ledger.register(key, source);          // 首次见到该 segment 时登记原始区间
 *   const r = ledger.currentRange(key);    // 取**当前**应使用的区间
 *   // …用 r 做 range mutation…
 *   ledger.commit(key, newText.length);    // 提交后记录长度增量
 */
export class SegmentSourcePositionLedger {
  private readonly records = new Map<string, LedgerRecord>();

  /** 是否已登记。 */
  has(key: string): boolean {
    return this.records.has(key);
  }

  /**
   * 登记 segment 的原始区间。**幂等**：已登记则原样返回，
   * 绝不覆盖 `original`（原始坐标必须是稳定基准）。
   */
  register(key: string, ref: SegmentSourceRef): LedgerRecord {
    const existing = this.records.get(key);
    if (existing) return existing;
    if (ref.endGlyphIndex < ref.startGlyphIndex) {
      throw new Error(
        `[SegmentSourcePositionLedger] invalid range for key="${key}": ` +
          `end(${ref.endGlyphIndex}) < start(${ref.startGlyphIndex})`,
      );
    }
    const record: LedgerRecord = {
      key,
      lineKey: segmentLineKey(ref),
      original: { start: ref.startGlyphIndex, end: ref.endGlyphIndex },
      originalLength: ref.endGlyphIndex - ref.startGlyphIndex + 1,
      accumulatedDelta: 0,
      appliedCommitDeltas: [],
      revertedCommitDeltas: [],
    };
    this.records.set(key, record);
    return record;
  }

  /** 原始区间（未登记则抛错）。 */
  originalRange(key: string): GlyphRange {
    return this.require(key).original;
  }

  /** 该 segment 当前长度（= 原始长度 + 自身累计增量）。 */
  currentLength(key: string): number {
    const rec = this.require(key);
    return rec.originalLength + rec.accumulatedDelta;
  }

  /**
   * 该 segment **之前**发生的所有已提交编辑带来的累计位移。
   *
   * 判定：`other.lineKey === self.lineKey && other.original.start < self.original.start`
   * → 只有**同 line 且原始位置在前的** segment 的 delta 才计入。
   * 原始位置在后的 segment 的 delta **不影响**本 segment。
   */
  shiftBefore(key: string): number {
    const self = this.require(key);
    let shift = 0;
    for (const rec of this.records.values()) {
      if (rec.key === key) continue;
      if (rec.lineKey !== self.lineKey) continue;
      if (rec.original.start < self.original.start) shift += rec.accumulatedDelta;
    }
    return shift;
  }

  /**
   * 该 segment 当前应使用的区间。
   *
   *   start = original.start + shiftBefore
   *   end   = original.end   + shiftBefore + 自身 accumulatedDelta
   *
   * （end 额外加自身 delta，因为自身长度变化只影响右端；start 不受自身长度影响。）
   */
  currentRange(key: string): GlyphRange {
    const self = this.require(key);
    const shift = this.shiftBefore(key);
    return {
      start: self.original.start + shift,
      end: self.original.end + shift + self.accumulatedDelta,
    };
  }

  /**
   * 记录一次提交：把该 segment 的当前长度更新为 newLength，并返回本次 delta。
   *
   *   delta = newLength - currentLength(key)   （相对**当前**长度，非原始长度）
   *   appliedCommitDeltas.push(delta)
   *   accumulatedDelta += delta
   *
   * 这样重复编辑同一 segment 时增量可正确累加（A → B → 再编辑 A）。
   *
   * F3B-6.4B-4.4B：delta 同时进入 **applied 栈**（`canonicalized` 的派生来源）；
   * 且本 record 的 **reverted 栈被清空** —— 镜像 History 的 `push → redoStack = []`
   * 语义（对本 record 而言）：新 commit 使该 record 自身的 redo 分支失效。
   */
  commit(key: string, newLength: number): number {
    const rec = this.require(key);
    if (newLength < 0) {
      throw new Error(
        `[SegmentSourcePositionLedger] invalid newLength for key="${key}": ${newLength}`,
      );
    }
    const before = this.currentLength(key);
    const delta = newLength - before;
    rec.accumulatedDelta += delta;
    rec.appliedCommitDeltas.push(delta);
    rec.revertedCommitDeltas.length = 0;
    return delta;
  }

  /**
   * F3B-6.4B-4.4B（undo 侧）—— 把该 record **最后一次已应用的** commit 回退。
   *
   *   delta = appliedCommitDeltas.pop()
   *   accumulatedDelta -= delta
   *   revertedCommitDeltas.push(delta)
   *
   * **record-local**：不遍历、不清空、不重建 ledger。
   * 依赖「`shiftBefore()` 按各 record 当前 `accumulatedDelta` 求和」这一性质，
   * 下游 segment 的 shift 自动跟随（B-4.2 已用独立 ground truth 验证）。
   *
   * @returns 被回退的 delta；若 key 未登记或没有可回退的 commit，返回 `null`
   *          （**不抛错** —— orchestration 不应因意外状态而崩溃）。
   */
  revert(key: string): number | null {
    const rec = this.records.get(key);
    if (!rec) return null;
    const delta = rec.appliedCommitDeltas.pop();
    if (delta === undefined) return null;
    rec.accumulatedDelta -= delta;
    rec.revertedCommitDeltas.push(delta);
    return delta;
  }

  /**
   * F3B-6.4B-4.4B（redo 侧）—— 把该 record 最近一次被 `revert()` 回退的 commit 重新应用。
   *
   *   delta = revertedCommitDeltas.pop()
   *   accumulatedDelta += delta
   *   appliedCommitDeltas.push(delta)
   *
   * @returns 被重新应用的 delta；若 key 未登记或没有可重放的 commit，返回 `null`。
   */
  reapply(key: string): number | null {
    const rec = this.records.get(key);
    if (!rec) return null;
    const delta = rec.revertedCommitDeltas.pop();
    if (delta === undefined) return null;
    rec.accumulatedDelta += delta;
    rec.appliedCommitDeltas.push(delta);
    return delta;
  }

  /** 该 record **当前已应用**的 commit 数量（`canonicalized` 的唯一来源）。 */
  appliedCommitCount(key: string): number {
    const rec = this.records.get(key);
    return rec ? rec.appliedCommitDeltas.length : 0;
  }

  /**
   * 该 segment 是否**当前**处于 canonical 状态。
   *
   * F3B-6.4B-4.4B：由独立 boolean 改为**派生量** `appliedCommitCount(key) > 0`。
   *
   *   · commit  → true
   *   · revert  → 归零 ⇒ false（E4 自然消失：undo 后 pending 可重新进入 export）
   *   · reapply → true
   *
   * ⚠️ 不得改写成 `accumulatedDelta !== 0` —— 等长编辑的 delta 为 0 但确实已 canonical
   * （B-4.3 D2 实测）。
   *
   * 窄能力：只回答「当前是否 canonical」，不暴露 ledger 内部结构、不承担任何文本存储。
   */
  isCanonicalized(key: string): boolean {
    return this.appliedCommitCount(key) > 0;
  }

  /** 清空（新文档加载时调用）。 */
  reset(): void {
    this.records.clear();
  }

  /** 只读快照（调试 / 测试用）。 */
  snapshot(): LedgerRecord[] {
    return [...this.records.values()].map((r) => ({ ...r, original: { ...r.original } }));
  }

  private require(key: string): LedgerRecord {
    const rec = this.records.get(key);
    if (!rec) {
      throw new Error(
        `[SegmentSourcePositionLedger] segment not registered: key="${key}". ` +
          `Call register(key, source) before currentRange/commit.`,
      );
    }
    return rec;
  }
}

/**
 * 便捷构造：从 Segment.source 登记。
 *
 * 仅做类型收窄与缺失校验；**不修改** Segment。
 * key 仍由调用方传入（约定 = `sourceSegmentKey(source)`，见 F3B-6.4B-4.1）。
 */
export function registerSegmentSource(
  ledger: SegmentSourcePositionLedger,
  key: string,
  source: SegmentSourceRef | undefined | null,
): boolean {
  if (!source) return false;
  ledger.register(key, source);
  return true;
}
