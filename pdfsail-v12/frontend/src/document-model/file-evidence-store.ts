/**
 * FileEvidenceStore — Sprint39A · M1（Evidence Corpus 持久化）
 *
 * 建立真正可增长的 Evidence Corpus：EvidencePackage 以 JSON 文件持久化到磁盘，
 * 重启不丢失。
 *
 *   /evidence
 *       index.json
 *       evidence-000001.json
 *       evidence-000002.json
 *       ...
 *
 * 【Sprint39A-M1 交付标准】
 *   - append() / find() / list() / statistics() 全部工作。
 *   - 重新启动后 Corpus 不丢失。
 *   - 连续 append 100 个 Evidence，重启程序，count 仍为 100。
 *
 * 【Sprint39A-M1.5（Corpus 成为可用资产）】
 *   - validate()    ：Health Check（index 一致性 / 文件丢失 / 重复 id / nextSeq 连续 / JSON 损坏）。
 *   - rebuildIndex()：index.json 丢失/损坏时重新扫描重建。
 *   - exportTo() / importFrom()：JSON 快照导出 / 导入（zip 打包留未来扩展）。
 *
 * 【接口约束】
 *   - 不修改 Framework：EvidenceStore（内存）接口原样保留。
 *   - FileEvidenceStore 是独立持久化实现，方法异步（文件 I/O）。
 *   - EvidencePackage immutable，直接 JSON 序列化写入，不做任何转换。
 *
 * 【禁止】不修改 Framework / Runtime / Replay / Dashboard。
 */

import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { EvidencePackage } from "./evidence-package";

/** Corpus Index Schema 版本 */
export const CORPUS_INDEX_VERSION = 1;

/**
 * Corpus Index — 自动维护的索引（Dashboard 直接读它）。
 */
export interface CorpusIndex {
  /** Schema 版本 */
  schemaVersion: number;
  /** Evidence 总数 */
  count: number;
  /** 最新 Evidence id */
  latestId: string | null;
  /** 最近更新时间 */
  updatedAt: string;
  /** 标签分布（按 sample.pdfRef 分类） */
  tags: Record<string, number>;
  /** 序号游标（下一个 evidence 的序号） */
  nextSeq: number;
}

/** Corpus 统计（基于 FailureRecord.delta） */
export interface CorpusStoreStatistics {
  /** 总数 */
  total: number;
  /** 平均误差（度） */
  averageDelta: number;
  /** 最大误差（度） */
  maxDelta: number;
  /** 误差分布（按 delta 区间计数） */
  deltaBuckets: Record<string, number>;
}

/** 校验结果（Health Check，Replay 前先跑） */
export interface CorpusValidationResult {
  /** 是否健康（无任何 issue） */
  healthy: boolean;
  /** index.json 记录数 vs 实际文件数是否一致 */
  indexConsistent: boolean;
  /** 丢失的证据文件数（index 有、磁盘无） */
  missingFiles: string[];
  /** 重复 id 列表 */
  duplicateIds: string[];
  /** nextSeq 是否连续（= 最大序号 + 1） */
  nextSeqContinuous: boolean;
  /** 损坏的 JSON 文件列表 */
  corruptedFiles: string[];
  /** 实际证据总数 */
  actualCount: number;
}

/**
 * FileEvidenceStore 配置。
 */
export interface FileEvidenceStoreOptions {
  /** Corpus 目录（默认 ./evidence） */
  dir?: string;
}

/** 文件名序列号位数（如 evidence-000001） */
const SEQ_WIDTH = 6;

/**
 * FileEvidenceStore — 文件系统持久化的 Evidence Corpus。
 *
 * 独立于内存 EvidenceStore，供采集脚本 / Corpus Dashboard / Replay 消费。
 */
export class FileEvidenceStore {
  private readonly dir: string;
  private readonly items = new Map<string, EvidencePackage>();
  private readonly order: string[] = [];
  private nextSeq = 1;

  constructor(options: FileEvidenceStoreOptions = {}) {
    this.dir = options.dir ?? join(process.cwd(), "evidence");
  }

