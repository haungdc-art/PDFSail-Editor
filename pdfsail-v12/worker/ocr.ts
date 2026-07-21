import { createWorker } from "tesseract.js";

export type OCRJob = {
  imageBuffer: Buffer;
  language?: string;
};

export type OCRResult = {
  text: string;
  confidence: number;
};

/**
 * Run OCR on an image buffer using Tesseract.js
 * Designed to run in a worker thread for non-blocking processing
 */
export async function runOCR({ imageBuffer, language = "chi_sim+eng" }: OCRJob): Promise<OCRResult> {
  const worker = await createWorker(language);

  try {
    const { data } = await worker.recognize(imageBuffer);
    return {
      text: data.text,
      confidence: data.confidence,
    };
  } finally {
    await worker.terminate();
  }
}

/**
 * Process multiple pages in sequence
 */
export async function runBatchOCR(
  pages: { imageBuffer: Buffer; language?: string }[]
): Promise<OCRResult[]> {
  const results: OCRResult[] = [];
  for (const page of pages) {
    const result = await runOCR(page);
    results.push(result);
  }
  return results;
}
