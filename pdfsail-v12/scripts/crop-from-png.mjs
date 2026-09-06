/**
 * crop-from-png — 从整页 PNG 中裁剪高倍局部（直接像素坐标，无坐标换算）。
 * 用法: node scripts/crop-from-png.mjs <inPng> <outPng> <x> <y> <w> <h>
 */
import * as fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const [, , inPng, outPng, x, y, w, h] = process.argv;
const img = await loadImage(inPng);
const canvas = createCanvas(Number(w), Number(h));
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#ffffff";
ctx.fillRect(0, 0, Number(w), Number(h));
// 先 2x 放大再取区域，便于观察字距
const sx = Number(x), sy = Number(y), sw = Number(w), sh = Number(h);
ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
fs.writeFileSync(outPng, canvas.toBuffer("image/png"));
console.log(`saved ${path.basename(outPng)}`);
