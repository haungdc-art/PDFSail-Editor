/**
 * C5-D-B — Core Image Render Binding Adapter
 * ───────────────────────────────────────────────────────────────────────────
 * 职责（单向、只读投影）：
 *   Core `EditorDocument` 中的 `ImageObject`（**只持 assetRef，不持字节**）
 *     → Binding 层 `ImageAssetRegistry.resolve(assetRef)` 取字节
 *     → 转换为浏览器 image source（data URL）
 *     → 屏幕 `DrawImageCommand`
 *
 * ★ 边界（与 C5-A / C5-C 锁死的契约一致）：
 *   ① Render 与 Export 协议保持分离 —— 本模块只产出**屏幕** RenderCommand，
 *      绝不触碰 `document-model/export-command.ts` 的 Export DrawImageCommand。
 *   ② **图片字节绝不进入 Core**：只经 Binding 在渲染期取字节 → src → RenderCommand
 *      （RenderCommand 属渲染层，不是 Core 状态）。
 *   ③ `transform` 仿射降为 `rotation` 是**兼容投影 ONLY**（与 `createImageObject`
 *      同口径 `atan2(b,a)`），**绝不**写回 `ImageObject`、绝不修改 Core 对象、
 *      绝不声称支持完整 transform、绝不实现 Rotate。
 *   ④ assetRef 解析失败（缺失/无效/空字节）⇒ 跳过该图 ⇒ 保留 legacy 路径（不白屏）。
 *
 * 设计：本文件是独立纯函数，**不修改 `projectDocument` 的文本投影逻辑**；
 *   `buildCoreRenderSource` / `buildCoreRenderSourceFromDocument` 在 `projectDocument`
 *   成功返回前调用本函数，把屏幕 image 命令追加进 `commands`。
 */

import type {
  EditorDocument,
  EditorObject,
  ImageObject,
} from "../core/document/types";
import type { DrawImageCommand, RenderCommand } from "../../document-model/render-command";
import { imageAssetRegistry, type ImageAssetRegistry } from "./image-asset-registry";

export interface CoreImageRenderOptions {
  /** 缺省 = 全局 `imageAssetRegistry` 单例 */
  registry?: ImageAssetRegistry;
}

const ROTATION_NORMALIZATION_EPSILON_DEG = 0.01;

/**
 * 从归一化仿射分量 `[a,b,c,d]` 投影出屏幕旋转角（与 `createImageObject` 同口径
 * `atan2(b, a)`，单位 deg，顺时针为正 —— CSS 约定）。
 *
 * ★ 兼容投影 ONLY：不写回、不声称完整 transform 支持、不做 skew/scale 还原。
 * 非法 / 缺省 ⇒ 返回 `undefined`（调用方回退到 `ImageObject.rotation`）。
 */
export function rotationFromTransform(
  transform?: readonly [number, number, number, number]
): number | undefined {
  if (!transform || transform.length < 2) return undefined;
  const a = transform[0];
  const b = transform[1];
  if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) {
    return undefined;
  }
  let deg = (Math.atan2(b, a) * 180) / Math.PI;
  // 归一化到 (-180, 180]
  while (deg <= -180) deg += 360;
  while (deg > 180) deg -= 360;
if (Math.abs(deg) < ROTATION_NORMALIZATION_EPSILON_DEG) return 0;
  return deg;
}

function base64FromBytes(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  // Node 环境（tsx 测试）
  return Buffer.from(bytes).toString("base64");
}

/** 字节 → 浏览器 image source（data URL；leak-free，浏览器/Node 通用） */
function bytesToImageSource(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${base64FromBytes(bytes)}`;
}

function collectImageObjects(document: EditorDocument): ImageObject[] {
  const out: ImageObject[] = [];
  for (const page of document.pages) {
    if (!page.objects) continue;
    for (const obj of page.objects) {
      if ((obj as EditorObject).type === "image") out.push(obj as ImageObject);
    }
  }
  return out;
}

/**
 * 把 Core `EditorDocument` 中的图片投影为屏幕 `DrawImageCommand[]`。
 *
 * 返回**成功解析**的图片命令（按出现顺序）。解析失败的图片被静默跳过，由
 * legacy 渲染路径兜底（绝不白屏）。
 */
export function buildCoreImageRenderCommands(
  document: EditorDocument,
  options: CoreImageRenderOptions = {}
): DrawImageCommand[] {
  const registry = options.registry ?? imageAssetRegistry;
  const commands: DrawImageCommand[] = [];

  for (const img of collectImageObjects(document)) {
    if (!img.assetRef) continue; // 无引用 ⇒ 无法解析 ⇒ 保留 legacy

    const asset = registry.resolve(img.assetRef);
    if (!asset || !asset.bytes || asset.bytes.length === 0) {
      // 解析失败（缺失/无效/空字节）⇒ 跳过 ⇒ legacy 兜底（不白屏）
      continue;
    }

    const src = bytesToImageSource(asset.bytes, asset.mime || "image/png");
    const rotation = rotationFromTransform(img.transform) ?? (img.rotation || 0);

    commands.push({
      type: "drawImage",
      src,
      x: img.x,
      y: img.y,
      width: img.width,
      height: img.height,
      blockId: img.id,
      rotation,
    });
  }

  return commands;
}

/**
 * 类型守卫（供 `mergeCoreRenderCommands` 复用，避免重复 import 展开）。
 */
export function isImageRenderCommand(cmd: RenderCommand): cmd is DrawImageCommand {
  return cmd.type === "drawImage";
}
