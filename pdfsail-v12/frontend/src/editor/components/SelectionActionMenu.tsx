/**
 * SelectionActionMenu — 拖选后的浮层快捷菜单（M7.7-003 Inline Activation Repair）
 *
 * 产品语义（Adobe 模式）：
 *   - 拖选文字 ≠ 打开 Workspace；拖选 = Inline Selection 状态 + 浮层 Action Menu。
 *   - Edit Text → 直接进入 inline EditSession（永远 inline）。
 *   - Copy     → 复制选中文本。
 *   - Ask AI   → 打开右侧 DocumentWorkspace（AI Document Workspace，产品差异化入口）。
 *
 * 位置：selection bounding box 的 top/right（世界 CSS 坐标，与 wrapper 同空间）。
 * 约束：纯交互层；不改渲染/字体/编辑核心（Native Canvas Invariant）。
 */
import React, { useLayoutEffect, useRef, useState } from "react";

interface SelectionActionMenuProps {
  /** 是否显示（拖选结束时置位，点击/编辑/清选区时清除） */
  visible: boolean;
  /** 锚点 x（selection 右缘，世界 CSS 坐标） */
  x: number;
  /** 锚点 y（selection 上缘，世界 CSS 坐标） */
  y: number;
  /** 选中文本（Copy / Ask AI 使用） */
  text: string;
  onEditText: () => void;
  onCopy: () => void;
  onAskAI: () => void;
  /** 点击菜单外关闭 */
  onDismiss: () => void;
}

export function SelectionActionMenu({
  visible,
  x,
  y,
  text,
  onEditText,
  onCopy,
  onAskAI,
  onDismiss,
}: SelectionActionMenuProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // M7.7-003B fix: 菜单定位使用 translate(-100%,-110%) 即渲染在选区上方。
  // 当选中文本靠近页面顶部时，菜单会向上溢出容器（data-layer="background"，
  // 该层 top:0 即 wrapper 顶），与上方编辑器工具栏重叠——工具栏在独立且更高的
  // 层叠上下文里，会遮住顶部 Edit Text 按钮，导致"点了没反应"。这里用父容器
  // 尺寸做 clamp，把菜单最终 rect 约束在容器内（不溢出工具栏），由 px 位移表达。
  const [transform, setTransform] = useState<string>("translate(-100%, -110%)");
  useLayoutEffect(() => {
    if (!visible) return;
    const el = panelRef.current;
    if (!el) return;
    const parent = el.parentElement;
    const pw = parent ? parent.clientWidth : window.innerWidth;
    const ph = parent ? parent.clientHeight : window.innerHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // 自然位置（未 clamp）：左上角 = (x - w, y - 1.1h)
    const nLeft = x - w;
    const nTop = y - 1.1 * h;
    // clamp 到容器内（>=0 且不超出右/下边缘）
    const cLeft = Math.max(0, Math.min(nLeft, pw - w));
    const cTop = Math.max(0, Math.min(nTop, ph - h));
    // 用相对 (x,y) 锚点的 px 位移表达 clamp 后的位置（未遮挡时等价于 translate(-100%,-110%)）
    setTransform(`translate(${Math.round(cLeft - x)}px, ${Math.round(cTop - y)}px)`);
  }, [visible, x, y]);

  if (!visible) return null;
  return (
    // 透明 backdrop：点击菜单外关闭（绝对铺满 wrapper，仅当菜单可见时拦截交互）
    // 注意：父层 data-layer="background" 的 pointer-events:none 会被继承，必须显式改回 auto，
    // 否则整个菜单（backdrop/panel/buttons）都不可命中，点击会被下方的 glyph 层拦截。
    <div
      data-selection-menu-backdrop="1"
      onClick={onDismiss}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 60,
        cursor: "default",
        pointerEvents: "auto",
      }}
    >
      <div
        ref={panelRef}
        data-selection-menu="1"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          left: x,
          top: y,
          transform,
          display: "flex",
          flexDirection: "column",
          minWidth: 148,
          background: "#fff",
          border: "1px solid #e2e8f0",
          borderRadius: 10,
          boxShadow: "0 8px 24px rgba(15,23,42,0.14)",
          padding: 4,
          zIndex: 61,
        }}
      >
        <MenuButton label="Edit Text" onClick={onEditText} primary />
        <MenuButton label="Copy" onClick={onCopy} />
        <MenuButton label="Ask AI" onClick={onAskAI} />
        {text && (
          <div
            style={{
              marginTop: 2,
              padding: "6px 10px",
              borderTop: "1px solid #f1f5f9",
              fontSize: 11,
              color: "#94a3b8",
              maxWidth: 220,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            “{text}”
          </div>
        )}
      </div>
    </div>
  );
}

function MenuButton({
  label,
  onClick,
  primary,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "8px 10px",
        border: "none",
        borderRadius: 6,
        background: primary ? "#7c5cfc" : "transparent",
        color: primary ? "#fff" : "#1e293b",
        fontSize: 13,
        fontWeight: primary ? 600 : 500,
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        if (!primary) (e.currentTarget as HTMLButtonElement).style.background = "#f1f5f9";
      }}
      onMouseLeave={(e) => {
        if (!primary) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      {label}
    </button>
  );
}
