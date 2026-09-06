/**
 * SignatureSuppressionManager — 统一的签名块抑制状态管理器。
 *
 * Sprint 20.6: 解决多个渲染路径对 suppressed block IDs 访问不一致的问题。
 *
 * 背景:
 *   - GlyphRenderer 通过 renderPageToCommands(suppressedGlyphBlockIds) 正确过滤
 *   - 但 renderToBlocks / renderDocument（Block 级 DOM 渲染）完全没有过滤
 *   - 导致 suppressed block 的 DOM <span> 仍然可见
 *
 * 使用方式:
 *   1. OCR 管线: setSuppressedBlockIds(pageNum, ids)
 *   2. 渲染层: getSuppressedBlockIds(pageNum) → Set<string>
 *   3. Debug: window.__signatureRenderDebug
 *
 * 这是一个模块级单例（非 React 组件），避免 props drilling。
 */
export interface SignatureRenderDebug {
  page: number;
  suppressedBlockIds: string[];
  domRenderedBlocks: string[];
  glyphRenderedBlocks: string[];
  unexpectedBlocks: string[];
}

class SignatureSuppressionManager {
  /** pageNum → Set<blockId> */
  private suppressedMap = new Map<number, Set<string>>();
  private debugMap = new Map<number, SignatureRenderDebug>();

  /** 注册某一页的被抑制 block ID */
  setSuppressedBlockIds(pageNum: number, ids: Set<string>): void {
    this.suppressedMap.set(pageNum, ids);
  }

  /** 获取某一页的被抑制 block ID */
  getSuppressedBlockIds(pageNum: number): Set<string> {
    return this.suppressedMap.get(pageNum) ?? new Set();
  }

  /** 获取所有页的被抑制 block ID（联合） */
  getAllSuppressedBlockIds(): Set<string> {
    const all = new Set<string>();
    for (const ids of this.suppressedMap.values()) {
      for (const id of ids) all.add(id);
    }
    return all;
  }

  /** 是否已为某一页注册 */
  hasPage(pageNum: number): boolean {
    return this.suppressedMap.has(pageNum);
  }

  /** 清除所有数据 */
  clear(): void {
    this.suppressedMap.clear();
    this.debugMap.clear();
  }

  /** 记录渲染 debug 信息 */
  setDebug(pageNum: number, debug: SignatureRenderDebug): void {
    this.debugMap.set(pageNum, debug);
  }

  /** 获取渲染 debug 信息 */
  getDebug(pageNum: number): SignatureRenderDebug | undefined {
    return this.debugMap.get(pageNum);
  }

  /** 获取所有 debug 信息 */
  getAllDebug(): SignatureRenderDebug[] {
    return [...this.debugMap.values()];
  }

  /** 生成综合 debug 输出 */
  buildGlobalDebug(): Record<string, unknown> {
    const pages = this.getAllDebug();
    return {
      totalSuppressedBlocks: this.getAllSuppressedBlockIds().size,
      pages,
    };
  }
}

/** 全局单例 */
export const signatureSuppression = new SignatureSuppressionManager();

/**
 * 初始化 window.__signatureRenderDebug。
 * 在 OCR 管线完成后调用，输出完整的渲染验证信息。
 */
export function publishSignatureRenderDebug(
  pageNum: number,
  debug: SignatureRenderDebug,
): void {
  signatureSuppression.setDebug(pageNum, debug);
  (window as any).__signatureRenderDebug = signatureSuppression.buildGlobalDebug();
}
