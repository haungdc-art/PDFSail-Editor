/**
 * editor/binding/capability-core-commit.ts — F3B-6.17-3C-10A → E4
 *
 * Capability（replace / rewrite / translate）语义提交 → Core Command 的**生产接线层**：
 *   - 仅当 gate（`__replaceMode === "new"`）+ Core document 可用 + 区间可解析时走 Core；
 *   - Core 提交成功 ⇒ 不执行 Legacy（无双写）+ 标记 ownership=core；
 *   - Core 失败 / 不可用 ⇒ 回落注入的 Legacy Command（fallback 保持可达）；
 *   - E3-Impl-1：**Core-owned 时** Legacy fallback 必须 fail-closed（不得分裂文档）；
 *   - E4：rewrite / translate 与 replace 共用同一 Core-aware 执行器（capability 仅作意图标记）。
 *
 * 本模块**不实现** Legacy 语义，只把语义 mutation 委派给注入的 Legacy Command。
 */

import type { EditorDocument } from "../core/document/types";
import type { DocumentSelection } from "../../document-model/document-selection";
import type { CapabilityCommand } from "../../document-model/edit-capability";
import { resolveSegmentToCoreRange } from "./segment-core-range";
import { createSegmentCoreCommand } from "./segment-core-command";
import { toCapabilityIntent, type RegisteredCapability } from "./capability-contract";

export type CapabilityLegacyFallbackReason =
  | "migration-flag-off"
  | "no-core-document"
  | "invalid-intent"
  | "core-range-unresolved"
  | "commit-error";

export interface DecideCapabilityCommitPathInput {
  migrationEnabled: boolean;
  coreDocument: EditorDocument | null;
  intent: unknown;
  coreRange: ReturnType<typeof resolveSegmentToCoreRange> | null;
}

export type CapabilityCommitPath = { path: "core" } | { path: "legacy"; reason: CapabilityLegacyFallbackReason };

export function decideCapabilityCommitPath(input: DecideCapabilityCommitPathInput): CapabilityCommitPath {
  if (!input.migrationEnabled) return { path: "legacy", reason: "migration-flag-off" };
  if (!input.coreDocument) return { path: "legacy", reason: "no-core-document" };
  if (!input.intent) return { path: "legacy", reason: "invalid-intent" };
  if (!input.coreRange) return { path: "legacy", reason: "core-range-unresolved" };
  return { path: "core" };
}

/** Core session 抽象（生产接线处提供：从 coreInputSessionRef / coreDocumentRef 派生） */
export interface CapabilityCoreSessionLike {
  history: { commit: (command: unknown) => unknown };
}

export interface CapabilityReplaceCommandDeps {
  /** Legacy 兜底命令（既有 `ReplaceCommand` / `RewriteCommand` / `TranslateCommand`，**不修改**） */
  legacy: CapabilityCommand;
  /**
   * E4：能力名（"replace" | "rewrite" | "translate"）。缺省 "replace"。
   * rewrite / translate 经同一 Core-aware 执行器，仅用于意图来源标记，
   * **不改变** Core 命令构造（语义上仍是单行区间替换）。
   */
  capability?: RegisteredCapability;
  /** 是否启用 Core migration gate（`__replaceMode === "new"） */
  readFlag: () => boolean;
  /**
   * E3-Impl-1：当前 Core document 是否已被 Core 拥有（owned）。
   * 为 true 时，Core 提交失败 / 无 range 必须**阻断** Legacy fallback（fail-closed），
   * 不得让同一编辑事件分裂到 Legacy 再写一次。
   */
  readOwned: () => boolean;
  /** 取当前 Core document + session（无 session 时由生产接线创建） */
  getCore: () => { document: EditorDocument; session: CapabilityCoreSessionLike } | null;
  /** 取受影响行的 glyph（用于 Core range 解析 + 反向验证） */
  getGlyphs: (
    blockId: string,
    lineId: string
  ) => ReadonlyArray<{ char?: string; originalChar?: string }> | null;
  /** Core 提交成功回调（**只**在真正 changed=true 时由生产接线标记为 core 归属） */
  onCoreSuccess: (changed: boolean) => void;
  /** ownership 决策回调（core / legacy） */
  onOwnership: (owner: "core" | "legacy", reason?: string) => void;
  telemetry?: CapabilityCoreTelemetry;
}

export interface CapabilityCoreTelemetry {
  attempt: number;
  success: number;
  fallback: number;
  lastReason?: string;
}

export function createCapabilityCoreTelemetry(): CapabilityCoreTelemetry {
  return { attempt: 0, success: 0, fallback: 0 };
}

/**
 * ★ E3-Impl-1：Core-owned 时 Legacy fallback 阻断 marker。
 * 若有人删除此门控（或把 `readOwned` 判定改成恒 false），必须让 G15 反向验证守卫失败。
 */
const CORE_OWNED_LEGACY_CAPABILITY_REPLACE_BLOCKED = "CORE_OWNED_LEGACY_CAPABILITY_REPLACE_BLOCKED";

