/**
 * M7.7-009A-1 · Render Source Detector Tests
 *
 * 验证：line/glyph 级 source 三路检测逻辑的正确性。
 *
 * 测试场景：
 *   1. 纯矢量文本（无图片区域）→ 所有行 source="vector"
 *   2. 图片区域内文本，无对应 text operator → source="image"
 *   3. 图片区域内文本，有对应 text operator → source="image-ocr"
 *   4. Audit 模式：输出 imageCoverage / textOperatorCoverage / hasOCRLayer
 *   5. 空 operator list → 保持缺省 "vector"
 */

import { describe, it, assert } from "vitest";
import {
  extractImageRegions,
  extractTextItemRects,
  detectLineRenderSource,
  auditLineRenderSource,
  auditPageRenderSources,
  calcMaxImageCoverage,
  calcMaxTextOperatorCoverage,
} from "./render-source-detector";
import type { OperatorListLike } from "./pdf-operator-binding";
import type { BBox } from "./types";

// ────────────────────────────────────────────────────────────────
// Mock CoordinateMapper（简化的 PDF pt → CSS px 转换）
// ────────────────────────────────────────────────────────────────

const MOCK_VP_HEIGHT = 1000;
const MOCK_MAPPER = {
  pdfToCss(pdfX: number, pdfY: number, pdfW: number, pdfH: number) {
    return {
      x: pdfX,
      y: MOCK_VP_HEIGHT - pdfY - pdfH,
      w: pdfW,
      h: pdfH,
    };
  },
  pdfYToCssY(pdfY: number) { return MOCK_VP_HEIGHT - pdfY; },
  cssToPdf(cssX: number, cssY: number, cssW: number, cssH: number) {
    return { x: cssX, y: MOCK_VP_HEIGHT - cssY - cssH, w: cssW, h: cssH };
  },
  cssYToPdfY(cssY: number) { return MOCK_VP_HEIGHT - cssY; },
  scaleFontSize(pt: number) { return pt; },
  updateCssScale(_s: number) {},
};

// ────────────────────────────────────────────────────────────────
// Mock OPS
// ────────────────────────────────────────────────────────────────

const MOCK_OPS = {
  q: 1, Q: 2, cm: 3,
  paintImageXObject: 10,
  paintInlineImageXObject: 11,
  paintImageMaskXObject: 12,
};

// ────────────────────────────────────────────────────────────────
// extractImageRegions
// ────────────────────────────────────────────────────────────────

describe("extractImageRegions", () => {
  it("空 operator list 返回空数组", () => {
    const ops: OperatorListLike = { fnArray: [], argsArray: [] };
    assert.equal(extractImageRegions(ops, MOCK_OPS, MOCK_MAPPER as any).length, 0);
  });

  it("paintImageXObject 返回图片区域", () => {
    const ops: OperatorListLike = {
      fnArray: [3, 10],
      argsArray: [
        [100, 0, 0, 200, 50, 300],
        ["img0", 1, 1],
      ],
    };
    const regions = extractImageRegions(ops, MOCK_OPS, MOCK_MAPPER as any);
    assert.equal(regions.length, 1);
    // CTM: [100,0,0,200,50,300] → CSS: x=50, y=1000-300-200=500, w=100, h=200
    assert.approximately(regions[0].bbox.x, 50, 0.01);
    assert.approximately(regions[0].bbox.y, 500, 0.01);
    assert.approximately(regions[0].bbox.width, 100, 0.01);
    assert.approximately(regions[0].bbox.height, 200, 0.01);
  });
});

// ────────────────────────────────────────────────────────────────
// detectLineRenderSource — 三路分类
// ────────────────────────────────────────────────────────────────

describe("detectLineRenderSource (3-way)", () => {
  const imageRegions = [
    { bbox: { x: 50, y: 400, width: 400, height: 300 } as BBox },
  ];
  const textItemRects = [
    { x: 60, y: 420, width: 80, height: 16 } as BBox,
    { x: 300, y: 500, width: 120, height: 16 } as BBox,
    { x: 10, y: 100, width: 50, height: 12 } as BBox,
  ];

  it("行在图片区域外 → vector", () => {
    assert.equal(detectLineRenderSource(
      { x: 10, y: 50, width: 200, height: 16 }, imageRegions, textItemRects
    ), "vector");
  });

  it("图片区域内 + 有 text operator → image-ocr", () => {
    assert.equal(detectLineRenderSource(
      { x: 60, y: 420, width: 80, height: 16 }, imageRegions, textItemRects
    ), "image-ocr");
  });

  it("图片区域内 + 无 text operator → image", () => {
    assert.equal(detectLineRenderSource(
      { x: 100, y: 600, width: 200, height: 16 }, imageRegions, textItemRects
    ), "image");
  });

  it("无图片区域 → vector", () => {
    assert.equal(detectLineRenderSource(
      { x: 60, y: 420, width: 80, height: 16 }, [], textItemRects
    ), "vector");
  });

  it("无 text items → 图片区域内行标记为 image", () => {
    assert.equal(detectLineRenderSource(
      { x: 100, y: 500, width: 200, height: 16 }, imageRegions, []
    ), "image");
  });

  it("无 text items + 图片区域外 → vector", () => {
    assert.equal(detectLineRenderSource(
      { x: 10, y: 50, width: 200, height: 16 }, imageRegions, []
    ), "vector");
  });
});

