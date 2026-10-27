/**
 * B3-C-5-E-B-B — Add Image → Core：把图片对象提交进 Core EditorDocument 的**唯一**入口。
 *
 * 责任边界（与 AddBlockCommand 契约一致）：
 *   · 本模块**只**构造 `AddBlockCommand({type:"image", ...})` 并 `session.history.commit`。
 *   · 不碰 registry / bytes / FileReader / DOM / React；资产注册与几何计算由调用方（producer）完成。
 *   · 不持有任何 state；纯函数式入口便于单测与两个 producer（MainToolbar 文件按钮 / PDFCanvas 点击）复用。
 */

import type { CoreInputSession } from "./core-input-source";
import { AddBlockCommand } from "../core/commands";
import type { ImageAssetRef } from "../core/document/types";

export interface CommitImageToCoreInput {
  /** 指向 Binding 层 ImageAsset 的引用（非空） */
  assetRef: ImageAssetRef;
  /** 1-based 页码（= EditorPage.index） */
  pageIndex: number;
  /** Page Canvas Space（px） */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 把一张用户新增图片提交进 Core 文档。
 * 调用方须先确保：
 *   ① asset 已注册进 `imageAssetRegistry`（本函数不读 registry）
 *   ② 几何已由 `computeImageBlockGeometry` 计算（本函数不计算）
 *   ③ session 存在（缺失则先 `createCoreInputSessionFromDocument`）
 *
 * 失败（非法几何 / 缺 assetRef / 缺 page）由 AddBlockCommand 抛 CommandError，
 * 本函数不吞异常 —— producer 决定是否 fail-closed。
 */
export function commitImageToCore(session: CoreInputSession, input: CommitImageToCoreInput): void {
  session.history.commit(
    new AddBlockCommand({
      type: "image",
      pageIndex: input.pageIndex,
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      assetRef: input.assetRef,
    })
  );
}