/**
 * Capability → Core Command 的**通用**执行器。
 * rewrite / translate 与 replace 共用本类，仅通过 deps.capability 区分意图来源。
 * 语义上三者都是单行区间替换（Core 不区分能力名），capability 仅作标记。
 */
export class CapabilityReplaceCommand implements CapabilityCommand {
  constructor(private deps: CapabilityReplaceCommandDeps) {}

  async execute(selection: DocumentSelection, payload?: Record<string, unknown>): Promise<void> {
    const gateOn = this.deps.readFlag();
    const intent = toCapabilityIntent(selection, payload, this.deps.capability ?? "replace");

    // 1) 判定路径（gate / core document / intent / range）
    //    B1.5 修复：coreDoc 为 null 时不得进入 range 解析（resolveSegmentToCoreRange
    //    会解引用 document.pages ⇒ 必须先短路，让 decideCapabilityCommitPath 返回
    //    no-core-document ⇒ 回落 Legacy / fail-closed，而不是崩溃）。
    const coreDoc = this.deps.getCore()?.document ?? null;
    const lineGlyphs = coreDoc ? this.deps.getGlyphs(selection.blockId, selection.lineId) : null;
    // glyphs 取不到（行不在 EditableDocument）⇒ range 无法解析 ⇒ core-range-unresolved
    // ⇒ 回落 Legacy / fail-closed（与「区间不可解析」同一 fail-closed 语义，绝不猜）。
    const coreRange = coreDoc && lineGlyphs
      ? resolveSegmentToCoreRange({
          document: coreDoc,
          source: {
            blockId: selection.blockId,
            lineId: selection.lineId,
            startGlyphIndex: selection.startGlyphIndex,
            endGlyphIndex: selection.endGlyphIndex,
          },
          glyphs: lineGlyphs,
        })
      : null;
    const decided = decideCapabilityCommitPath({
      migrationEnabled: gateOn,
      coreDocument: coreDoc,
      intent,
      coreRange,
    });

    if (decided.path === "legacy") {
      this.deps.telemetry && (this.deps.telemetry.attempt += 1);
      this.deps.telemetry && (this.deps.telemetry.fallback += 1);
      this.deps.telemetry && (this.deps.telemetry.lastReason = decided.reason);
      if (this.deps.readOwned()) {
        console.warn(`[${CORE_OWNED_LEGACY_CAPABILITY_REPLACE_BLOCKED}] ${decided.reason}`);
        return;
      }
      this.deps.onOwnership?.("legacy", decided.reason);
      await this.deps.legacy.execute(selection, payload);
      return;
    }

    // 2) Core 路径
    this.deps.telemetry && (this.deps.telemetry.attempt += 1);
    const core = this.deps.getCore();
    if (!core) {
      if (this.deps.readOwned()) {
        console.warn(`[${CORE_OWNED_LEGACY_CAPABILITY_REPLACE_BLOCKED}] no-core-session`);
        return;
      }
      this.deps.telemetry && (this.deps.telemetry.fallback += 1);
      this.deps.telemetry && (this.deps.telemetry.lastReason = "no-core-document");
      this.deps.onOwnership?.("legacy", "no-core-document");
      await this.deps.legacy.execute(selection, payload);
      return;
    }

    if (!coreRange || !intent) {
      if (this.deps.readOwned()) {
        console.warn(`[${CORE_OWNED_LEGACY_CAPABILITY_REPLACE_BLOCKED}] intent-or-range-missing`);
        return;
      }
      this.deps.telemetry && (this.deps.telemetry.fallback += 1);
      this.deps.telemetry && (this.deps.telemetry.lastReason = "invalid-intent");
      this.deps.onOwnership?.("legacy", "invalid-intent");
      await this.deps.legacy.execute(selection, payload);
      return;
    }


    let changed = false;
    try {
      const built = createSegmentCoreCommand({ ref: coreRange, newText: intent.text });
      const applied = core.session.history.commit(built.command);
      changed = (applied as { changed?: boolean }).changed === true;
    } catch (e) {
      // Core 提交异常
      if (this.deps.readOwned()) {
        // ★ fail-closed：Core-owned 文档不得分裂到 Legacy
        console.warn(`[${CORE_OWNED_LEGACY_CAPABILITY_REPLACE_BLOCKED}] commit-error`);
        if (this.deps.telemetry) this.deps.telemetry.lastReason = "commit-error";
        return;
      }
      this.deps.telemetry && (this.deps.telemetry.fallback += 1);
      this.deps.telemetry && (this.deps.telemetry.lastReason = "commit-error");
      this.deps.onOwnership?.("legacy", "commit-error");
      await this.deps.legacy.execute(selection, payload);
      return;
    }

    if (this.deps.telemetry) this.deps.telemetry.success += 1;
    this.deps.onCoreSuccess?.(changed);
    this.deps.onOwnership?.("core");
  }
}

export { CORE_OWNED_LEGACY_CAPABILITY_REPLACE_BLOCKED };
