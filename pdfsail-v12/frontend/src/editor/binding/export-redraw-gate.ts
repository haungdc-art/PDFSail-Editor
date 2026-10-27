/**
 * export-redraw-gate.ts — F3B-6.28 · D-3B-**4**（第 4 步）→ **D-3B-5**（生产开启）
 *
 * 背景：3B-2 已证明「原始算子清除 → 新位置重绘 → 内容流可验证」在 D1 追加场景成立，
 * 但写入资格此前是「unit 计划有效即挂载」的**隐式**条件。第 4 步把它改成
 * **显式、可控**的门；第 5 步（用户 2026-10-14 裁决）**批准开启生产 gate**，
 * 但只限已验证的 D1 段落末尾追加场景：
 *
 *   · `__exportRedraw` 缺省 **ON**（生产开启）；仅显式 `=== false` 关闭
 *     （紧急回滚；与 `__coreTextEditInput` / `__segmentCoreMigration` 同契约）；
 *   · SSR / 无宿主 ⇒ 保守关闭（导出只在浏览器发生；Node 测试因此逐字节保持旧行为）；
 *   · 关闭 ⇒ 不注入任何重绘 provider ⇒ 导出逐字节走既有路径（与 3B-2 之前一致）；
 *   · 开启后仍需满足全部**写入资格**条件：
 *       计划在效 + **场景已授权**（`export-redraw-scenario.ts`）+ 全部必需行已投影
 *       + 无未认领目标行。
 *
 * 本模块只做**判定**（纯函数 + flag 读取），不执行导出、不碰 PDF。
 */

/** 显式重绘门开关名（**缺省 ON**，仅显式 `false` 关闭） */
export const EXPORT_REDRAW_FLAG = "__exportRedraw";

/**
 * 读取显式重绘门。
 *
 * - 显式 `=== false` ⇒ false（紧急回滚）
 * - 缺省 / `true` / 其它值 ⇒ true（**生产缺省开启**，D-3B-5 用户裁决）
 * - SSR（无宿主）⇒ false（保守关闭；Node 侧测试环境行为与门关闭时一致）
 */
export function readExportRedrawFlag(scope?: { [EXPORT_REDRAW_FLAG]?: unknown }): boolean {
  const target =
    scope ?? (typeof window !== "undefined" ? (window as unknown as object) : undefined);
  if (!target) return false; // SSR / 无宿主 ⇒ 保守关闭
  return (target as Record<string, unknown>)[EXPORT_REDRAW_FLAG] !== false;
}

/** 拒绝原因（可观测；拒绝时**不产出 PDF**，不静默降级） */
export type ExportRedrawGateReason =
  | "gate-closed"
  | "no-current-plan"
  | "scenario-not-authorized"
  | "pipeline-ineligible"
  | "unclaimed-target-lines";

export interface ExportRedrawGateInput {
  /** 显式门是否开启（`readExportRedrawFlag()`） */
  gateOpen: boolean;
  /** 位移清除/重绘计划是否仍有效（事务水位 + 事务 id + sidecar 代次） */
  planCurrent: boolean;
  /**
   * D-3B-5：计划场景是否已授权（`classifyExportRedrawScenario` ⇒
   * `EXPORT_REDRAW_AUTHORIZED_SCENARIO`）。未授权场景（替换/删除/合并/
   * 多段落流动/跨页推挤）⇒ 整体不参与清除与重绘，导出走既有路径。
   */
  scenarioAuthorized: boolean;
  /** 流水线资格：全部必需行已投影（3B-2 `redrawEligible`） */
  redrawEligible: boolean;
  /** 未被任何 legacy 行认领的目标行数（>0 ⇒ 该行不会被重绘 ⇒ 缺行） */
  unclaimedLineCount: number;
}

export interface ExportRedrawGateResult {
  allowed: boolean;
  reason: ExportRedrawGateReason | null;
}

/**
 * 写入资格判定（**顺序固定**，便于归因）：
 *   ① 门未开 ⇒ gate-closed（显式回滚 ⇒ 行为与 3B-4 之前逐字节一致）
 *   ② 计划失效（Undo 过头 / 事务被取代 / 换文档）⇒ no-current-plan
 *   ③ 场景未授权（非 D1 段落末尾追加）⇒ scenario-not-authorized
 *      ⇒ 调用方必须让 unit 计划输入整体失效（清除与重绘都不做）
 *   ④ 有必需行未投影 ⇒ pipeline-ineligible（绝不「清除后缺行」）
 *   ⑤ 有目标行无人认领 ⇒ unclaimed-target-lines（同样绝不缺行）
 */
export function decideExportRedrawGate(input: ExportRedrawGateInput): ExportRedrawGateResult {
  if (!input.gateOpen) return { allowed: false, reason: "gate-closed" };
  if (!input.planCurrent) return { allowed: false, reason: "no-current-plan" };
  if (!input.scenarioAuthorized) return { allowed: false, reason: "scenario-not-authorized" };
  if (!input.redrawEligible) return { allowed: false, reason: "pipeline-ineligible" };
  if (input.unclaimedLineCount > 0) {
    return { allowed: false, reason: "unclaimed-target-lines" };
  }
  return { allowed: true, reason: null };
}

/**
 * 第 4 步决策一：**无 provenance 的原字符** 处置（renderer 依此执行）。
 *
 *   - `raw`    ：有完整原字符 CID + transform ⇒ 原字体 raw-CID 直发
 *   - `skip`   ：**原字符**且无 CID，但已被证明是合成空白（无墨迹）⇒ 跳过（不画）
 *   - `fallback`：**新增字符**（无原 provenance，如追加文本）⇒ 既有 NotoSansSC CID 链
 *   - `fail`   ：原字符且无 CID 又**不是**可证明的合成空白 ⇒ fail-closed（拒绝导出）
 */
export type RedrawGlyphDisposition = "raw" | "skip" | "fallback" | "fail";

/**
 * 判定单个重绘字符的处置。
 *
 * @param hasRawProvenance 是否有原字符 CID + 6 元 transform
 * @param isOriginalChar   是否对应原文 glyph（`sourceGlyphIndex !== null`）
 * @param char             字符本身（合成空白判据 = `/\s/`）
 */
export function classifyRedrawGlyph(args: {
  hasRawProvenance: boolean;
  isOriginalChar: boolean;
  char: string;
}): RedrawGlyphDisposition {
  if (args.hasRawProvenance) return "raw";
  if (!args.isOriginalChar) return "fallback"; // 新增字符：允许回退字体（D1 = NotoSansSC）
  // 原字符缺来源：只有「可验证的合成空白」才允许跳过；其它一律 fail-closed
  return /\s/.test(args.char) ? "skip" : "fail";
}
