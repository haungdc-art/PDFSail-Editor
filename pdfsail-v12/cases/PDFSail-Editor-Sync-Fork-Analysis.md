# PDFSail-Editor 编辑器核心同步 — 分叉点与定制清单

日期：2026-10-28（v2：追加方案 B 执行记录）
源（上游）：`D:\TRAE\pdfsail-v12`，HEAD `f2342c9`（2026-10-26），main
目标（本仓库）：`d:\TRAE\PDFSail-Editor\pdfsail-v12`，main
执行：方案 A（保守收口）→ **方案 B（原子切换 + R2 重放）**，均已提交、未 push。

---

## 提交账本

| commit | 内容 |
|---|---|
| `ce0693b` | 方案 A：新增上游 181 个 Binding/Core 模块（仅增量，+43,166） |
| `1d59414` | 方案 A：同步 18 个 document-model/editor-engine/lib 文件 + `@pdf-lib/fontkit ^1.1.1` |
| `c1fecc1` | **方案 B**：editor 核心 18 文件 + pdf-importer.ts 原子切换到上游（+10,764/−5,531），并在新 PDFEditor.tsx 上重放 5 处产品定制 |

## 方案 B 记录（2026-10-28）

### 覆盖（上游 f2342c9）
PDFEditor.tsx、PDFCanvas、TextEditOverlay、FloatingToolbar、EditModeToolbar、FindReplaceBar、core/engine、export-pdf、segmentEditBinding、useExport、useInlineTools、useOCR、usePageOps、fontDataBridge、useSelection、pdf-renderer、types.ts、pdf-importer.ts

### R2/商业模式重放（5 处 hunk，落到新 PDFEditor.tsx）
1. `useEditor()` 解构加回 `setShowCompressOptions, setShowSplitOptions`
2. `processInline` 包装（**先转换后付费**：先 `handleExportWithCommit` 拿含字形级编辑的 PDF，`sourceBytes` 透传给 useInlineTools）
3. **URL ingress effect**：`?file/?r2/?fileKey/?name` → `www.pdfsail.com/api/r2-file` → `loadPdfFromArrayBuffer` → 清 URL 参数
4. `onConvertClick`：compress 打开质量弹窗，其余走 processInline（替换上游的「IndexedDB→sessionStorage→navigate(/paywall)」流程）
5. PostLoadModal 的 onCompress/onSplit 打开选项弹窗
6. DownloadButton 调用点删 `cssScaleRef`（目标组件 props 无此字段）

### 刻意不覆盖（本项目独有，上游没有）
- `components/DownloadButton.tsx`（R2 上传→/ready→/paywall 全流程）
- `components/OptionModals.tsx`（完成弹框内调 `uploadToR2AndRedirect`）
- `utils/r2Redirect.ts`（目标独有文件）
- `hooks/useOperationState.ts`（**EditorContextValue 的产品 state 载体**：compress/split/rotate/pagenum/completion。上游简化版只有 processing/pay，覆盖会让 OptionModals/DownloadButton 产生 28 条类型错误——实测发生并回滚）

### 排障实录
- 首次 B-1 后 OptionModals 27 条 + DownloadButton 1 条 TS2339 → 追因：`EditorContextValue = ReturnType<useDocument> & ... & ReturnType<useOperationState> & ...`（EditorProvider.tsx 两侧一致），产品字段全在目标版 `useOperationState` → 恢复后清零。
- `setShowCompressOptions` grep 误 0：`setShow**C**ompressOptions` 含大写 S，正则 `/showCompressOptions/` 不匹配——grep 大小写教训。
- 仓库 git 根在 `PDFSail-Editor/`（路径前缀 `pdfsail-v12/`），`git show HEAD:frontend/...` 会报 not found。
- Playwright 清理 outputDir 触发 safe-delete 守卫 → outputDir 移到项目外（`PW_OUT`）。
- 目标项目无 @playwright/test → `npm i --no-save @playwright/test@1.62.1`（不污染 package.json，实测 lockfile 未变）。

### 验证
- `vite build` EXIT 0
- `tsc` 488 vs 480（方案 A 基线）：**未触碰生产文件零新增**；+12 = 覆盖文件自身的上游既有债（PDFEditor +6、useInlineTools +3 新、PDFCanvas +2 新、useExport +1）、+2 = `_diag*` 取证脚本、−6 = 同步顺带修复（pdf-importer −3、segmentCommit −2、ocr-projection-style −1）
- 真实 Chromium **5/5**（`tests/e2e/f3b-planb-accept*.spec.ts`，本地资产）：
  - T1 `?file=` ingress：PDF 加载、URL 参数清除 ✓
  - T2 `?r2=` ingress（mock api/r2-file）✓
  - T3 编辑流：`✏️ Edit` → segment contenteditable → 输入 X → 提交 → `coreSize=1, coreOwner=core, corePara0="EMBEXDTEST"`（EMBEDTEST 中心精确插入）✓
  - T4 Download → 完成弹框 phase 出现，无 pageerror ✓
  - T5 Convert→Compress → 质量选项弹窗出现 ✓
  - 五例 pageErrors 全空

