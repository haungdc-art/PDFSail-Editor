/**
 * editor/binding/image-asset-registry.ts — B3-C-5-B
 *
 * Core ↔ Binding 的**基础资源生命周期设施**（不是"图像功能"）。
 *
 * 唯一职责：把 `assetRef`（字符串引用）映射到 Binding 侧持有的原始资源
 * `ImageAsset { id, bytes, mime }`。
 *
 * ── 边界（强制，对应 C5-A 已钉死的 Core/Binding 分界）─────────────────
 *   · 本模块属于 **Binding / Runtime**，**不属于 Core**。
 *   · Core 只持有 `ImageObject.assetRef`；**绝不**读取 bytes / src / mime，
 *     也**绝不** import 本模块（Core ↔ Registry 单向无关）。
 *   · 本 registry **不**建模 ImageObject 的存在 / 位置 / 尺寸——
 *     那是 Core 的独占职责（Core 决定有没有、在哪、多大）。
 *   · 本 registry 只回答一个问题："这个 assetRef 对应的原始资源是什么？"
 *
 * ── 生命周期（C5-B）──────────────────────────────────────────────────
 *   · 导入边界（`initializeCoreDocument`）把 `ImportResult.assets` 注册进运行时。
 *   · 删除 ImageObject 时**不**自动 remove asset：
 *     Reference counting / document-scoped GC 是后续阶段（C5-E 之后），
 *     不是 C5-B 的责任。保证 Undo 仍可 resolve、Export 仍正常。
 *
 * 这是 C5-A 钉死的缺口的填充件：让 `ImportResult.assets` 真正进入运行时，
 * 使 Export（C5-C）与 Render（C5-D）都通过 `resolve(assetRef)` 取字节，
 * 而非各自重建第二套图像真相。
 */

import type { ImageAsset, ImageAssetRef } from "../core/document/types";

export class ImageAssetRegistry {
  private readonly assets = new Map<ImageAssetRef, ImageAsset>();

  /** 注册单个资产；相同 assetRef 覆盖（last-write-wins，与 Map 语义一致） */
  register(asset: ImageAsset): void {
    this.assets.set(asset.id, asset);
  }

  /** 批量注册（来源于 `ImportResult.assets`） */
  registerMany(assets: ReadonlyArray<ImageAsset>): void {
    for (const asset of assets) this.register(asset);
  }

  /** 解引用：返回原始资源，或 unknown assetRef 安全返回 null */
  resolve(ref: ImageAssetRef): ImageAsset | null {
    return this.assets.get(ref) ?? null;
  }

  has(ref: ImageAssetRef): boolean {
    return this.assets.has(ref);
  }

  /** 显式移除（C5-B 不强制在生产删除流程调用；保留供日后 GC 使用） */
  remove(ref: ImageAssetRef): void {
    this.assets.delete(ref);
  }

  clear(): void {
    this.assets.clear();
  }

  get size(): number {
    return this.assets.size;
  }
}

/**
 * 运行时默认 registry 单例（Binding-side）。
 *
 * 生产导入边界（`initializeCoreDocument`）把 `ImportResult.assets` 注册到这里；
 * C5-C 导出解析器、C5-D 渲染器都通过本单例 `resolve(assetRef)` 取字节。
 *
 * 测试请 `new ImageAssetRegistry()` 自隔离，勿依赖本单例，避免跨用例污染。
 */
export const imageAssetRegistry = new ImageAssetRegistry();
