/**
 * Geometry Events — Sprint38 · S38-1（GeometryCompleted Event）
 *
 * 【Must Fix 3】Runtime 不 import EvidenceStore，而是发布 GeometryCompleted Event，
 * 由 Evidence Layer 消费。
 *
 * 【CR-1】Event 是 DTO（Data Transfer Object），不是 Runtime Object：
 *   - 不传 Runtime Block / GeometryBlock（Evidence Layer 不认识 Runtime 内部结构）。
 *   - 传 geometryAngle / decisionTrace / elapsedMs / metadata。
 *
 * 【CR-4】EventBus 区分 publish() / dispatch()：
 *   - Runtime 只 publish()。
 *   - 真正 dispatch() 由 Infrastructure 决定（未来可异步）。
 *   当前实现仍同步，但接口为异步预留空间。
 */

import type { GeometryDecisionTrace } from "./geometry-decision-trace";

/**
 * GeometryCompleted Event — Geometry 执行完成的通知（DTO）。
 *
 * 只携带 Geometry 的事实，不含 Runtime Domain Object。
 */
export interface GeometryCompletedEvent {
  /** 事件类型 */
  type: "geometry-completed";
  /** 文档 id */
  documentId: string;
  /** 页码 */
  page: number;
  /** 最终旋转角（度） */
  geometryAngle: number;
  /** 完整决策 Trace */
  decisionTrace: GeometryDecisionTrace;
  /** 执行耗时（ms，可选） */
  elapsedMs?: number;
  /** 附加元数据（可选） */
  metadata?: Record<string, unknown>;
  /** 发生时间 */
  timestamp: string;
}

/** 事件监听器 */
export type GeometryEventListener = (event: GeometryCompletedEvent) => void;

/**
 * Geometry Event Bus — 发布 / 订阅。
 *
 * Runtime 只 publish()，Evidence Layer 只 subscribe。
 * dispatch() 由 Infrastructure 决定（当前同步，未来可异步）。
 */
export interface GeometryEventBus {
  /** 发布（Runtime 调用，不阻塞语义由 Infrastructure 决定） */
  publish(event: GeometryCompletedEvent): void;
  /** 实际分发（Infrastructure 决定何时调用；当前 publish 内同步 dispatch） */
  dispatch(event: GeometryCompletedEvent): void;
  /** 订阅 GeometryCompleted */
  onCompleted(listener: GeometryEventListener): () => void;
}

/**
 * 默认 Geometry Event Bus 实现（当前 publish 内同步 dispatch）。
 */
export class DefaultGeometryEventBus implements GeometryEventBus {
  private readonly listeners = new Set<GeometryEventListener>();

  publish(event: GeometryCompletedEvent): void {
    // 当前实现同步 dispatch；未来可改为异步（Infrastructure 决定）
    this.dispatch(event);
  }

  dispatch(event: GeometryCompletedEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  onCompleted(listener: GeometryEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
