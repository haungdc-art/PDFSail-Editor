/**
 * uploadToR2AndRedirect — 共用 R2 上传 + 跳转 Ready 页
 *
 * 从 DownloadButton.tsx 提取，供 DownloadButton 和 useInlineTools 复用。
 * 流程：生成 token → POST raw body 到 R2 → 跳转 www.pdfsail.com/[locale]/ready
 *
 * 上传失败时 fallback 本地下载。
 */

const R2_STORE_URL = "https://www.pdfsail.com/api/r2-store";
const R2_FILE_HOST = "https://www.pdfsail.com/api/r2-file";
const READY_BASE = "https://www.pdfsail.com";

function generateFileKey(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 10);
  return `editor_${ts}_${rand}`;
}

function getLocale(): string {
  // 从 localStorage 读取语言（与 I18nProvider 一致）
  try {
    const stored = localStorage.getItem("pdfsail_lang");
    if (stored === "pt") return "pt";
  } catch {}
  return "en";
}

/** 从文件名提取扩展名（不含点号），如 "compressed.pdf" → "pdf" */
function getExt(fileName: string): string {
  const parts = fileName.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "pdf";
}

/**
 * 上传 blob 到 R2 并跳转 Ready 页。
 * 上传失败时 fallback 本地下载。
 *
 * @param blob 文件内容
 * @param fileName 文件名（含扩展名）
 * @param toolName 工具名称（如 "compress", "word"），用于 Ready 页 task 参数
 * @returns true 表示已跳转，false 表示 fallback 本地下载
 */
export async function uploadToR2AndRedirect(
  blob: Blob,
  fileName: string,
  toolName: string
): Promise<boolean> {
  const token = generateFileKey();
  const ext = getExt(fileName);
  const contentType = ext === "pdf" ? "application/pdf"
    : ext === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : ext === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
    : ext === "zip" ? "application/zip"
    : "application/octet-stream";

  // 上传到 R2
  let uploaded = false;
  try {
    const upResp = await fetch(
      `${R2_STORE_URL}?token=${encodeURIComponent(token)}&tool=editor&ext=${ext}`,
      {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: blob,
      }
    );
    if (upResp.ok) {
      uploaded = true;
    } else {
      console.warn("R2 upload failed:", upResp.status, await upResp.text().catch(() => ""));
    }
  } catch (e) {
    console.warn("R2 upload error:", e);
  }

  if (!uploaded) {
    // fallback：本地下载
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Local download fallback failed:", e);
    }
    return false;
  }

  // 跳转到 Ready 页
  const locale = getLocale();
  // Ready 页面会把 key/r2 当作纯 token 拼接成 `editor/results/${key}.${ext}`
  // 所以传纯 token，name 也不带扩展名（Ready 页面会拼接）
  const stripExt = (s: string) => {
    const dot = s.lastIndexOf(".");
    return dot > 0 ? s.slice(0, dot) : s;
  };
  const params = new URLSearchParams({
    key: token,
    r2: token,
    tool: "editor",
    task: toolName,
    name: stripExt(fileName),
    size: String(blob.size),
    r2host: R2_FILE_HOST,
  });
  const readyUrl = `${READY_BASE}/${locale}/ready?${params.toString()}`;
  window.location.href = readyUrl;
  return true;
}
