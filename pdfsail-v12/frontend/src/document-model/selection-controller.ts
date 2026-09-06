/**
 * SelectionController — Selection 统一入口（Task-007C · 收紧）
 *
 * 职责边界：SelectionController 只知道 Boundary，不知道 x/y/DOM/Mouse。
 * 它把 Boundary → SelectionStrategy → DerivedSelection。
 *
 *   Mouse/Touch/Pen            Keyboard
 *        │  boundaryFromPoint()   │ CurrentBoundary
 *        ▼                        ▼
 *   Boundary ─────────────────────► SelectionController
 *                                        │ expand(boundary, mode)
 *                                        ▼
 *                                 SelectionStrategy（character/word/sentence/paragraph）
 *                                        │
 *                                        ▼
 *                                 DerivedSelection
 *                                        │
 *                                        ▼
 *                                 HighlightRenderer
 *
 * 原则：
 * - Boundary 是所有输入设备（Mouse/Keyboard/Touch/Pen）共同的语言。
 * - Controller 永不接收 Point / DOM / Mouse，只接收 Boundary。
 * - boundaryFromPoint（坐标 → Boundary）属于 HitTest，放在 GlyphRenderer。
 * - GlyphRenderer 不直接知道 Word/Sentence/Character Strategy，只调 Controller。
 */
import type { Boundary, DerivedSelection, TextFlow } from "./selection-engine";
import {
  WordSelectionStrategy,
  CharacterSelectionStrategy,
  SentenceSelectionStrategy,
  ParagraphSelectionStrategy,
  type SelectionStrategy,
} from "./selection-strategy";

/** 选择模式（对应不同 SelectionStrategy） */
export type SelectionMode = "character" | "word" | "sentence" | "paragraph";

export class SelectionController {
  private strategies: Record<SelectionMode, SelectionStrategy>;

  constructor(private flow: TextFlow) {
    this.strategies = {
      character: new CharacterSelectionStrategy(),
      word: new WordSelectionStrategy(),
      sentence: new SentenceSelectionStrategy(),
      paragraph: new ParagraphSelectionStrategy(),
    };
  }

  /**
   * 唯一入口：Boundary → Strategy → DerivedSelection。
   * 不接收 Point，不调 boundaryFromPoint。
   */
  expand(boundary: Boundary, mode: SelectionMode): DerivedSelection {
    return this.strategies[mode].expand(boundary, this.flow);
  }

  /** 单击：CharacterSelectionStrategy */
  expandCharacter(boundary: Boundary): DerivedSelection {
    return this.expand(boundary, "character");
  }

  /** 双击：WordSelectionStrategy */
  expandWord(boundary: Boundary): DerivedSelection {
    return this.expand(boundary, "word");
  }

  /** 三击：SentenceSelectionStrategy */
  expandSentence(boundary: Boundary): DerivedSelection {
    return this.expand(boundary, "sentence");
  }
}
