/**
 * IndexedDB 工具 — V12
 *
 * 用于持久化：
 *   - 用户身份（userId / gmail）
 *   - 待支付的 PDF blob（editor → paywall 传递）
 *   - 修改摘要（供 paywall 页面展示）
 *
 * 数据库结构：pdfaide_v12
 *   - user：{ userId, gmail, createdAt }
 *   - pendingPdf：{ id, blob, fileName, summary, thumbnail, createdAt }（paywall 完成后清除）
 *   - settings：键值对
 */

const DB_NAME = "pdfaide_v12";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("user")) {
        db.createObjectStore("user", { keyPath: "userId" });
      }
      if (!db.objectStoreNames.contains("pendingPdf")) {
        db.createObjectStore("pendingPdf", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── User ──

export interface UserRecord {
  userId: string;
  gmail?: string;
  createdAt: number;
}

export async function getOrCreateUser(): Promise<UserRecord> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("user", "readonly");
    const req = tx.objectStore("user").getAll();
    req.onsuccess = () => {
      const list = req.result as UserRecord[];
      if (list.length > 0) {
        resolve(list[0]);
      } else {
        const newUser: UserRecord = {
          userId: crypto.randomUUID(),
          createdAt: Date.now(),
        };
        const wTx = db.transaction("user", "readwrite");
        wTx.objectStore("user").add(newUser);
        wTx.oncomplete = () => resolve(newUser);
        wTx.onerror = () => reject(wTx.error);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function bindGmail(gmail: string): Promise<void> {
  const user = await getOrCreateUser();
  const updated: UserRecord = { ...user, gmail };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("user", "readwrite");
    tx.objectStore("user").put(updated);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Pending PDF (Editor → Paywall 传递) ──

export interface PendingPdfRecord {
  id: string;                // 默认 "current"，editor 与 paywall 之间约定的固定 key
  blob: Blob;
  fileName: string;
  summary?: string;          // 修改内容总结（由 LLM summarize-changes 生成）
  thumbnail?: string;        // base64 data URL
  blockCount?: number;       // 修改数量
  originalSize?: number;     // 原始文件大小（字节）
  compressedSize?: number;   // 压缩后文件大小（字节）
  createdAt: number;
}

export async function savePendingPdf(rec: Omit<PendingPdfRecord, "id" | "createdAt">): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pendingPdf", "readwrite");
    tx.objectStore("pendingPdf").put({
      ...rec,
      id: "current",
      createdAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPendingPdf(): Promise<PendingPdfRecord | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pendingPdf", "readonly");
    const req = tx.objectStore("pendingPdf").get("current");
    req.onsuccess = () => resolve((req.result as PendingPdfRecord) || null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearPendingPdf(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pendingPdf", "readwrite");
    tx.objectStore("pendingPdf").delete("current");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Settings ──

export async function getSetting(key: string): Promise<any | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readonly");
    const req = tx.objectStore("settings").get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function setSetting(key: string, value: any): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readwrite");
    tx.objectStore("settings").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
