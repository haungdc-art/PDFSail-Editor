/**
 * editor/binding/text-edit-input-shadow.ts — F3B-6.17-3C-10C.2
 *
 * **TextEdit Input Shadow**（纯模块；观察 + 比较 + 分级，**绝不执行**）。
 *
 * ── 目的（用户裁决）───────────────────────────────────────────────────
 * Shadow **不是**为了证明「Legacy 与 Core 文本结果完全一致」—— 3C-10C.1 已证明
 * Legacy 自身存在 emoji / ligature 坐标缺陷（glyph index 被当字符串索引切片）。
 * 它要证明的是：**Adapter 对真实 EditSession 输入的语义落点能够被解释**，
 * 并且把「已知 Legacy 缺陷」与「真正的 Adapter divergence」**分开**。
 *
 *     真实用户输入
 *           │
 *           ├──────────────┐
 *           ▼              ▼
 *     Legacy EditSession  TextEditInputAdapter
 *           │              │
 *           ▼              ▼
 *     Legacy TextOperation CoreInputIntent（**绝不提交 Command**）
 *           │              │
 *           └──────┬───────┘
 *                  ▼
 *          semantic comparison（kind + source range + replacement text + UTF-16 range）
 *
 * ── 硬不变量 ────────────────────────────────────────────────────────
 *   · 本模块**没有**任何提交/写入 API：`coreCommandCount()` 是字面 `0`（类型级 `0`）
 *   · 不 import Core commands / history / export；不触碰任何文档
 *   · 只做**前向**换算（glyph → UTF-16；复用 `glyphRangeToUtf16Range`）
 *   · 绝不为「两边一致」而修改 Legacy 语义（Enter 的 UI commit 行为**照实记录**）
 */

import { glyphRangeToUtf16Range } from "../../document-model/glyph-mapping";
import {
  toTextEditInputIntent,
  type TextEditInputRequest,
  type TextEditSessionSnapshot,
} from "./text-edit-input-adapter";
// 3C-10C.3A：提交投影已抽到中立层（shadow 与 Core commit 共同消费，避免生产依赖 shadow）
import { projectLegacyLineEdit, type LegacyLineEditProjection } from "./text-edit-session-projection";

export { projectLegacyLineEdit };
export type { LegacyLineEditProjection };

// ─────────────────────────────────────────────────────────────────────
//  分级（用户裁决的 5 级 + 1 个显式的 UI 提交语义分级）
// ─────────────────────────────────────────────────────────────────────

/**
 * Shadow 比较分级。
 *
 * `SEMANTIC_DIVERGENCE_UI_COMMIT` 是对用户给定 5 级的**显式补充**：
 * 「Core 有 `insertParagraph`，但 textarea 面把 Enter 当 commit」这种
 * **有意保留的 UI 语义分歧**必须有名有姓地记下来，而不是被塞进 MATCH 或 UNSUPPORTED。
 * 它**不阻断**下一阶段（阻断条件仍是用户锁定的 `UNEXPECTED_DIVERGENCE`）。
 */
export type ShadowClassification =
  | "MATCH"
  | "KNOWN_LEGACY_COORDINATE_BUG"
  | "UNSUPPORTED"
  | "INVALID_INPUT"
  | "SEMANTIC_DIVERGENCE_UI_COMMIT"
  | "UNEXPECTED_DIVERGENCE";

/** ★ 唯一阻断下一阶段的分级（用户锁定） */
export const SHADOW_BLOCKING_CLASSIFICATIONS: readonly ShadowClassification[] = [
  "UNEXPECTED_DIVERGENCE",
];

export function isBlockingShadowClassification(c: ShadowClassification): boolean {
  return SHADOW_BLOCKING_CLASSIFICATIONS.includes(c);
}

// ─────────────────────────────────────────────────────────────────────
//  观察结构
// ─────────────────────────────────────────────────────────────────────

