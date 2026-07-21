import Tesseract from "tesseract.js";
import type { Block } from "./types";

export async function OCRToBlocks(image: string, page: number): Promise<Block[]> {
  const scale = 2;
  const img = await upscaleImage(image, scale);

  const res = await Tesseract.recognize(img, "chi_sim+eng", { logger: () => {} });

  const words = (res.data.words as any[])
    .filter((w) => w.text?.trim())
    .filter((w) => (w.confidence ?? 0) > 45)
    .filter((w) => w.bbox.x1 - w.bbox.x0 > 8 && w.bbox.y1 - w.bbox.y0 > 8);

  return mergeLineWords(words, page, scale);
}

async function upscaleImage(dataUrl: string, scale: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function mergeLineWords(words: any[], page: number, scale: number, yThreshold = 8): Block[] {
  const groups: any[][] = [];
  let current: any[] = [];

  const sorted = [...words].sort((a, b) => {
    if (Math.abs(a.bbox.y0 - b.bbox.y0) < yThreshold) return a.bbox.x0 - b.bbox.x0;
    return a.bbox.y0 - b.bbox.y0;
  });

  for (const w of sorted) {
    if (current.length === 0) {
      current = [w];
      continue;
    }
    const last = current[current.length - 1];
    const sameLine = Math.abs(w.bbox.y0 - last.bbox.y0) < yThreshold;
    const closeX = w.bbox.x0 - last.bbox.x1 < 20;
    if (sameLine && closeX) {
      current.push(w);
    } else {
      groups.push(current);
      current = [w];
    }
  }
  if (current.length) groups.push(current);

  return groups.map((g) => {
    const x0 = g[0].bbox.x0;
    const y0 = g[0].bbox.y0;
    const x1 = g[g.length - 1].bbox.x1;
    const y1 = Math.max(...g.map((w) => w.bbox.y1));
    const h = Math.round((y1 - y0) / scale);
    return {
      id: crypto.randomUUID(),
      type: "text" as const,
      page,
      x: x0 / scale,
      y: y0 / scale,
      w: (x1 - x0) / scale,
      h,
      text: g.map((w) => w.text).join(""),
      fontSize: h * 0.92,
    } as Block;
  });
}
