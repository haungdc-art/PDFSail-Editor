/**
 * LockCoordSystem — Single Canvas PX coordinate system.
 * NO Y-axis flip. PDF.js viewport already handles transform.
 */
export class LockCoordSystem {
  viewport: { scale: number; width: number; height: number };

  constructor(viewport: { scale: number; width: number; height: number }) {
    this.viewport = viewport;
  }

  /** PDF.js text item → Canvas PX (Y flipped: PDF bottom-left → Canvas top-left) */
  fromPDF(item: any) {
    const tm = item.transform;
    const fontSize = item.fontSize || Math.sqrt(tm[0] ** 2 + tm[1] ** 2) || item.height || 12;
    const text = item.str || "";
    const fallbackW = this.estimateTextWidth(text, fontSize);
    const rawW = item.width ? item.width : fallbackW;
    const iw = Math.max(rawW, fallbackW);
    const totalH = fontSize * 1.3;   // line box height
    const ascH = fontSize * 1.0;     // ascender height (text visual top)
    return {
      x: tm[4] * this.viewport.scale,
      y: this.viewport.height - (tm[5] + ascH) * this.viewport.scale,
      w: iw * this.viewport.scale,
      h: totalH * this.viewport.scale,
      fontSize: fontSize * this.viewport.scale,
    };
  }

  private charWidth(ch: string, fontSize: number): number {
    const code = ch.codePointAt(0) || 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0x3040 && code <= 0x309f) || // Hiragana
      (code >= 0x30a0 && code <= 0x30ff) || // Katakana
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Ext A
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility
      (code >= 0xff00 && code <= 0xffef)    // Fullwidth
    ) {
      return fontSize;
    }
    if (code >= 0x3000 && code <= 0x303f) return fontSize * 0.5; // CJK punctuation
    return fontSize * 0.55;
  }

  private estimateTextWidth(text: string, fontSize: number): number {
    let w = 0;
    for (const ch of text) w += this.charWidth(ch, fontSize);
    return w;
  }


  /** OCR bbox → Canvas PX */
  fromOCR(bbox: { x0: number; y0: number; x1: number; y1: number }) {
    return {
      x: bbox.x0 * this.viewport.scale,
      y: bbox.y0 * this.viewport.scale,
      w: (bbox.x1 - bbox.x0) * this.viewport.scale,
      h: (bbox.y1 - bbox.y0) * this.viewport.scale,
    };
  }

  /** Canvas PX → PDF pt (export only, Y flipped: canvas top-left → PDF bottom-left) */
  toPDF(block: { x: number; y: number; w: number; h: number }) {
    const pageH = this.viewport.height / this.viewport.scale;
    return {
      x: block.x / this.viewport.scale,
      y: pageH - (block.y / this.viewport.scale) - (block.h / this.viewport.scale),
      w: block.w / this.viewport.scale,
      h: block.h / this.viewport.scale,
    };
  }

  /** Canvas PX → Screen (identity — already in Canvas PX) */
  toScreen(block: { x: number; y: number; w: number; h: number }) {
    return { left: block.x, top: block.y, width: block.w, height: block.h };
  }
}
