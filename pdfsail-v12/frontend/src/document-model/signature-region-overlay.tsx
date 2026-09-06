/**
 * SignatureRegionOverlay — Sprint 33.5.6
 *
 * 签名区域专用渲染组件。
 *
 * 与 GlyphRenderer 完全解耦：
 *   - 签名区域不走普通 TextRenderer 路径
 *   - 使用 local coordinate（offsetX/offsetY）+ parent rotate 模式
 *   - rotation 只存在于容器层，子元素不携带旋转
 */

import type { SignatureRegion, SignatureChild } from "./types";
import type { EditableStyle } from "./types";

interface SignatureRegionOverlayProps {
  regions: SignatureRegion[];
  docStyles: EditableStyle[];
  scale: number;
}

/**
 * 根据 styleRef 解析字体样式。
 */
function resolveStyle(
  styleRef: string | undefined,
  docStyles: EditableStyle[],
  _fallbackFont: string,
  fallbackSize: number,
): { fontFamily: string; fontSize: number; color: string } {
  if (styleRef && docStyles) {
    const style = docStyles.find((s) => s.id === styleRef);
    if (style) {
      return {
        fontFamily: style.fontFamily || "sans-serif",
        fontSize: style.fontSize || fallbackSize,
        color: style.color || "#000000",
      };
    }
  }
  return { fontFamily: "sans-serif", fontSize: fallbackSize, color: "#000000" };
}

export function SignatureRegionOverlay({
  regions,
  docStyles,
  scale,
}: SignatureRegionOverlayProps): JSX.Element | null {
  if (!regions || regions.length === 0) return null;

  const elements: JSX.Element[] = [];

  for (const region of regions) {
    const { bbox, rotation, children } = region;

    // Container positioned at parent bbox left-top
    const containerStyle: React.CSSProperties = {
      position: "absolute",
      left: `${bbox.x}px`,
      top: `${bbox.y}px`,
      width: `${bbox.width}px`,
      height: `${bbox.height}px`,
      transform: `rotate(${rotation}deg)`,
      transformOrigin: "left top",
      pointerEvents: "none",
      zIndex: 4, // Above normal glyphs (z=2/3) but under edit overlay
    };

    const childElements = children.map((child, childIdx) => {
      const { fontFamily, fontSize, color } = resolveStyle(
        undefined,
        docStyles,
        child.font.family,
        child.font.size,
      );

      const textSpanStyle: React.CSSProperties = {
        position: "absolute",
        left: `${child.offsetX}px`,
        top: `${child.offsetY}px`,
        fontFamily,
        fontSize: `${fontSize}px`,
        color,
        lineHeight: 1.2,
        whiteSpace: "nowrap",
        pointerEvents: "none",
        // Prevent sub-pixel text shifting
        transform: "translateZ(0)",
        backfaceVisibility: "hidden",
      };

      return (
        <span
          key={`sigchild_${region.id}_${childIdx}`}
          data-sig-region={region.id}
          data-sig-child-idx={childIdx}
          style={textSpanStyle}
        >
          {child.text}
        </span>
      );
    });

    elements.push(
      <div
        key={`sigregion_${region.id}`}
        data-sig-region={region.id}
        data-sig-rotation={rotation.toFixed(2)}
        style={containerStyle}
      >
        {childElements}
      </div>,
    );
  }

  // Wrap in a scaling layer to match the page's CSS scale
  return (
    <div
      className="signature-region-overlay"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 4,
      }}
    >
      {elements}
    </div>
  );
}
