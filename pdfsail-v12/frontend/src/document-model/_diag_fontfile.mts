import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef, PDFStream } from "pdf-lib";
import { inflateSync } from "node:zlib";

const path = "C:/Users/admin/Downloads/edited-edit-pdf_uploads_1784668534110-k2v2grpo8.pdf (13).pdf";
const bytes = readFileSync(path);
const pdf = await PDFDocument.load(bytes);
const ctx: any = (pdf as any).context;
const page = pdf.getPages()[0];
const node: any = (page as any).node;
const fontRes = node.Resources().lookup(PDFName.of("Font"), PDFDict);

// 对比 page 级 /F3+0 与 table 流里解析到的 /F3+0 是否同一对象
const f3ref = fontRes.lookup(PDFName.of("F3+0")) as PDFRef;
const f3obj = ctx.lookup(f3ref) as PDFDict;
const fd = f3obj.lookup(PDFName.of("FontDescriptor")) as PDFDict;
const ff2 = fd.lookup(PDFName.of("FontFile2")) as any;
console.log("page级 /F3+0 ref:", "#" + f3ref.objectNumber, "FontFile2 ref:", ff2 instanceof PDFRef ? "#" + ff2.objectNumber : typeof ff2);

// 取 FontFile2 流内容
const ff2stream = ctx.lookup(ff2) as any;
const raw = ff2stream.getContents ? ff2stream.getContents() : null;
let fontbuf = raw;
if (raw && raw[0] === 0x78) { try { fontbuf = inflateSync(raw); } catch (e) { console.log("FontFile2 解压失败:", e); } }
const head = fontbuf.slice(0, 4);
const tag = head.toString("latin1");
const isTTF = tag === "true" || tag === "OTTO" || (head[0] === 0x00 && head[1] === 0x01);
console.log("FontFile2 大小(compressed):", raw?.length, "解压后:", fontbuf.length, "TTF头:", JSON.stringify(tag), "isTTF:", isTTF);
console.log("FontFile2 流 dict:", JSON.stringify([...ff2stream.dict.keys()].map((k: PDFName) => k.asString() + "=" + (() => { const v = ff2stream.dict.lookup(k); return v instanceof PDFRef ? "#" + v.objectNumber : v?.toString?.().slice(0, 30); })())));

// 也看原文件（若本地有）对比
