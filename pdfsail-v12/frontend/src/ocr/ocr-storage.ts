/**
 * ocr-storage.ts — OCR 任务与结果的 IndexedDB 持久化
 *
 * 数据库：pdfaide_ocr（独立于 pdfaide_v12，避免影响现有 DB_VERSION）
 *   - tasks：OCR 任务（id / fileName / blob / status / pages / createdAt）
 *   - results：OCR 结果（taskId → 文本块数组）
 *
 * 任务状态机：
 *   UPLOADED → ANALYZING → OCR_PROCESSING → COMPLETED / FAILED
 */

const DB_NAME = "pdfaide_ocr";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("tasks")) {
        db.createObjectStore("tasks", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("results")) {
        db.createObjectStore("results", { keyPath: "taskId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export type OcrTaskStatus =
  | "UPLOADED"
  | "ANALYZING"
  | "OCR_PROCESSING"
  | "COMPLETED"
  | "FAILED";

export interface OcrTextBlock {
  id: string;
  page: number;
  x: number; // CSS px (relative to canvas.clientWidth)
  y: number;
  w: number;
  h: number;
  text: string;
  fontSize: number;
  /** GLM-OCR 返回的区域 label（如 "text", "title", "table", "figure" 等），用于区域分类 */
  label?: string;
  /**
   * 几何变换信息（Sprint 5）。
   * 仅 signature / stamp / handwriting 等 preserve 区域有值。
   * 包含旋转角度和对应的 CSS 归一化 transform matrix。
   */
  geometry?: OcrBlockGeometry;
}

/**
 * OCR block 的几何变换信息。
 *
 * angle：旋转角度（度，顺时针为正）
 * transform：CSS 归一化 transform matrix [cosθ, sinθ, -sinθ, cosθ, 0, 0]
 *            缩放归一化为 1，平移归零（位置由 bbox 控制）
 */
export interface OcrBlockGeometry {
  /** 旋转角度（度，0 = 无旋转） */
  angle: number;
  /** CSS 归一化 transform matrix [a, b, c, d, e, f] */
  transform: [number, number, number, number, number, number];
}

export interface OcrTask {
  id: string;
  fileName: string;
  blob: Blob;            // 原始 PDF（用于编辑器加载）
  status: OcrTaskStatus;
  pages: number;         // 总页数
  isScanned: boolean;    // 是否为扫描件
  errorMessage?: string;
  blockCount?: number;   // 完成时填入
  createdAt: number;
}

export interface OcrUsage {
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface OcrResult {
  taskId: string;
  blocks: OcrTextBlock[];
  usage?: OcrUsage;
}

// ── Task CRUD ──

export async function saveOcrTask(task: OcrTask): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("tasks", "readwrite");
    tx.objectStore("tasks").put(task);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getOcrTask(id: string): Promise<OcrTask | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("tasks", "readonly");
    const req = tx.objectStore("tasks").get(id);
    req.onsuccess = () => resolve((req.result as OcrTask) || null);
    req.onerror = () => reject(req.error);
  });
}

export async function updateOcrTask(
  id: string,
  patch: Partial<OcrTask>
): Promise<void> {
  const existing = await getOcrTask(id);
  if (!existing) return;
  await saveOcrTask({ ...existing, ...patch });
}

// ── Result CRUD ──

export async function saveOcrResult(result: OcrResult): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("results", "readwrite");
    tx.objectStore("results").put(result);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getOcrResult(taskId: string): Promise<OcrResult | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("results", "readonly");
    const req = tx.objectStore("results").get(taskId);
    req.onsuccess = () => resolve((req.result as OcrResult) || null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearOcrTask(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["tasks", "results"], "readwrite");
    tx.objectStore("tasks").delete(id);
    tx.objectStore("results").delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
