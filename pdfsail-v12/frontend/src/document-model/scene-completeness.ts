/**
 * scene-completeness.ts — Scene Completeness Engine（Sprint-112）
 *
 * Mission：定义"什么叫 Ready"。Ready 不是时间、不是 OCR、不是 Canvas，
 * 而是 **Expected Scene == Actual Scene**。
 *
 * 流程：
 *   Raw Inventory → Expected Scene → Actual Scene → Completeness → scene.ready → Reveal
 *
 * 关键（PM Rule）：
 *   - scene.ready 绝不写死 `glyph > 0 && image > 0`（不同 PDF 的 Expected 不同）。
 *   - 文本 PDF (Expected: Text=113, Image=1, Vector=1) vs 扫描 PDF (Expected: Image=1)
 *     各有不同 Expected，Completeness 自动适应。
 *
 * 纯函数（ADR-005），Node 可测。不依赖 DOM/Canvas/Renderer。
 */

/** Scene 对象类型清单（对应 Raw Inventory 分类） */
export type SceneObjectType = "text" | "image" | "vector" | "shape" | "annotation";

/** 每类对象的期望数量（来自 Raw Inventory / pdf.js 解析） */
export interface ExpectedScene {
  readonly text: number;
  readonly image: number;
  readonly vector: number;
  readonly shape: number;
  readonly annotation: number;
}

/** 每类对象的实际数量（来自 Scene Builder 输出） */
export interface ActualScene {
  readonly text: number;
  readonly image: number;
  readonly vector: number;
  readonly shape: number;
  readonly annotation: number;
}

/** Completeness 计算结果 */
export interface SceneCompleteness {
  /** 完整度 0~100（Expected 中存在的类型，Actual 是否达到） */
  readonly ratio: number;
  /** 是否 100% 完整 */
  readonly complete: boolean;
  /** 缺失的对象类型及期望/实际 */
  readonly missing: { type: SceneObjectType; expected: number; actual: number }[];
  /** Expected 中不存在的类型（该 PDF 本就没有的对象，不参与判定） */
  readonly notExpected: SceneObjectType[];
}

const TYPES: SceneObjectType[] = ["text", "image", "vector", "shape", "annotation"];

/** 空 Expected（默认：无对象期望） */
export const EMPTY_EXPECTED: ExpectedScene = { text: 0, image: 0, vector: 0, shape: 0, annotation: 0 };

/** 空 Actual */
export const EMPTY_ACTUAL: ActualScene = { text: 0, image: 0, vector: 0, shape: 0, annotation: 0 };

/**
 * 计算 Scene Completeness。
 * @param expected 期望对象（来自 Raw Inventory）
 * @param actual   实际对象（来自 Scene Builder 输出）
 */
export function computeSceneCompleteness(
  expected: ExpectedScene,
  actual: ActualScene,
): SceneCompleteness {
  const missing: SceneCompleteness["missing"] = [];
  const notExpected: SceneObjectType[] = [];
  let matched = 0; // 已达标类型数
  let applicable = 0; // 参与判定的类型数（Expected>0 的类型）

  for (const type of TYPES) {
    const exp = expected[type];
    const act = actual[type];
    if (exp > 0) {
      applicable++;
      // 判定标准：Expected 要求数量 > 0，则 Actual 必须达到（≥1 或 ≥expected？用 expected 精确）
      // PM 例：Expected Text=113, Image=1 → Actual 须 Text=113? 还是 Text>0?
      // 采用"类型级 Completeness"：Expected>0 的类型，Actual 须 >0 才算达标（该对象已存在）。
      // 更严格可逐对象计数，但 Sprint-112 先按"类型存在性"建立可计算框架。
      if (act > 0) matched++;
      else missing.push({ type, expected: exp, actual: act });
    } else {
      notExpected.push(type);
    }
  }

  const ratio = applicable > 0 ? Math.round((matched / applicable) * 1000) / 10 : 100;
  const complete = applicable > 0 ? missing.length === 0 : true;

  return { ratio, complete, missing, notExpected };
}

/** 从 Raw Inventory 数值构造 ExpectedScene */
export function expectedFromCounts(c: Partial<ExpectedScene>): ExpectedScene {
  return {
    text: c.text ?? 0,
    image: c.image ?? 0,
    vector: c.vector ?? 0,
    shape: c.shape ?? 0,
    annotation: c.annotation ?? 0,
  };
}

/** 从 Scene Builder 输出构造 ActualScene */
export function actualFromCounts(c: Partial<ActualScene>): ActualScene {
  return {
    text: c.text ?? 0,
    image: c.image ?? 0,
    vector: c.vector ?? 0,
    shape: c.shape ?? 0,
    annotation: c.annotation ?? 0,
  };
}
