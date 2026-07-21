import { PDFDocument, RotationTypes } from "pdf-lib";

export async function rotatePDF(
  sourceBytes: Uint8Array,
  degrees: 90 | 180 | 270,
  mode: "all" | "current" = "all",
  pageIndex = 0
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });

  const targets = mode === "all"
    ? [...Array(doc.getPageCount()).keys()]
    : [pageIndex];

  for (const idx of targets) {
    const page = doc.getPage(idx);
    const current = page.getRotation().angle;
    page.setRotation({ type: RotationTypes.Degrees, angle: (current + degrees) % 360 });
  }

  return await doc.save();
}
