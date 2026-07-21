// ──────────────────────────────────────────────
// V13 Database Layer — Simple in-memory + JSON persistence
// ──────────────────────────────────────────────

import fs from "fs";
import path from "path";

export interface Collection<T> {
  find(filter?: Partial<T>): T[];
  findById(id: string): T | undefined;
  insert(doc: T): T;
  update(id: string, patch: Partial<T>): boolean;
  delete(id: string): boolean;
  count(): number;
  clear(): void;
}

export class MemoryDB {
  private data = new Map<string, any[]>();
  private persistencePath: string | null = null;

  constructor(persistencePath?: string) {
    if (persistencePath) {
      this.persistencePath = path.resolve(persistencePath);
      this.load();
    }
  }

  collection<T extends { id: string }>(name: string): Collection<T> {
    if (!this.data.has(name)) {
      this.data.set(name, []);
    }

    const store = this.data.get(name)!;

    const save = () => {
      if (this.persistencePath) {
        this.persist();
      }
    };

    return {
      find: (filter?: Partial<T>): T[] => {
        if (!filter || Object.keys(filter).length === 0) return [...store];
        return store.filter((doc: T) =>
          Object.entries(filter as Record<string, unknown>).every(
            ([key, value]) => (doc as any)[key] === value
          )
        );
      },
      findById: (id: string): T | undefined => {
        return store.find((doc: T) => doc.id === id) as T | undefined;
      },
      insert: (doc: T): T => {
        store.push(doc);
        save();
        return doc;
      },
      update: (id: string, patch: Partial<T>): boolean => {
        const idx = store.findIndex((doc: T) => doc.id === id);
        if (idx === -1) return false;
        Object.assign(store[idx], patch);
        save();
        return true;
      },
      delete: (id: string): boolean => {
        const idx = store.findIndex((doc: T) => doc.id === id);
        if (idx === -1) return false;
        store.splice(idx, 1);
        save();
        return true;
      },
      count: (): number => store.length,
      clear: (): void => {
        store.length = 0;
        save();
      },
    };
  }

  private persist() {
    if (!this.persistencePath) return;
    try {
      const dir = path.dirname(this.persistencePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj: Record<string, any[]> = {};
      for (const [key, val] of this.data) {
        obj[key] = val;
      }
      fs.writeFileSync(this.persistencePath, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.error("DB persistence error:", err);
    }
  }

  private load() {
    if (!this.persistencePath) return;
    try {
      if (fs.existsSync(this.persistencePath)) {
        const raw = fs.readFileSync(this.persistencePath, "utf-8");
        const obj = JSON.parse(raw);
        for (const [key, val] of Object.entries(obj)) {
          this.data.set(key, val as any[]);
        }
      }
    } catch (err) {
      console.error("DB load error:", err);
    }
  }

  dropCollection(name: string) {
    this.data.delete(name);
  }
}

// Singleton
export const db = new MemoryDB(
  process.env.DB_PATH || "./data/db.json"
);
