/**
 * B3-C-5-E-B-B — Add Image → Core：字节 → Core 几何（纯函数，零 DOM / 零 File 依赖）。
 *
 * 职责（用户裁决：几何计算放进 adapter，绝不进 AddBlockCommand）：
 *   ① 从图片字节解码自然宽高（PNG / JPEG 头解析；不依赖浏览器 Image / canvas）
 *   ② 等比缩放到「最大边长约束」（默认 160px），产出 Core 语义几何 {width,height}
 *
 * 不可变 / 无副作用：相同输入恒得相同输出；不读/写任何 state、不碰 registry。
 */

/** Add Image 默认最大边长（px）。Core 文档里的几何是布局约束尺寸，非原始像素尺寸。 */
export const DEFAULT_IMAGE_MAX_SIZE = 160;

/**
 * 从字节解码自然尺寸。
 * 支持 PNG（IHDR）/ JPEG（SOF 标记）。其它格式返回 null（调用方回退到默认尺寸）。
 */
export function decodeImageDimensions(
  bytes: Uint8Array
): { width: number; height: number } | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    // PNG：IHDR 宽高在字节 16..23（大端）
    const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
    const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
    if (width > 0 && height > 0) return { width, height };
    return null;
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // JPEG：扫描标记，找到 SOF（0xFFC0..0xFFCF，排除 0xFFC4/0xFFC8/0xFFCC）
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = bytes[i + 1];
      // 独立标记（无长度字段）：SOI/EOI/RSTn
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        const height = (bytes[i + 5] << 8) | bytes[i + 6];
        const width = (bytes[i + 7] << 8) | bytes[i + 8];
        if (width > 0 && height > 0) return { width, height };
        return null;
      }
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/**
 * 计算 Core 图片几何：自然尺寸 → 等比缩放（最长边不超过 maxSize）→ 取整。
 * 无法解码（未知格式 / 损坏字节）时回退到 maxSize × maxSize。
 */
export function computeImageBlockGeometry(
  bytes: Uint8Array,
  _mime: string,
  maxSize: number = DEFAULT_IMAGE_MAX_SIZE
): { width: number; height: number } {
  const natural = decodeImageDimensions(bytes);
  if (!natural || natural.width <= 0 || natural.height <= 0) {
    return { width: maxSize, height: maxSize };
  }
  const scale = Math.min(1, maxSize / Math.max(natural.width, natural.height));
  const width = Math.max(1, Math.round(natural.width * scale));
  const height = Math.max(1, Math.round(natural.height * scale));
  return { width, height };
}
