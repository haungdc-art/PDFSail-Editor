/**
 * editor/binding/table-cell-edit-ledger.ts — F3B-6.28 · cell 编辑**台账**（纯契约）
 *
 * ── 立项（2026-10-24 用户缺陷「第一次格编辑正确，再次进入编辑态错误」）──────
 *   cell 规划器门 2（`resolveSegmentParagraphRange` run glyph 包含关系）在行的
 *   **任意一次** cell 事务提交后结构性死亡：Core `deriveRun` strip 掉行内 run 的
 *   glyph 索引（helpers §25）⇒ 该行此后**任何格**的 planCellUnit 都落
 *   `paragraph-unresolved` ⇒ 回落整行编辑面 ⇒ 用户看到两列被拼进一个面、提交后
 *   左格内容被吞（显示层单带覆盖是次生症状）。
 *   S2-v3 稳定锚只覆盖**被建立的那个 cell**且生命周期 = 单次编辑会话（退出即清）
 *   ⇒ 跨会话的第二格编辑无任何映射来源。
 *
 * ── 台账语义（最小充分信息）────────────────────────────────────────────
 *   每条记录 = 「该 cell 最近一次 cell 事务提交后的内容」：
 *     { lineId, cellIndex, paragraphId, newText }
 *   原始（import 期）legacy 几何**不入账**——cell 的 legacy glyph 区间随时可由
 *   门 1（`detectTableCells`，legacy 轴在 Core ownership 下不可变）现算；台账只补
 *   门 2 死亡后丢失的「当前 Core 文本 ↔ legacy 行文本」映射差量。
 *
 * ── 消费方式（规划器 `planCellUnit` 的 `editLedger` 输入）────────────────
 *   假设 1（台账假设）：当前 Core 段落文本 === 原始行文本按台账逐格替换的重建结果
 *     （**整行内容证明**——比逐格切片更强：同时校验未记录格未被外部路径改动）。
 *     成立 ⇒ 任意格的当前区间 = legacy 区间 + 前序格的长度差累计。
 *   假设 2（pristine 假设）：当前 Core 段落文本 === 原始行文本（编辑已全部撤销 /
 *     记录陈旧）⇒ 恒等映射。
 *   两假设都带**位置内容证明**，任一成立即区间经内容验证；都不成立 ⇒
 *   `core-axis-drift` fail-closed（绝不静默错格）。
 *
 * ── 生命周期 ──────────────────────────────────────────────────────────
 *   记录写入点 = cell unit 事务提交成功站点（每键刷新，last-write-wins）。
 *   清空点 = re-import / 文档重置边界（与 cellCommittedSpans / committedUnitOverlays
 *   同一生命周期——旧文档的 lineId/cellIndex 对新文档无意义）。
 *   Undo 不清账：陈旧记录只会让假设 1 内容证明失败 ⇒ 落假设 2 / fail-closed，
 *   绝不产生错误区间（自愈：下一次该格提交刷新记录）。
 *
 * ── 硬边界 ────────────────────────────────────────────────────────────
 *   纯内存注册表：零 React / 零 DOM / 零 Command / 零 mutation / 零持久化。
 *   已知限制（如实）：部分撤销中间态（一格编辑已撤、另一格仍生效）两个假设都不成立
 *   ⇒ fail-closed 回落整行（既有行为），不做逐记录子集搜索（复杂度不成比例）。
 */

// ─────────────────────────────────────────────────────────────────────
//  S1 · 类型
// ─────────────────────────────────────────────────────────────────────

/** 单条 cell 编辑记录（(lineId, cellIndex) 唯一；newText last-write-wins） */
export interface TableCellEditRecord {
  /** legacy 行 id（cell unitId 的锚身份） */
  readonly lineId: string;
  /** cell 序号（门 1 检测产物的 index；左→右稳定） */
  readonly cellIndex: number;
  /** 提交时登记的 Core 段落 id（门 2 死亡后定位段落的唯一来源） */
  readonly paragraphId: string;
  /** 该 cell 最近一次提交后的内容（当前 Core 真值） */
  readonly newText: string;
}

// ─────────────────────────────────────────────────────────────────────
//  S2 · 注册表
// ─────────────────────────────────────────────────────────────────────

export interface TableCellEditLedger {
  /** 登记一次 cell 提交（(lineId, cellIndex) upsert；newText 覆盖旧值） */
  record(entry: TableCellEditRecord): void;
  /** 该行的全部记录（只读视图；无记录 ⇒ 空数组） */
  recordsOf(lineId: string): readonly TableCellEditRecord[];
  /** re-import / 文档重置边界清空 */
  clear(): void;
  /** 记录总数（监测/探针用） */
  size(): number;
}

export function createTableCellEditLedger(): TableCellEditLedger {
  const byLine = new Map<string, TableCellEditRecord[]>();
  return {
    record(entry: TableCellEditRecord): void {
      if (!entry.lineId || !Number.isInteger(entry.cellIndex)) return;
      const list = byLine.get(entry.lineId);
      if (!list) {
        byLine.set(entry.lineId, [{ ...entry }]);
        return;
      }
      const idx = list.findIndex((r) => r.cellIndex === entry.cellIndex);
      if (idx >= 0) {
        // last-write-wins：段落身份不变（同一行同一格），文本刷新为最新提交
        list[idx] = { ...entry };
      } else {
        list.push({ ...entry });
      }
    },
    recordsOf(lineId: string): readonly TableCellEditRecord[] {
      const list = byLine.get(lineId);
      return list ? list.map((r) => ({ ...r })) : [];
    },
    clear(): void {
      byLine.clear();
    },
    size(): number {
      let n = 0;
      for (const list of byLine.values()) n += list.length;
      return n;
    },
  };
}
