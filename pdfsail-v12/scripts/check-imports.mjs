// 检查 frontend/src 下所有相对导入是否可解析（移植完整性检查）
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(process.cwd(), "frontend/src");
const exts = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".css", ".json"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|js|jsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

function resolveRel(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  if (existsSync(base) && statSync(base).isFile()) return true;
  for (const e of exts) if (existsSync(base + e)) return true;
  if (existsSync(path.join(base, "index.ts"))) return true;
  if (existsSync(path.join(base, "index.tsx"))) return true;
  return false;
}

const files = walk(SRC);
const missing = [];
const re = /(?:import|export)[^"'`]*?from\s+["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)|import\s+["'](\.[^"']+)["']/g;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    const spec = m[1] || m[2] || m[3];
    if (!spec) continue;
    if (!resolveRel(f, spec)) {
      missing.push(`${path.relative(SRC, f)}  →  ${spec}`);
    }
  }
}
if (missing.length === 0) {
  console.log("OK: all relative imports resolve.");
} else {
  console.log(`MISSING (${missing.length}):`);
  for (const s of [...new Set(missing)]) console.log("  " + s);
  process.exitCode = 1;
}
