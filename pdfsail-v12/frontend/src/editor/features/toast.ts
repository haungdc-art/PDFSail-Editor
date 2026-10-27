/**
 * toast.ts — C-6-B minimal self-contained toast.
 *
 * 不依赖任何 React 组件 / 第三方 UI 库；直接挂载到 document.body 的一个
 * 固定定位容器，自动消失。用于「数据丢失型状态转换」的硬阻断提示。
 *
 * 选择 DOM 直挂而非 React Portal：避免为单一阻断提示引入新的渲染链路，
 * 也避免改动 PDFEditor 的 JSX 结构（保持最小实现面）。
 */

let container: HTMLDivElement | null = null;

function ensureContainer(): HTMLDivElement {
  if (container && document.body.contains(container)) return container;
  container = document.createElement("div");
  container.setAttribute("data-toast-container", "true");
  container.style.position = "fixed";
  container.style.left = "50%";
  container.style.bottom = "32px";
  container.style.transform = "translateX(-50%)";
  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.gap = "8px";
  container.style.zIndex = "99999";
  container.style.pointerEvents = "none";
  document.body.appendChild(container);
  return container;
}

export function showToast(message: string, durationMs = 4000): void {
  if (typeof document === "undefined" || !document.body) return;
  const root = ensureContainer();
  const el = document.createElement("div");
  el.setAttribute("data-toast", "true");
  el.textContent = message;
  el.style.background = "rgba(15, 23, 42, 0.92)";
  el.style.color = "#fff";
  el.style.padding = "10px 16px";
  el.style.borderRadius = "8px";
  el.style.fontSize = "13px";
  el.style.lineHeight = "1.4";
  el.style.boxShadow = "0 4px 16px rgba(0,0,0,0.25)";
  el.style.maxWidth = "min(420px, 80vw)";
  el.style.opacity = "0";
  el.style.transition = "opacity 160ms ease";
  root.appendChild(el);
  // 触发进入动画
  requestAnimationFrame(() => {
    el.style.opacity = "1";
  });
  const remove = () => {
    el.style.opacity = "0";
    window.setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 180);
  };
  window.setTimeout(remove, durationMs);
}
