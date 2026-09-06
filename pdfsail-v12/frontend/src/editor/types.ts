export type BaseBlock = {
  id: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

/**
 * 原文遮盖区域 — 用于 OCR 替换模式
 *
 * source layer（原文）和 render layer（编辑结果）分离：
 *   - bbox (x,y,w,h): 新文字渲染区域（单行）
 *   - originalBounds: 原文段落区域（多行，用于白色遮盖）
 *
 * 渲染流程：
 *   1. 用 originalBounds 画白色矩形覆盖原文（source layer mask）
 *   2. 用 bbox 画新文字（render layer）
 */
export type OriginalBounds = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type PDFTextNode = {
  id: string;
  page: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
};

export type TextBlock = BaseBlock & {
  type: "text";
  text: string;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  /** OCR 替换模式：原文段落 bbox，用于白色遮盖（source layer） */
  originalBounds?: OriginalBounds;
};
export type ImageBlock = BaseBlock & { type: "image"; src: string };
export type SignatureBlock = BaseBlock & { type: "signature"; dataUrl: string };
export type RedactBlock = BaseBlock & { type: "redact" };
export type HighlightBlock = BaseBlock & { type: "highlight"; hType?: "text" | "freehand" | "underline" | "strike" | "wavy"; color?: string; opacity?: number };
export type CommentBlock = BaseBlock & {
  type: "comment";
  text: string;
  aType?: "note" | "highlight" | "strike" | "underline";
  anchor?: { textId: string; offset: number; length: number };
  color?: string;
  resolved?: boolean;
};

export type Block = TextBlock | ImageBlock | SignatureBlock | RedactBlock | HighlightBlock | CommentBlock;
