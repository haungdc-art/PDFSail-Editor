/**
 * editor/binding/cell-monitor.ts — F3B-6.28 · C：cell 编辑监测聚合（纯模块；契约 §17）
 *
 * ── 目的 ────────────────────────────────────────────────────────────────
 *   为「门默认值裁定（D）」提供可靠性证据：聚合计数锚失效 reason / 意外安全退出 /
 *   跨格写入迹象 / unit 事务异常。**不改变任何编辑行为**。
 *
 * ── 硬边界（契约 §17.1，全部可守卫）────────────────────────────────────
 *   ① 零 React / DOM / window / Command / 文本 API（调用方负责读 flag 与窗口开关）；
 *   ② 监测对象 = 枚举 reason + 计数 + 相对时间；**零文本参数**（不记录正文/用户输入/
 *      文件名/页码/原始 id）；
 *   ③ 全部同步内存写（无网络 / 无 await / 无 storage）⇒ 不阻塞编辑；
 *   ④ 关闭机制：接线层读 `window.__cellMonitorEnabled === false` 或本状态 `enabled=false`
 *      或已自动止损 ⇒ 停止记录（`isRecordingEnabled`）。
 *
 * ── 假名纪律（契约 §17.3）───────────────────────────────────────────────
 *   `pseudonymizeUnitId(sessionId, unitId)` = FNV-1a-32（同步纯函数；sha256 需异步
 *   crypto.subtle，与渲染路径的同步约束冲突）。安全性论证不变：sessionId 为**会话级
 *   随机盐**（每次加载重新生成、不持久化）⇒ 跨会话不可关联；模块**不持久化任何数据**。
 *   ★ 明示：这是**假名化，不是匿名化**。
 */

// ── 类型 ────────────────────────────────────────────────────────────────

export type CellMonitorKind =
  | "anchorLifecycle"
  | "anchorSafeExit"
  | "cellWriteSuspect"
  | "unitTxnFail"
  | "unitTxnAttempt";

const KINDS: readonly CellMonitorKind[] = [
  "anchorLifecycle",
  "anchorSafeExit",
  "cellWriteSuspect",
  "unitTxnFail",
  "unitTxnAttempt",
];

export interface CellMonitorState {
  readonly sessionId: string;
  /** 关闭开关（接线层从 `window.__cellMonitorEnabled` 同步；缺省 true） */
  enabled: boolean;
  counters: Record<CellMonitorKind, Record<string, number>>;
  totals: Record<CellMonitorKind, number>;
  lastReason: Record<CellMonitorKind, string | null>;
  lastAt: Record<CellMonitorKind, number | null>;
  /** 自动止损（cellWriteSuspect > 0）触发时间；null = 未触发 */
  autoDisabledAt: number | null;
  autoDisabledReason: string | null;
}

const emptyBuckets = (): Record<string, number> => ({});

/** 创建监测状态（sessionId 由接线层生成：会话级随机盐，不持久化） */
export function createCellMonitorState(sessionId: string): CellMonitorState {
  const counters = {} as Record<CellMonitorKind, Record<string, number>>;
  const totals = {} as Record<CellMonitorKind, number>;
  const lastReason = {} as Record<CellMonitorKind, string | null>;
  const lastAt = {} as Record<CellMonitorKind, number | null>;
  for (const k of KINDS) {
    counters[k] = emptyBuckets();
    totals[k] = 0;
    lastReason[k] = null;
    lastAt[k] = null;
  }
  return {
    sessionId,
    enabled: true,
    counters,
    totals,
    lastReason,
    lastAt,
    autoDisabledAt: null,
    autoDisabledReason: null,
  };
}

// ── 记录 ────────────────────────────────────────────────────────────────

/** 记一条事件（同步内存写；reason 必须是**枚举字面量**，禁止携带文本内容） */
export function recordCellMonitorEvent(
  state: CellMonitorState,
  kind: CellMonitorKind,
  reason: string,
  nowMs: number,
): void {
  const bucket = state.counters[kind];
  bucket[reason] = (bucket[reason] ?? 0) + 1;
  state.totals[kind] += 1;
  state.lastReason[kind] = reason;
  state.lastAt[kind] = nowMs;
}

/** 是否应记录（关闭开关 / 已自动止损 ⇒ false） */
export function isRecordingEnabled(state: CellMonitorState): boolean {
  return state.enabled && state.autoDisabledAt === null;
}

// ── 阈值与止损（契约 §17.4；处置动作由接线层执行）────────────────────────

/** 止损判定：跨格写入迹象（cellWriteSuspect）> 0 ⇒ 立即止损（硬缺陷） */
export function evaluateStopThreshold(state: CellMonitorState): { stop: boolean; reason: string | null } {
  if (state.totals.cellWriteSuspect > 0) {
    return { stop: true, reason: state.lastReason.cellWriteSuspect };
  }
  return { stop: false, reason: null };
}

/** 执行止损登记（接线层同时把 `window.__cellUnitEditing` 置 false） */
export function applyAutoStop(state: CellMonitorState, nowMs: number, reason: string): void {
  if (state.autoDisabledAt === null) {
    state.autoDisabledAt = nowMs;
    state.autoDisabledReason = reason;
  }
}

// ── 假名（会话级盐 + 非加密散列；跨会话不可关联；不持久化）────────────────

/** FNV-1a 32-bit（同步纯函数；无 DOM / crypto 依赖） */
function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** unitId 的短期假名：8 个十六进制字符（跨会话不可关联；**非匿名化**） */
export function pseudonymizeUnitId(sessionId: string, unitId: string): string {
  return fnv1a32(`${sessionId}:${unitId}`).toString(16).padStart(8, "0");
}

// ── 快照（探针导出用；深拷贝 ⇒ 外部改动不影响监测状态）───────────────────

export function snapshotCellMonitor(state: CellMonitorState): {
  sessionId: string;
  enabled: boolean;
  counters: Record<CellMonitorKind, Record<string, number>>;
  totals: Record<CellMonitorKind, number>;
  lastReason: Record<CellMonitorKind, string | null>;
  lastAt: Record<CellMonitorKind, number | null>;
  autoDisabledAt: number | null;
  autoDisabledReason: string | null;
} {
  const counters = {} as Record<CellMonitorKind, Record<string, number>>;
  for (const k of KINDS) counters[k] = { ...state.counters[k] };
  return {
    sessionId: state.sessionId,
    enabled: state.enabled,
    counters,
    totals: { ...state.totals },
    lastReason: { ...state.lastReason },
    lastAt: { ...state.lastAt },
    autoDisabledAt: state.autoDisabledAt,
    autoDisabledReason: state.autoDisabledReason,
  };
}
