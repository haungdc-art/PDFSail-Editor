/**
 * uploadToR2AndRedirect — 共用 R2 上传 + 跳转 Ready 页
 *
 * 从 DownloadButton.tsx 提取，供 DownloadButton 和 useInlineTools 复用。
 * 流程：生成 token → POST 明文 PDF 到 R2 → 跳转 www.pdfsail.com/[locale]/ready?r2=token
 * → /ready 页从 R2 取 PDF（校验 %PDF- 头）→ 生成缩略图 + Download 按钮 → /paywall
 *
 * 注意：主站 worker 的 /api/r2-store、/api/r2-file 均不做 XOR 编解码，
 * /ready 页 R2 路径按明文 %PDF- 头校验，因此必须上传明文（与其他工具 finishToWorkspace 一致）。
 * IndexedDB 落库时的 XOR 混淆由 /ready 页 saveToHistory 自行完成。
 *
 * 上传失败时不允许本地下载（必须走付费流程）。
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

  // 上传到 R2（明文上传 — 主站 /ready 页 R2 路径按 %PDF- 明文头校验，且 worker 无 XOR 解码）
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
    // 上传失败：不允许本地下载，必须走付费流程
    console.error("R2 upload failed — cannot proceed to /ready without upload");
    alert("Upload failed. Please check your network and try again.");
    return false;
  }

  // 跳转到 /ready 页：必须带 r2 参数（token）。
  // /ready 页用 tool 参数作为 R2 key 前缀，拼出 editor/results/{token}.{ext} 直接从 R2 取明文 PDF，
  // 校验 %PDF- 头后生成缩略图 + Download 按钮（点击进入 /paywall）。
  // 不传 r2 会回退 IndexedDB —— 编辑器与主站不同源，IndexedDB 为空，按钮永远不出现。
  // name 带扩展名：让 /ready 页正确判断文件类型
  const locale = getLocale();

  const params = new URLSearchParams({
    key: token,
    r2: token,
    tool: "editor",
    task: toolName,
    name: fileName,
    size: String(blob.size),
  });
  const readyUrl = `${READY_BASE}/${locale}/ready?${params.toString()}`;
  window.location.href = readyUrl;
  return true;
}
