export type BaseBlock = {
  id: string;
  page: number;
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

export type TextBlock = BaseBlock & { type: "text"; text: string; fontSize?: number; fontFamily?: string; color?: string };
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
