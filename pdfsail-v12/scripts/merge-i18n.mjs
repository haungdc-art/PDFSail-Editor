// 一次性脚本：合并 translations（v12 editor keys + 当前项目站点 keys）
// 策略：重叠 key 以当前项目（PDFSail 品牌为准）的值为准；v12 独有 key 追加。
import { readFileSync, writeFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const CUR = "frontend/src/i18n/translations.cur.ts";
const V12 = "frontend/src/i18n/translations.v12.ts";
const OUT = "frontend/src/i18n/translations.ts";

function parseLangs(file) {
  const text = readFileSync(file, "utf8");
  const langs = {};
  for (const lang of ["en", "pt"]) {
    const start = text.indexOf(`  ${lang}: {`);
    if (start === -1) throw new Error(`lang ${lang} not found in ${file}`);
    // 找到该语言对象的结束位置：下一个 "\n  }," 或 "\n  }\n"
    const end = text.indexOf("\n  },", start);
    const section = text.slice(start, end);
    const map = {};
    const re = /"((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(section))) {
      map[m[1]] = m[2];
    }
    langs[lang] = map;
  }
  return langs;
}

const cur = parseLangs(CUR);
const v12 = parseLangs(V12);

// 合并：当前项目优先，v12 独有追加
const merged = {};
for (const lang of ["en", "pt"]) {
  const out = { ...cur[lang] };
  let added = 0;
  for (const [k, v] of Object.entries(v12[lang])) {
    if (!(k in out)) {
      out[k] = v;
      added++;
    }
  }
  merged[lang] = out;
  console.log(`${lang}: cur=${Object.keys(cur[lang]).length}, v12=${Object.keys(v12[lang]).length}, merged=${Object.keys(out).length} (+${added} from v12)`);
}

// 校验：源码中用到的 t("key") 都必须存在
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.includes("translations")) out.push(p);
  }
  return out;
}
const srcDir = "frontend/src";
const used = new Set();
const reUse = /\bt\(\s*["']([^"']+)["']\s*\)/g;
for (const f of walk(srcDir)) {
  const text = readFileSync(f, "utf8");
  let m;
  while ((m = reUse.exec(text))) used.add(m[1]);
}
const missing = [...used].filter((k) => !(k in merged.en));
console.log(`used keys: ${used.size}, missing in merged.en: ${missing.length}`);
for (const k of missing) console.log("  MISSING: " + k);
if (missing.length) process.exitCode = 1;

// 生成输出文件
function fmt(map, comment) {
  const lines = [`    // ${comment}`];
  for (const [k, v] of Object.entries(map)) {
    lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  }
  return lines.join("\n");
}
const header = `/**
 * translations.ts — PDFSail Editor（V12 editor 移植合并版）
 *
 * 英语 (en) + 巴西葡萄牙语 (pt-BR) 翻译字典。
 *
 * 合并策略（2026-09-06 移植）：
 *   - 基底：本项目原有站点翻译（PDFSail 品牌、landing/merge/split 等 SEO 页面）
 *   - 追加：D:\\TRAE\\pdfsail-v12 editor 所需的全部 key（Find & Replace、Document
 *     Workspace、字形编辑、OCR 流程、mode 标签等），重叠 key 以本项目为准
 */

export type Lang = "en" | "pt";

export const translations = {
  en: {
${fmt(merged.en, "基础站点 keys（本项目原有）+ v12 editor keys（合并）")}
  },
  pt: {
${fmt(merged.pt, "基础站点 keys（本项目原有）+ v12 editor keys（合并）")}
  },
} as const;

export type TranslationKey = keyof typeof translations.en;
`;
writeFileSync(OUT, header, "utf8");
console.log("written:", OUT);