/**
 * Legacy 侧「受影响的 glyph 区间」是怎么得到的（透明化，便于读懂证据）。
 *
 *   · `target-glyph-range`     —— 直接是 `EditSession.target`（replace-selection 模式，最忠实）
 *   · `caret-codepoint-span`   —— text-edit 模式：session caret 是**码点**偏移，
 *                                  Legacy kernel 会把这些数字**当作** glyph 索引使用
 *                                 （这正是 C.1 记录的单位混用；如实建模，不修饰）
 *   · `lcp-lcs-projection`      —— 提交时按「旧行 → 新行」的最长公共前缀/后缀投影出变更跨度
 *                                 （与 Legacy commit 的 `findDeletedGlyphRange` 同口径）
 */
export type TextEditLegacyRangeModel =
  | "target-glyph-range"
  | "caret-codepoint-span"
  | "lcp-lcs-projection"
  | "none";

/** Legacy 侧观察（真实路径**将要做什么**；只读快照，不含任何执行） */
export interface TextEditLegacyObservation {
  /** `commit` / `cancel` = 非文本操作（Enter / blur 的 UI 语义） */
  readonly kind: "replace" | "insert" | "delete" | "commit" | "cancel" | "none";
  /** Legacy glyph 区间（**含端**；纯插入按 Legacy 约定 = `end === start - 1`） */
  readonly startGlyphIndex?: number;
  readonly endGlyphIndex?: number;
  /** Legacy kernel 将使用的替换文本（"" = 删除） */
  readonly text?: string;
  /** 诊断：该操作为何发生（如 "keydown:Backspace" / "textarea-input" / "commit"） */
  readonly trigger?: string;
  /** 区间来源（透明化；缺省 `none`） */
  readonly rangeModel?: TextEditLegacyRangeModel;
}

export interface TextEditShadowObservationInput {
  readonly request: TextEditInputRequest;
  readonly snapshot: TextEditSessionSnapshot;
  readonly legacy: TextEditLegacyObservation;
}

export interface TextEditShadowRecord {
  readonly requestKind: string;
  readonly requestText: string;
  readonly blockId: string;
  readonly lineId: string;
  readonly editingMode: "replace-selection" | "text-edit";
  readonly trigger: string | null;
  /** Legacy 侧 */
  readonly legacyKind: TextEditLegacyObservation["kind"];
  readonly legacyRangeModel: TextEditLegacyRangeModel;
  readonly legacyGlyphRange: { readonly start: number; readonly end: number } | null;
  /** Legacy kernel 的**真实切片**（glyph index 当字符串索引 —— 已知缺陷来源） */
  readonly legacySlice: string | null;
  /** glyph → UTF-16 的**正确**切片（唯一允许方向） */
  readonly correctSlice: string | null;
  readonly correctRange: { readonly startOffsetUtf16: number; readonly endOffsetUtf16: number } | null;
  /** Adapter 侧 */
  readonly adapter:
    | {
        readonly ok: true;
        readonly kind: string;
        readonly range: { readonly startOffsetUtf16: number; readonly endOffsetUtf16: number };
        readonly text: string;
        readonly coreInputEventType: string;
      }
    | { readonly ok: false; readonly reason: string };
  readonly adapterSlice: string | null;
  /** 比较结果 */
  readonly classification: ShadowClassification;
  readonly blocking: boolean;
  readonly notes: readonly string[];
  /** ★ 硬不变量：Shadow 不提交任何 Command */
  readonly committedCoreCommand: false;
}

// ─────────────────────────────────────────────────────────────────────
//  工具
// ─────────────────────────────────────────────────────────────────────

function lineTextOf(glyphs: ReadonlyArray<{ readonly char?: string; readonly originalChar?: string }>): string {
  return glyphs.map((g) => g.char ?? g.originalChar ?? "").join("");
}

/** 是否有孤立代理码元（lone surrogate）—— Legacy naive slice 的典型症状 */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────
//  观察（纯函数）
// ─────────────────────────────────────────────────────────────────────

/**
 * 对一次真实输入做 shadow 观察 + 分级。
 *
 * 比较口径（用户裁决：不是简单文本相等）：
 *   ① operation kind（Legacy kind ↔ Adapter kind 是否可对应）
 *   ② source range（Legacy glyph 区间 → **前向**换算成 UTF-16 后与 Adapter 区间比对）
 *   ③ replacement text
 *   ④ canonical UTF-16 range
 */