// ────────────────────────────────────────────────────────────────
// auditLineRenderSource — 详细指标输出
// ────────────────────────────────────────────────────────────────

describe("auditLineRenderSource", () => {
  const imageRegions = [
    { bbox: { x: 0, y: 0, width: 600, height: 800 } as BBox },
  ];

  it("纯图片覆盖无 text operator → image, imageCoverage=1.0, hasOCRLayer=false", () => {
    const audit = auditLineRenderSource(
      { x: 100, y: 200, width: 300, height: 20 },
      "Texto exemplo",
      imageRegions,
      [],
    );
    assert.equal(audit.source, "image");
    assert.equal(audit.imageCoverage, 1.0);
    assert.equal(audit.textOperatorCoverage, 0);
    assert.equal(audit.hasOCRLayer, false);
    assert.equal(audit.textPreview, "Texto exemplo");
  });

  it("图片覆盖 + text operator → image-ocr, hasOCRLayer=true", () => {
    const textRects = [
      { x: 50, y: 190, width: 400, height: 30 } as BBox,
    ];
    const audit = auditLineRenderSource(
      { x: 100, y: 200, width: 300, height: 20 },
      "Texto com OCR",
      imageRegions,
      textRects,
    );
    assert.equal(audit.source, "image-ocr");
    assert.equal(audit.imageCoverage, 1.0);
    assert.ok(audit.textOperatorCoverage > 0.3);
    assert.equal(audit.hasOCRLayer, true);
  });

  it("无图片覆盖 → vector", () => {
    const audit = auditLineRenderSource(
      { x: 100, y: 200, width: 300, height: 20 },
      "Texto vector",
      [],
      [],
    );
    assert.equal(audit.source, "vector");
    assert.equal(audit.imageCoverage, 0);
  });

  it("textPreview 长文本截断到 60 字符", () => {
    const longText = "A".repeat(100);
    const audit = auditLineRenderSource(
      { x: 0, y: 0, width: 100, height: 20 },
      longText,
      [],
      [],
    );
    assert.equal(audit.textPreview.length, 60);
    assert.ok(audit.textPreview.endsWith("..."));
  });
});

// ────────────────────────────────────────────────────────────────
// auditPageRenderSources — 全页审计
// ────────────────────────────────────────────────────────────────

describe("auditPageRenderSources", () => {
  it("返回全页所有行的审计报告", () => {
    const lines = [
      { bbox: { x: 100, y: 200, width: 200, height: 16 } as BBox, glyphs: [{ char: "A" }, { char: "B" }] },
      { bbox: { x: 100, y: 100, width: 200, height: 16 } as BBox, glyphs: [{ char: "C" }] },
    ];
    const imageRegions = [{ bbox: { x: 0, y: 0, width: 600, height: 800 } as BBox }];
    const textRects = [{ x: 100, y: 200, width: 200, height: 16 } as BBox];

    const audits = auditPageRenderSources(lines, imageRegions, textRects);
    assert.equal(audits.length, 2);
    // Line 1: in image + has text operator → image-ocr
    assert.equal(audits[0].source, "image-ocr");
    // Line 2: in image + no text operator → image
    assert.equal(audits[1].source, "image");
  });
});

// ────────────────────────────────────────────────────────────────
// 覆盖比例计算辅助函数
// ────────────────────────────────────────────────────────────────

describe("coverage ratio helpers", () => {
  it("calcMaxImageCoverage 返回最大覆盖比例", () => {
    const lineBBox: BBox = { x: 100, y: 100, width: 100, height: 50 };
    const regions = [
      { bbox: { x: 0, y: 0, width: 150, height: 120 } as BBox },
      { bbox: { x: 1000, y: 1000, width: 10, height: 10 } as BBox },
    ];
    // line 在第一个区域内有部分重叠（ratio≈0.2）
    const ratio = calcMaxImageCoverage(lineBBox, regions);
    assert.ok(ratio > 0);
    assert.ok(ratio <= 1.0);
  });

  it("calcMaxTextOperatorCoverage 不重叠返回 0", () => {
    const lineBBox: BBox = { x: 100, y: 100, width: 100, height: 50 };
    const rects = [{ x: 1000, y: 1000, width: 10, height: 10 } as BBox];
    assert.equal(calcMaxTextOperatorCoverage(lineBBox, rects), 0);
  });
});