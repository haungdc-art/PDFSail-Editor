/**
 * Official Fixtures — Sprint37 · S37-1A
 *
 * 官方基准测试集（固定，所有算法修改必须通过）。
 *
 * 后续可扩展：
 *   fixtures/regression/  回归集
 *   fixtures/nightly/     每日集
 *   fixtures/quick/       快速集
 *
 * 注意：resource 是文件路径占位，真实 PDF/PNG 需放入 fixtures/ 对应目录。
 */

import type { SignatureFixture } from "../../benchmark";

/**
 * Official 签名旋转基准测试集。
 *
 * 覆盖：水平 / 旋转 90° / 180° / 270° / 医院 / 银行 / 合同 / 印章。
 */
export const officialFixtures: SignatureFixture[] = [
  {
    id: "hospital-001",
    resource: "fixtures/official/hospital-001.pdf",
    page: 1,
    expectedRotation: 0,
    description: "医院签名（水平）",
  },
  {
    id: "bank-001",
    resource: "fixtures/official/bank-001.pdf",
    page: 1,
    expectedRotation: 0,
    description: "银行签名（水平）",
  },
  {
    id: "contract-001",
    resource: "fixtures/official/contract-001.pdf",
    page: 1,
    expectedRotation: 0,
    description: "合同签名（水平）",
  },
  {
    id: "stamp-001",
    resource: "fixtures/official/stamp-001.pdf",
    page: 1,
    expectedRotation: 0,
    description: "印章",
  },
  {
    id: "rotated-90",
    resource: "fixtures/official/rotated-90.pdf",
    page: 1,
    expectedRotation: 90,
    description: "旋转 90°",
  },
  {
    id: "rotated-180",
    resource: "fixtures/official/rotated-180.pdf",
    page: 1,
    expectedRotation: 180,
    description: "旋转 180°",
  },
  {
    id: "rotated-270",
    resource: "fixtures/official/rotated-270.pdf",
    page: 1,
    expectedRotation: 270,
    description: "旋转 270°",
  },
];