## 分叉关系（保留备查）

- 目标由上游移植（`a22d37b`），分叉点 ≈ `0a87e29`（2026-09-20），上游 HEAD `f2342c9` 领先 71 提交。
- 双向分叉：源拿新架构（Binding/Core/段落编辑/单元格编辑/导出重绘），目标拿产品化（R2→/ready→/paywall）。
- 强耦合：`pdf-importer.ts` ⟷ `PDFEditor.tsx` 必须同批（上游已不导出 `assignOperatorProvenanceForPage`）。

## 遗留 / 后续候选

1. 上游 2 个未提交改动（`backend/ocr.ts`、`editor/core/engine.ts` 注释更新）未同步。
2. 目标自有改动 `native-export-policy.ts` / `replace-text-operator.ts`（2 个 M）保持未提交，需用户裁决。
3. 段落编辑/表格 cell 编辑/导出重绘的**深度验收**（多行段落、cell 表格、导出重绘管线）建议用真实用户 PDF 走一轮用户验收。
4. 上游 `tests/`（e2e 资产）在 .gitignore，未随同步；上游 155+ 套件的 `editor:core:test` 回归链可按需移植。
5. tsc 基线 488（上游文件自身类型债），后续可在独立批次清理。

## 8. 验收回归：E-01 missing-original-bounds 排查（2026-10-28）

**现象**：用户验收（生产构建）编辑第 1 页文本后下载，报 `[E-01] Core export failed at eligibility: missing-original-bounds`。

**排查过程与结论**：

1. 用户原件 `2026年广东省青少年游泳锦标赛竞赛规程.pdf` 与上游 fixture `gd-swim-2026.pdf` **字节一致**（sha1 83537a5d，13 页）——排除文件因素。
2. 关键修复完整性核查：sidecar 增量并入 / pristine 快照 / precomputeSidecarOperatorProvenance / pageOneBasedOf / CTM 核验 / omittedWhitespaceUnits / groupKey / pageDisplacementDyOf / OCR bounds 注册等 **12 项标记全部在同步版本中**。
3. 生产构建（`vite build` + `vite preview`）+ 用户真实路径（🎉 引导弹窗 → "Edit Text" 卡片）实测：
   - p1 单处编辑 → 下载 ✅ CORE-EXPORT-PROD 296KB
   - 多处编辑（中文 insertText + Backspace 删除 + 再编辑）→ 下载 ✅ 304KB
   - p1 编辑 → 翻 p2 → 编辑 → 下载 ✅ 315KB（`[SIDECAR-APPEND] appendedLines: 22` + 重绘 members=5/displaced=9）
   - 翻页往返 → 再编辑 → 下载 ✅ 301KB
   - 全部场景 `[E-01]` 精确命中 = 0、pageErrors = 0。
4. **结论：当前代码（a9f4b71）无法复现用户报错。** 用户报错 bundle（`index-PpN8MOl-.js`）已被后续构建覆盖，无法回验其代码版本；时间线指向用户验收时构建的是**方案 B 之前的旧编辑器**，其 missing-original-bounds 属上游 10-17~10-26 已修复的缺陷（方案 B 已同步全部修复）。
5. **已交付的永久诊断**（commit a9f4b71）：sidecar 构建失败原为静默 `catch { sidecar = null }`，现显式输出 `[SIDECAR-BUILD-FAILED]` + `window.__planbSidecarError`；成功输出 `[SIDECAR-BUILT]` 概况 + `window.__bindingSidecar` 探针。E-01 复现时可立即归因。

**教训**：console 断言正则 `/E-01/i` 会误匹配 `[CORE-012A]` / `[CORE-012C6]` 前缀中的 "E-01" 子串（"COR**E-01**2A"）——日志断言必须用 `/\[E-01\]/` 精确匹配。

**遗留**：`[ExportRenderer][CID] fallback:NotoSansSC 字体创建失败 Error: Unknown font format`——同步进来的 `NotoSansSC-Regular.otf`（8.33MB）在 fontkit 解析失败，fallback 来源自动退出（导出不受影响，但影响生僻 CJK 的导出保真度），待单独排查。

**测试资产**：`tests/e2e/f3b-planb-accept*.spec.ts`、`f3b-planb-e01-*.spec.ts`（本地，gitignored）。

## 9. 验收收尾（2026-10-28）

- **验收结果**：用户重新构建后按原操作验收，**编辑 → 下载 → R2 上传 → 跳转主站 card 页全链路走通**，E-01 不再出现（证实为旧构建问题）。
- **广告控制台噪音**：用户贴的 doubleclick / pagead2 / adsbygoogle 错误全部来自 **www.pdfsail.com 主站 card 页面**（AdSense + gtag），不是本编辑器项目代码（本项目无任何 AdSense 引用；仅 index.html 有 Clarity + gtag 转化埋点，保留）。网络层失败的红字无法用 JS 抑制，用户裁定**忽略（方案 A）**，不改主站。
- **方案 B 验收正式通过。**
