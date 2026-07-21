import React from "react";
import type { PDFTextNode } from "./types";

export function TextEditor({
  nodes,
  onChange,
  scale = 1.5,
}: {
  nodes: PDFTextNode[];
  onChange: (id: string, text: string) => void;
  scale?: number;
}) {
  return (
    <div style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}>
      {nodes.map((n) => (
        <div
          key={n.id}
          contentEditable
          suppressContentEditableWarning
          onBlur={(e) => onChange(n.id, e.currentTarget.innerText)}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            left: n.x,
            top: n.y,
            width: "auto",
            minWidth: n.width,
            height: n.height,
            fontSize: n.fontSize,
            lineHeight: 1.2,
            fontFamily: "sans-serif",
            color: "transparent",
            background: "transparent",
            outline: "none",
            border: "none",
            whiteSpace: "nowrap",
            overflow: "visible",
            cursor: "text",
            pointerEvents: "auto",
          }}
        >
          {n.text}
        </div>
      ))}
    </div>
  );
}