export function observeTextEditInput(input: TextEditShadowObservationInput): TextEditShadowRecord {
  const { request, snapshot, legacy } = input;
  const notes: string[] = [];

  const lineText = lineTextOf(snapshot.glyphs);
  const adapter = toTextEditInputIntent(request, snapshot);

  // ── Legacy 侧（只读投影） ──────────────────────────────────────────
  const hasLegacyRange =
    typeof legacy.startGlyphIndex === "number" && typeof legacy.endGlyphIndex === "number";
  const legacyGlyphRange = hasLegacyRange
    ? { start: legacy.startGlyphIndex as number, end: legacy.endGlyphIndex as number }
    : null;

  // Legacy kernel 的真实算术：glyph index **直接当字符串索引**切片
  // （`onTextEditSave` / `RewriteCommand` / `mutateLineText(range)` 同口径）
  let legacySlice: string | null = null;
  if (legacyGlyphRange && legacy.kind !== "commit" && legacy.kind !== "cancel") {
    legacySlice = lineText.slice(legacyGlyphRange.start, legacyGlyphRange.end + 1);
  }

  // glyph → UTF-16（**唯一允许方向**）→ 正确切片 + 正确区间
  let correctSlice: string | null = null;
  let correctRange: { startOffsetUtf16: number; endOffsetUtf16: number } | null = null;
  if (legacyGlyphRange) {
    const r = glyphRangeToUtf16Range(
      snapshot.glyphs as Parameters<typeof glyphRangeToUtf16Range>[0],
      legacyGlyphRange.start,
      legacyGlyphRange.end
    );
    correctRange = { startOffsetUtf16: r.start, endOffsetUtf16: r.end };
    correctSlice = lineText.slice(r.start, r.end);
  }

  const adapterSlice =
    adapter.ok ? lineText.slice(adapter.intent.range.startOffsetUtf16, adapter.intent.range.endOffsetUtf16) : null;

  // ── 方向性删除（Backspace / Delete + collapsed caret）────────────────
  // Core 用「caret + 键方向」表达删除，Legacy 用「显式 glyph 跨度」。
  // ⇒ 这两者**不应**按跨度相等比较，而应比较**方向一致性**：
  //     backward ⇒ 被删跨度(src) 的**右端**必须等于 caret
  //     forward  ⇒ 被删跨度(src) 的**左端**必须等于 caret
  //   （全部在 UTF-16 口径下比较，绝不比 glyph 数与 UTF-16 偏移。）
  const directionalDelete =
    adapter.ok &&
    (request.kind === "delete-backward" || request.kind === "delete-forward") &&
    adapter.intent.range.startOffsetUtf16 === adapter.intent.range.endOffsetUtf16;
  const directionalConsistent =
    directionalDelete &&
    correctRange !== null &&
    adapter.ok &&
    (request.kind === "delete-backward"
      ? correctRange.endOffsetUtf16 === adapter.intent.range.startOffsetUtf16
      : correctRange.startOffsetUtf16 === adapter.intent.range.startOffsetUtf16);

  // ── 分级 ───────────────────────────────────────────────────────────
  let classification: ShadowClassification;

  if (legacy.kind === "commit" || legacy.kind === "cancel") {
    // 真实 UI 语义：Enter / blur / Esc —— Core 有 `insertParagraph`，但 textarea 面提交整行
    classification = "SEMANTIC_DIVERGENCE_UI_COMMIT";
    notes.push("ui-commit-semantics");
    notes.push("commit-trigger-enter-or-blur");
    notes.push("overlay-collapses-enter-and-blur-into-onSave");
  } else if (!adapter.ok) {
    classification = adapter.reason === "unsupported-operation" ? "UNSUPPORTED" : "INVALID_INPUT";
    notes.push(`adapter-rejected:${adapter.reason}`);
  } else if (directionalConsistent) {
    classification = "MATCH";
    notes.push("delete-direction-semantics(core=caret+key; legacy=explicit-span)");
  } else if (correctRange && !sameRange(correctRange, adapter.intent.range)) {
    // 区间不一致：**分类取决于 Legacy 区间是怎么来的**
    //   · `caret-codepoint-span` = 已知的单位混用（码点跨度被当作 glyph 索引）⇒ 已知缺陷
    //   · `target-glyph-range` / `lcp-lcs-projection` = 真正的 glyph 区间 ⇒ 才是待查分歧
    if ((legacy.rangeModel ?? "none") === "caret-codepoint-span") {
      classification = "KNOWN_LEGACY_COORDINATE_BUG";
      notes.push("unit-conflation:legacy-treats-codepoint-span-as-glyph-index");
    } else {
      classification = "UNEXPECTED_DIVERGENCE";
      notes.push("adapter-range-≠-glyph→utf16-range");
    }
  } else if (!legacyGlyphRange) {
    // 无可比对的 Legacy 区间（如导航键）—— 如实标注「什么都没比」
    classification = "MATCH";
    notes.push("no-legacy-range(nothing-compared)");
  } else if (legacySlice === correctSlice) {
    classification = "MATCH";
  } else {
    classification = "KNOWN_LEGACY_COORDINATE_BUG";
    notes.push("legacy-naive-glyph-index-slice");
  }

  if (legacySlice !== null && hasLoneSurrogate(legacySlice)) notes.push("legacy-slice-lone-surrogate");
  if (legacySlice !== null && correctSlice !== null && legacySlice !== correctSlice) {
    notes.push(`legacySlice=${JSON.stringify(legacySlice)} correctSlice=${JSON.stringify(correctSlice)}`);
  }
  if (snapshot.glyphs.length !== lineText.length) notes.push("glyph-count-≠-utf16-length");

  return {
    requestKind: request.kind,
    requestText: "text" in request ? request.text : "",
    blockId: snapshot.blockId,
    lineId: snapshot.lineId,
    editingMode: snapshot.editingMode,
    trigger: legacy.trigger ?? null,
    legacyKind: legacy.kind,
    legacyRangeModel: legacy.rangeModel ?? (legacyGlyphRange ? "target-glyph-range" : "none"),
    legacyGlyphRange,
    legacySlice,
    correctSlice,
    correctRange,
    adapter: adapter.ok
      ? {
          ok: true,
          kind: adapter.intent.kind,
          range: adapter.intent.range,
          text: adapter.intent.text,
          coreInputEventType: adapter.intent.coreInputEvent.type,
        }
      : { ok: false, reason: adapter.reason },
    adapterSlice,
    classification,
    blocking: isBlockingShadowClassification(classification),
    notes,
    committedCoreCommand: false,
  };
}