  /** 初始化：创建目录 + 从磁盘加载已有 Corpus（重启不丢失） */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const files = (await readdir(this.dir)).filter(
      (f) => f.startsWith("evidence-") && f.endsWith(".json"),
    );
    for (const file of files) {
      try {
        const raw = await readFile(join(this.dir, file), "utf8");
        const pkg = JSON.parse(raw) as EvidencePackage;
        if (pkg?.id) {
          this.items.set(pkg.id, pkg);
          this.order.push(pkg.id);
          const seq = parseSeq(file);
          if (seq >= this.nextSeq) this.nextSeq = seq + 1;
        }
      } catch {
        // 跳过损坏文件（不影响整体加载）
      }
    }
    if (this.order.length > 0) {
      await this.writeIndex();
    }
  }

  /** 追加一个 Evidence（新证据分配序号；同 id 覆盖不新增序号） */
  async append(pkg: EvidencePackage): Promise<void> {
    await mkdir(this.dir, { recursive: true });

    if (!this.items.has(pkg.id)) {
      this.order.push(pkg.id);
      const seq = this.nextSeq;
      const filename = `evidence-${String(seq).padStart(SEQ_WIDTH, "0")}.json`;
      await writeFile(join(this.dir, filename), JSON.stringify(pkg, null, 2), "utf8");
      this.nextSeq = seq + 1;
    } else {
      // 已存在：覆盖原文件（同 id 更新，不新增序号）
      const existingFile = await this.findFileForId(pkg.id);
      if (existingFile) {
        await writeFile(join(this.dir, existingFile), JSON.stringify(pkg, null, 2), "utf8");
      }
    }
    this.items.set(pkg.id, pkg);

    await this.writeIndex();
  }

  /** 按 id 加载 */
  async load(id: string): Promise<EvidencePackage | undefined> {
    return this.items.get(id);
  }

  /** 列表（按保存顺序） */
  async list(): Promise<readonly EvidencePackage[]> {
    return this.order.map((id) => this.items.get(id)!).filter(Boolean);
  }

  /** 数量 */
  async size(): Promise<number> {
    return this.items.size;
  }

  /** 查找（按 predicate，纯读） */
  async find(
    predicate: (pkg: EvidencePackage) => boolean,
  ): Promise<EvidencePackage[]> {
    return this.order
      .map((id) => this.items.get(id)!)
      .filter((p) => p && predicate(p));
  }

  /** Corpus Index（Dashboard 直接读它） */
  async index(): Promise<CorpusIndex> {
    const count = this.items.size;
    const latestId = this.order.length > 0 ? this.order[this.order.length - 1] : null;
    const tags: Record<string, number> = {};
    for (const id of this.order) {
      const pkg = this.items.get(id)!;
      const tag = pkg.sample?.pdfRef ?? "unknown";
      tags[tag] = (tags[tag] ?? 0) + 1;
    }
    return {
      schemaVersion: CORPUS_INDEX_VERSION,
      count,
      latestId,
      updatedAt: new Date().toISOString(),
      tags,
      nextSeq: this.nextSeq,
    };
  }

  /** Corpus 统计（基于 FailureRecord.delta） */
  async statistics(): Promise<CorpusStoreStatistics> {
    const records = this.order
      .map((id) => this.items.get(id)!.failure)
      .filter(Boolean);
    if (records.length === 0) {
      return { total: 0, averageDelta: 0, maxDelta: 0, deltaBuckets: {} };
    }
    const deltas = records.map((r) => r.delta);
    const totalDelta = deltas.reduce((a, b) => a + b, 0);
    const maxDelta = Math.max(...deltas);
    const deltaBuckets: Record<string, number> = { "<1°": 0, "1-5°": 0, "5-10°": 0, ">10°": 0 };
    for (const d of deltas) {
      if (d < 1) deltaBuckets["<1°"]++;
      else if (d < 5) deltaBuckets["1-5°"]++;
      else if (d < 10) deltaBuckets["5-10°"]++;
      else deltaBuckets[">10°"]++;
    }
    return { total: records.length, averageDelta: totalDelta / records.length, maxDelta, deltaBuckets };
  }

  /**
   * Corpus Health Check（M1.5：所有 Replay 前先跑它）。
   *
   * 检查：index 一致性 / 文件丢失 / 重复 id / nextSeq 连续 / JSON 损坏。
   */
  async validate(): Promise<CorpusValidationResult> {
    const files = (await readdir(this.dir)).filter(
      (f) => f.startsWith("evidence-") && f.endsWith(".json"),
    );

    // 收集磁盘上的证据（id → 序号），并检测损坏文件
    const diskById = new Map<string, number>();
    const corrupted: string[] = [];
    for (const file of files) {
      try {
        const raw = await readFile(join(this.dir, file), "utf8");
        const pkg = JSON.parse(raw) as EvidencePackage;
        if (pkg?.id) diskById.set(pkg.id, parseSeq(file));
      } catch {
        corrupted.push(file);
      }
    }

    // index.json 是否可读，记录数是否一致
    let indexCount: number | null = null;
    let indexOk = true;
    try {
      const raw = await readFile(join(this.dir, "index.json"), "utf8");
      const idx = JSON.parse(raw) as CorpusIndex;
      indexCount = idx.count;
    } catch {
      indexOk = false;
    }
    const actualCount = diskById.size;
    const indexConsistent =
      indexOk && indexCount !== null && indexCount === actualCount;

    // 重复 id（index 内不应有，但防磁盘）
    const ids = this.order.filter((id) => this.items.get(id));
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) duplicates.push(id);
      seen.add(id);
    }

    // nextSeq 连续性：nextSeq === 最大序号 + 1
    const maxSeq = Math.max(0, ...files.map(parseSeq));
    const nextSeqContinuous = this.nextSeq === maxSeq + 1;

    // 缺失文件：order 里的 id 但磁盘没有（仅当 init 已加载时有效）
    const missing: string[] = [];
    for (const id of this.order) {
      if (this.items.get(id) && !diskById.has(id)) missing.push(id);
    }

    return {
      healthy: indexConsistent && corrupted.length === 0 && duplicates.length === 0 && nextSeqContinuous,
      indexConsistent,
      missingFiles: missing,
      duplicateIds: duplicates,
      nextSeqContinuous,
      corruptedFiles: corrupted,
      actualCount,
    };
  }

  /**
   * Corpus Rebuild Index（M1.5：index.json 丢失或损坏时）。
   *
   * 重新扫描 evidence-*.json，重建 index.json。
   */
  async rebuildIndex(): Promise<CorpusIndex> {
    // 重新从磁盘加载，清空内存态
    this.items.clear();
    this.order.length = 0;
    this.nextSeq = 1;

    const files = (await readdir(this.dir)).filter(
      (f) => f.startsWith("evidence-") && f.endsWith(".json"),
    );
    for (const file of files) {
      try {
        const raw = await readFile(join(this.dir, file), "utf8");
        const pkg = JSON.parse(raw) as EvidencePackage;
        if (pkg?.id) {
          this.items.set(pkg.id, pkg);
          this.order.push(pkg.id);
          const seq = parseSeq(file);
          if (seq >= this.nextSeq) this.nextSeq = seq + 1;
        }
      } catch {
        // 跳过损坏文件
      }
    }

    await this.writeIndex();
    return this.index();
  }

  /**
   * 导出 Corpus 到目标目录（M1.5：发给他人的 JSON 快照）。
   *
   * 复制所有 evidence-*.json + index.json 到 targetDir。
   * （zip 打包留待未来扩展。）
   */
  async exportTo(targetDir: string): Promise<void> {
    await mkdir(targetDir, { recursive: true });
    const files = (await readdir(this.dir)).filter((f) =>
      f.startsWith("evidence-") && f.endsWith(".json"),
    );
    for (const file of files) {
      const raw = await readFile(join(this.dir, file), "utf8");
      await writeFile(join(targetDir, file), raw, "utf8");
    }
    const idx = await this.index();
    await writeFile(join(targetDir, "index.json"), JSON.stringify(idx, null, 2), "utf8");
  }

  /**
   * 从源目录导入 Corpus（M1.5：合并/恢复）。
   *
   * 读取源目录所有 evidence-*.json 并 append 到本 Corpus（同 id 覆盖）。
   */
  async importFrom(sourceDir: string): Promise<number> {
    const files = (await readdir(sourceDir)).filter(
      (f) => f.startsWith("evidence-") && f.endsWith(".json"),
    );
    let imported = 0;
    for (const file of files) {
      try {
        const raw = await readFile(join(sourceDir, file), "utf8");
        const pkg = JSON.parse(raw) as EvidencePackage;
        if (pkg?.id) {
          await this.append(pkg);
          imported++;
        }
      } catch {
        // 跳过损坏文件
      }
    }
    return imported;
  }

  /** 清空 Corpus（仅测试用） */
  async clear(): Promise<void> {
    for (const file of (await readdir(this.dir)).filter(
      (f) => f.startsWith("evidence-") && f.endsWith(".json"),
    )) {
      await rm(join(this.dir, file), { force: true });
    }
    await rm(join(this.dir, "index.json"), { force: true });
    this.items.clear();
    this.order.length = 0;
    this.nextSeq = 1;
  }

  /** 写 index.json */
  private async writeIndex(): Promise<void> {
    const idx = await this.index();
    await writeFile(join(this.dir, "index.json"), JSON.stringify(idx, null, 2), "utf8");
  }

  /** 查找某 id 对应的已持久化文件名 */
  private async findFileForId(id: string): Promise<string | null> {
    const files = (await readdir(this.dir)).filter(
      (f) => f.startsWith("evidence-") && f.endsWith(".json"),
    );
    for (const file of files) {
      try {
        const raw = await readFile(join(this.dir, file), "utf8");
        const pkg = JSON.parse(raw) as EvidencePackage;
        if (pkg?.id === id) return file;
      } catch {
        // skip
      }
    }
    return null;
  }
}

/** 从文件名解析序号（evidence-000001.json → 1） */
function parseSeq(file: string): number {
  const m = /evidence-(\d+)\.json/.exec(file);
  return m ? parseInt(m[1], 10) : 0;
}
