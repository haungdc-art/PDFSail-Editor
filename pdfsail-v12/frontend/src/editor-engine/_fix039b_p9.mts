/**
 * M7.8-039B P9 — 几何精确的 Editor overlay 证明图。
 *
 * 说明：真实问题 PDF 不在工作区内（已全工作区扫描 page1 无 "268282-1-1" 命中，系用户上传文件）。
 * 无法直接 React 编辑态实拍，故用已知真实几何（_diag_m78039b_out.txt）生成 overlay 证明图：
 *  - 5 个列 Segment 按其计算 cssX 绝对定位绘制文本；
 *  - 叠加虚线参考线于用户给定的原始 X anchor（cssX = pdfX*1.5）；
 *  - 若文本左缘与参考线对齐，即证明列间距已还原（Plan A 生效）。
 */
import { buildSegments } from "./SegmentBuilder";
import { CoordinateMapperImpl } from "./CoordinateMapper";
import { FontAnalyzerImpl } from "./FontAnalyzer";
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync } from "node:fs";

const FONT_SIZE = 9.9;
const PDFY = 329.847;
const COLOR = [0, 0, 0];
const RAW: Array<[number, number, string]> = [
  [24.00, 33.62, "268282-1-1"],
  [57.62, 108.80, " "],
  [166.42, 25.62, "1.057,50"],
  [192.04, 25.06, " "],
  [217.10, 33.87, "27/04/2026"],
  [250.97, 145.03, " "],
  [276.00, 111.60, "MARLUPI VESTUARIO INFANTIL LTDA"],
  [396.00, 112.70, "COMERCIAL TEXTIL SUL BRASIL LTDA"],
];
const glyphs = RAW.map(([x, w, s]) => ({
  str: s, transform: [1, 0, 0, 1, x, PDFY] as [number, number, number, number, number, number],
  fontName: "g_d0_f2", fontSize: FONT_SIZE, width: w, height: FONT_SIZE, color: COLOR, hz: 1, pdfX: x, pdfY: PDFY,
}));
const row: any = { text: glyphs.map((g) => g.str).join(""), pdfX: 24, pdfY: PDFY, width: 396 + 112.7 - 24, height: FONT_SIZE, fontName: "g_d0_f2", fontSize: FONT_SIZE, color: COLOR, hz: 1, glyphs };
const mapper = new CoordinateMapperImpl({ viewportScale: 1.5, viewportHeight: 792, viewportWidth: 612, cssScale: 1, originXDevice: 0, originYDevice: 792 * 1.5 });
const segs = buildSegments([row], mapper as any, new FontAnalyzerImpl() as any, 1);

const W = 612 * 1.5, H = 792 * 1.5;
const cv = createCanvas(W, H);
const ctx = cv.getContext("2d");
(ctx as any).fillStyle = "#ffffff"; (ctx as any).fillRect(0, 0, W, H);
// 页面顶/底参考
(ctx as any).strokeStyle = "#cccccc"; (ctx as any).strokeRect(0, 0, W, H);

const baselineY = mapper.pdfYToCssY(PDFY);
// 原始 X anchor 参考线（虚线）
const anchors = [24, 166.42, 217.10, 276, 396].map((x) => x * 1.5);
(ctx as any).setLineDash([6, 4]);
(ctx as any).strokeStyle = "#d9534f";
for (const ax of anchors) { (ctx as any).beginPath(); (ctx as any).moveTo(ax, baselineY - 40); (ctx as any).lineTo(ax, baselineY + 10); (ctx as any).stroke(); }
(ctx as any).setLineDash([]);

// 绘制每列 Segment（绝对定位，左缘 = cssX）
(ctx as any).fillStyle = "#000000";
(ctx as any).textBaseline = "alphabetic";
const fontPx = FONT_SIZE * 1.5;
(ctx as any).font = `${fontPx}px sans-serif`;
for (const s of segs) {
  (ctx as any).fillText(s.text, s.cssX, baselineY);
}
// 标注每列左缘
(ctx as any).fillStyle = "#1a73e8";
(ctx as any).font = `${10}px monospace`;
segs.forEach((s, i) => (ctx as any).fillText(`col${i + 1} L=${s.cssX.toFixed(1)}`, s.cssX, baselineY + 22));

fs_write(cv, "d:/TRAE/pdfsail-v12/_fix039b_p9_overlay.png");
function fs_write(c: any, p: string) {
  writeFileSync(p, c.toBuffer("image/png"));
  console.log("WROTE", p, "segs=", segs.length, "anchors=", JSON.stringify(anchors));
}
