/**
 * editor/core/input/paste.ts — EDITOR-CORE-008
 *
 * 剪贴板文本 → CORE-003 Command。
 *
 * ── 换行语义不在本层定义（规范 §7 的延续）────────────────────────
 * 本层只做**文本规范化**（CRLF/CR → LF、剔除控制字符），
 * "\n" 一律按 CORE-003 的语义解释为**段落拆分**，
 * Input 层**不**自己定义换行模型、也不自己拆段。
 *
 * ── 不做的事 ──────────────────────────────────────────────────────
 *   · 不做 trim（保留粘贴原文的空白）
 *   · 不解析富文本/HTML（008 只处理纯文本）
 *   · 不做图片/文件粘贴
 */

import type { EditorCommand } from "../commands/types";
import { insertOrReplace } from "./keyboard";
import type { InputContext } from "./types";

/**
 * 规范化粘贴文本。
 *
 *   ① `\r\n`、单独的 `\r` → `\n`
 *   ② `\t` → 单个空格（Editor Core 目前没有制表位模型）
 *   ③ 剔除其余 C0 控制字符与 DEL（保留 `\n`）
 */
export function normalizePastedText(raw: string): string {
  if (raw === "") return "";
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export interface PasteOutcome {
  commands: EditorCommand[];
  warnings: string[];
  /** 规范化后的文本（诊断/测试用） */
  normalized: string;
}

export function commandsForPaste(context: InputContext, raw: string): PasteOutcome {
  const warnings: string[] = [];
  const normalized = normalizePastedText(raw);

  if (normalized === "") {
    warnings.push("粘贴内容为空（或规范化后为空）→ 0 个 Command");
    return { commands: [], warnings, normalized };
  }

  const commands = insertOrReplace(context, normalized);
  const lines = normalized.split("\n").length;
  if (lines > 1) {
    warnings.push(
      `多行粘贴（${lines} 行）：仍是**一条** Command，段落拆分由 CORE-003 的 "\\n" 语义完成`
    );
  }
  return { commands, warnings, normalized };
}