function sameRange(
  a: { readonly startOffsetUtf16: number; readonly endOffsetUtf16: number },
  b: { readonly startOffsetUtf16: number; readonly endOffsetUtf16: number }
): boolean {
  return a.startOffsetUtf16 === b.startOffsetUtf16 && a.endOffsetUtf16 === b.endOffsetUtf16;
}

// ─────────────────────────────────────────────────────────────────────
//  Recorder（内存环形记录；**无提交能力**）
// ─────────────────────────────────────────────────────────────────────

export interface TextEditShadowRecorder {
  /** 观察一次输入（纯计算 + 追加记录；无任何文档/Core 副作用） */
  record(input: TextEditShadowObservationInput): TextEditShadowRecord;
  records(): readonly TextEditShadowRecord[];
  reset(): void;
  /** ★ 硬不变量：本 recorder **从不**提交 Core Command（字面 0，构造成立） */
  coreCommandCount(): 0;
  /** 分级计数（诊断） */
  summary(): Record<ShadowClassification, number>;
}

export function createTextEditShadowRecorder(options: { readonly limit?: number } = {}): TextEditShadowRecorder {
  const limit = options.limit ?? 200;
  let list: TextEditShadowRecord[] = [];

  return {
    record(input) {
      const rec = observeTextEditInput(input);
      list.push(rec);
      if (list.length > limit) list = list.slice(list.length - limit);
      return rec;
    },
    records: () => list,
    reset: () => {
      list = [];
    },
    coreCommandCount: () => 0,
    summary() {
      const out: Record<ShadowClassification, number> = {
        MATCH: 0,
        KNOWN_LEGACY_COORDINATE_BUG: 0,
        UNSUPPORTED: 0,
        INVALID_INPUT: 0,
        SEMANTIC_DIVERGENCE_UI_COMMIT: 0,
        UNEXPECTED_DIVERGENCE: 0,
      };
      for (const r of list) out[r.classification] += 1;
      return out;
    },
  };
}
