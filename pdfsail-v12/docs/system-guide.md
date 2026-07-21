# PDFSail V13 系统说明文档

> **版本**: 13.1.0 | **最后更新**: 2026-07-04

---

## 目录

1. [系统概述](#1-系统概述)
2. [系统架构](#2-系统架构)
3. [五大子系统详解](#3-五大子系统详解)
   - 3.1 [PDF SaaS 核心编辑器](#31-pdf-saas-核心编辑器)
   - 3.2 [AI SEO 流量机器](#32-ai-seo-流量机器)
   - 3.3 [竞品劫持系统](#33-竞品劫持系统)
   - 3.4 [商业收费系统](#34-商业收费系统)
   - 3.5 [Ads ROI 自动优化系统](#35-ads-roi-自动优化系统)
4. [V13 新增四大自动化系统](#4-v13-新增四大自动化系统)
   - 4.1 [A/B 测试引擎](#41-ab-测试引擎)
   - 4.2 [转化率优化引擎](#42-转化率优化引擎)
   - 4.3 [调度系统](#43-调度系统)
   - 4.4 [数据库层](#44-数据库层)
5. [数据模型](#5-数据模型)
6. [API 端点总览](#6-api-端点总览)
7. [关键字与 SEO 数据](#7-关键字与-seo-数据)
8. [项目文件结构](#8-项目文件结构)
9. [技术栈](#9-技术栈)

---

## 1. 系统概述

PDFSail V13 是一个**企业级 PDF SaaS + SEO 流量机器 + 竞品劫持 + Ads ROI 自动优化**的商业系统。

### 核心理念

这不是一个 PDF 工具，而是一个**完整的 SaaS Growth Machine**：

```
流量获取 (SEO + 竞品劫持) → 产品转化 (PDF Editor) → 收入变现 (Stripe/PayPal) → 优化放大 (Ads ROI)
```

### 五大核心层

| 层级 | 模块 | 作用 |
|---|---|---|
| 🧱 **产品层** | PDF Editor + OCR + Export | 核心产品功能 |
| 🔥 **流量层** | SEO 生成器 + 竞品劫持 | 获取免费+付费流量 |
| 💰 **商业层** | Stripe/PayPal 支付 + 免费版限制 | 变现 |
| 📈 **优化层** | Ads ROI + A/B 测试 + 转化优化 | 放大赚钱、停止亏损 |
| ⏱ **自动化层** | 调度器 + 数据库 | 定时运行、数据持久化 |

---

## 2. 系统架构

```
                          ┌──────────────────────────┐
                          │     用户流量入口           │
                          │ (Google / Direct / Ads)    │
                          └────────────┬─────────────┘
                                       ↓
         ┌─────────────────────────────────────────────┐
         │              Growth Engine Layer             │
         │  ┌──────────┐ ┌──────────┐ ┌──────────────┐ │
         │  │  SEO     │ │Competitor│ │  A/B Test    │ │
         │  │Generator │ │Generator │ │   Engine     │ │
         │  └──────────┘ └──────────┘ └──────────────┘ │
         │  ┌──────────┐ ┌──────────┐ ┌──────────────┐ │
         │  │Conversion│ │Ads ROI  │ │  Scheduler   │ │
         │  │  Engine  │ │Optimizer│ │              │ │
         │  └──────────┘ └──────────┘ └──────────────┘ │
         └────────────────────┬────────────────────────┘
                              ↓
         ┌─────────────────────────────────────────────┐
         │              Frontend Layer                  │
         │  ┌──────────┐ ┌──────────┐ ┌──────────────┐ │
         │  │PDF Editor│ │SEO Pages│ │  Competitor  │ │
         │  │(React)   │ │(Landing)│ │  Pages       │ │
         │  └──────────┘ └──────────┘ └──────────────┘ │
         └────────────────────┬────────────────────────┘
                              ↓
         ┌─────────────────────────────────────────────┐
         │              Backend API Layer               │
         │  Express.js on port 3001                     │
         │  /api/upload /export /billing /seo /ads     │
         │  /api/v13/* (growth system)                  │
         └────────────────────┬────────────────────────┘
                              ↓
         ┌─────────────────────────────────────────────┐
         │              Monetization Layer              │
         │  Stripe Checkout → $1.99/export             │
         │  PayPal → $1.99/export                      │
         │  Free: 3/day | Pro: unlimited               │
         └─────────────────────────────────────────────┘
```

### 数据流

```
1. 用户通过 Google 搜索 → SEO Landing Page → CTA → Editor
2. 用户搜索 "smallpdf alternative" → Competitor Page → CTA → Editor
3. 用户直接访问 → Editor → Upload PDF → Edit → Export → Paywall
4. Google Ads → Landing Page → Conversion → AdsOptimizer: SCALE/HOLD/STOP
5. 调度器每日运行 → SEO生成新页面 → DB 持久化
```

---

## 3. 五大子系统详解

### 3.1 PDF SaaS 核心编辑器

**位置**: `frontend/src/editor/PDFEditor.tsx`

#### 编辑器架构（三栏布局）

```
┌──────────────────────────────────────────────────────────────┐
│  <div border, borderRadius, boxShadow>                       │
│  ┌─────┬────────────────────────────────┬──────────────────┐ │
│  │左侧  │        中间画布区              │   右侧上下文面板    │ │
│  │缩略图 │  ┌─ Toolbar ──────────────┐  │ Page Controls    │ │
│  │导航栏 │  │ Upload T Text 🟡 High…│  │ + - ↑ ↓ pages    │ │
│  │150px │  └────────────────────────┘  │ ────────────────  │ │
│  │可收展 │  ┌─ Canvas ───────────┐ ▲ │ │ Text Style        │ │
│  │ [◀]  │  │                    │ │  │ Font/Size/Color    │ │
│  │      │  │   pdf-canvas-layer  │3/12│ ────────────────  │ │
│  │ p.1  │  │   interaction-layer │ ▼ │ │ Highlight Options │ │
│  │ p.2  │  │   #edit-portal-root │    │ │ Annotate Options  │ │
│  │ p.3  │  └────────────────────┘  36 │ ────────────────  │ │
│  │ ...  │  ← maxWidth:900, A4比例   px│ │ Blocks (N)        │ │
│  └─────┴────────────────────────────────┴──────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**三层 Canvas 结构（不变）：**
1. **pdf-canvas-layer** — PDF 页面渲染，CSS `width:100%, height:auto`
2. **interaction-layer** — `position:absolute, pointer-events:none`，包含文本层、Blocks、翻页
3. **#edit-portal-root** — Portal 编辑框，脱离 transform 约束

**三栏布局说明：**
- **左侧**：页面缩略图列表（默认 150px），点击 `◀` 可收起为 28px 窄条，再次点击 `▶` 展开
- **中间**：工具栏 + 画布（`maxWidth: 900, aspectRatio: A4 210/297`）
- **右侧**：统一上下文面板（240px），显示 Page Controls、当前工具选项（文本样式/高亮/批注/Redact/OCR）、Blocks 列表
- 画布右侧垂直分页条：▲ 3/12 ▼ 竖排导航

#### 坐标系统

`LockCoordSystem`（`coord.ts`）：

```
PDF pt (pdf-lib)
    ↑ toPDF()   ↓ fromPDF()
Canvas PX (pdfjs-dist)
    ↑ /scale    ↓ ×scale
CSS display px (DOM)
```

#### Block 类型

| 类型 | 说明 | 属性 |
|---|---|---|
| `text` | 可编辑文本块 | `text`, `fontSize`, `fontFamily`, `color` |
| `image` | 图片块 | `src` (dataURL) |
| `signature` | 签名块（手写/图片/艺术） | `dataUrl` |
| `highlight` | 高亮标注 | `hType`, `color`, `opacity` |
| `redact` | 永久涂黑脱敏 | 无额外属性 |
| `comment` | 批注 | `text` |

#### 编辑器功能

- **文本编辑**：双击打开 Portal textarea，支持字体/字号/颜色工具栏，选中后工具栏联动
- **图片插入**：本地选择图片，拖拽移动，右下角手柄缩放
- **签名面板**：手写签名 / 图片签名 / 艺术花体签名（24种 Google Fonts 手写体 × 16色）
- **高亮标注**：Text / Freehand / Underline / Strike / Wavy 五种类型，可选颜色和透明度
- **Redact 脱敏**：永久涂黑，导出后不可恢复
- **OCR 识别**：全页识别 + 框选区域识别（Tesseract.js, `chi_sim+eng`）
- **页面管理**：添加空白页、删除页、上移/下移排序
- **导出 PDF**：基于原始 PDF 叠加编辑内容，白色遮罩防重影
- **撤销/重做**：Ctrl+Z / Ctrl+Shift+Z
- **付费集成**：每天 3 次免费导出，超过后弹窗选择 Stripe 或 PayPal 支付 $1.99

---

### 3.2 AI SEO 流量机器

**位置**: `growth/seo/generator.ts`

**生成流程**:

```
Base Keywords (20个)
    ↓
expandKeywords() → 动作×限定词组合 (20×15×5 = 1500+ 变体)
    ↓
generateBatch() → 模板填充
    └── titleTemplates[8种]
    └── h1Templates[4种]
    └── descriptionTemplates[3种]
    └── contentSections[4种] (随机选2-3)
    ↓
SEOPage[] → 返回结构化数据
```

**页面结构**:

```
SEOPage {
  slug: "/compress-pdf"           // URL路径
  title: "Free online compress PDF tool — No signup needed"
  h1: "Compress PDF Online"
  description: "Use PDFSail to compress PDF instantly in browser..."
  content: "<h2>How to compress PDF</h2>..."  // SEO优化内容
  keyword: "compress PDF"
  category: "compress"
  volume: 38000
  difficulty: 68
}
```

**SEO 优化策略**:
- 每个标题模板包含主要关键词
- 内容包含 FAQ 板块（提升精选摘要排名）
- CTA 按钮出现在内容顶部和底部
- 内链到其他相关工具页面

---

### 3.3 竞品劫持系统

**位置**: `growth/competitor/generator.ts`

**竞品清单** (20个):

| 竞品 | URL 路径 | 目标流量 |
|---|---|---|
| Smallpdf | `/smallpdf-alternative` | 200K+/月 |
| iLovePDF | `/ilovepdf-alternative` | 150K+/月 |
| PDF24 | `/pdf24-alternative` | 80K+/月 |
| Adobe Acrobat | `/adobe-acrobat-alternative` | 500K+/月 |
| PDF Candy | `/pdf-candy-alternative` | 60K+/月 |
| +15 更多 | ... | ... |

**页面结构**:

```
CompetitorPage {
  slug: "smallpdf-alternative"
  title: "Best Smallpdf Alternative — Free & Better"
  h1: "Smallpdf Alternative"
  description: "Looking for a free alternative to Smallpdf?..."
  content: "<h1>Smallpdf Alternative</h1>..."  // 完整HTML内容
  competitor: "Smallpdf"
  cta: "/editor"
}
```

---

### 3.4 商业收费系统

**位置**: `backend/billing.ts`, `billing/stripe.ts`, `billing/paypal.ts`

**定价模型**:

| 层级 | 价格 | 每日导出 | 文件大小 | OCR | 去水印 |
|---|---|---|---|---|---|
| Free | $0 | 3次 | 10MB | ❌ | ❌ |
| Pro | $1.99/次 | 100次 | 100MB | ✅ | ✅ |
| Enterprise | 定制 | 不限 | 500MB | ✅ | ✅ |

**付费流程**:

```
用户点击 Export
    ↓
前端检查 /api/billing/usage
    ├── < 3次 → 免费导出 ✓
    └── ≥ 3次 → 弹出支付弹窗
                  ├── Stripe → $1.99 Checkout
                  └── PayPal → $1.99 PayPal订单
```

**Stripe**：创建 Checkout Session，跳转支付页面，Webhook 接收成功事件
**PayPal**：REST API 创建订单 → 用户在新标签页完成支付 → 前端捕获

---

### 3.5 Ads ROI 自动优化系统

**位置**: `growth/adsOptimizer.ts`

**核心逻辑**:

```
analyze(campaign):
  roas = revenue / spend
  
  if roas < 1.0  →  STOP   (停止亏损广告)
  if roas > 2.0  →  SCALE  (预算增加25%)
  else           →  HOLD   (保持观察)
```

**示例分析**:

| 活动 | 花费 | 收入 | ROAS | 操作 |
|---|---|---|---|---|
| PDF Editor Ads | $500 | $750 | 1.5x | HOLD |
| Merge PDF Bing Ads | $200 | $120 | 0.6x | STOP |
| Competitor: smallpdf | $350 | $320 | 0.9x | STOP |
| SEO: PDF to Word | $100 | $300 | 3.0x | SCALE (+25%) |

---

## 4. V13 新增四大自动化系统

### 4.1 A/B 测试引擎

**位置**: `growth/abtest/engine.ts`

**工作流程**:

```
1. ABTestEngine.create("Title A")  → variant id
2. ABTestEngine.create("Title B")  → variant id
3. ABTestEngine.create("Title C")  → variant id
4. 用户访问 → trackImpression(id)
5. 用户点击 → trackClick(id)
6. getResults() → 所有变体按CTR排序
7. getBest() → CTR最高的胜出变体
```

### 4.2 转化率优化引擎

**位置**: `growth/conversion/engine.ts`

**ConversionEngine**:

```
evaluate(clicks, conversions):
  cvr = conversions / clicks
  status:
    cvr < 1%   → "FAIL"
    cvr < 5%   → "OK"
    cvr ≥ 5%   → "GOOD"
```

**AutoOptimizer**:

```
decide(clicks, conversions):
  clicks < 100 → HOLD (数据不足)
  cvr < 1%  → PAUSE_ADS
  cvr > 8%  → SCALE_ADS (最大1.5x)
  其他       → HOLD
```

### 4.3 调度系统

**位置**: `growth/scheduler.ts`

**注册的任务**:

| 任务ID | 名称 | 执行间隔 | 功能 |
|---|---|---|---|
| `seo-generator` | SEO 页面生成 | 每天 | 从 base keywords 扩展生成新页面 |
| `competitor-generator` | 竞品页面生成 | 每天 | 为所有竞品生成劫持页面 |
| `ads-optimizer` | 广告ROI优化 | 每6小时 | 分析广告活动，自动停/扩 |
| `maintenance` | 日常维护 | 每天 | 清理旧日志，健康检查 |

### 4.4 数据库层

**位置**: `growth/db.ts`

**特征**:
- 内存数据库 + JSON 文件持久化
- 泛型集合操作（CRUD）
- 自动保存到 `./data/db.json`
- 集合：`seo_pages`、`competitor_pages`、`ad_campaigns`

---

## 5. 数据模型

### 5.1 Block（编辑器核心块）

```typescript
BaseBlock {
  id: string;         // UUID
  type: "text" | "image" | "signature" | "highlight" | "redact" | "comment";
  page: number;       // PDF页码
  x: number;          // 左上角X坐标
  y: number;          // 左上角Y坐标
  w: number;          // 宽度
  h: number;          // 高度
}
```

### 5.2 SEOPage

```typescript
SEOPage {
  slug: string;           // URL路径
  title: string;          // <title>
  h1: string;             // 页面大标题
  description: string;    // <meta description>
  content: string;        // HTML内容
  keyword: string;        // 目标关键词
  category?: string;      // 分类
  volume?: number;        // 月搜索量
  difficulty?: number;    // SEO难度(0-100)
}
```

### 5.3 CompetitorPage

```typescript
CompetitorPage {
  slug: string;           // URL路径 (+ "-alternative")
  title: string;          // <title>
  h1: string;             // 页面大标题
  description: string;    // <meta description>
  content: string;        // 完整HTML对比内容
  competitor: string;     // 竞品名称
  cta: string;            // CTA链接
}
```

### 5.4 ROIAnalysis

```typescript
ROIAnalysis {
  campaignId: string;
  campaignName: string;
  ctr: number;            // 点击率
  cpc: number;            // 每次点击成本
  conversionRate: number; // 转化率
  roi: number;            // 投资回报率
  roas: number;           // 广告支出回报率
  action: "SCALE" | "HOLD" | "STOP";
  recommendation: string; // 优化建议
}
```

---

## 6. API 端点总览

### 核心 API

| 方法 | 端点 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| POST | `/api/upload` | 上传 PDF |
| POST | `/api/export` | 导出 PDF |
| POST | `/api/billing/checkout` | 创建支付会话（Stripe/PayPal） |
| POST | `/api/billing/paypal/capture` | 捕获 PayPal 订单 |
| GET | `/api/billing/usage` | 使用量查询 |
| POST | `/api/billing/webhook` | Stripe webhook |
| GET | `/api/seo/pages` | 所有 SEO 页面 |
| GET | `/api/seo/page/:keyword` | 单个 SEO 页面 |
| GET | `/api/seo/sitemap` | Sitemap 数据 |
| POST | `/api/ads/campaign` | 注册广告活动 |
| GET | `/api/ads/campaigns` | 活动列表 |
| GET | `/api/ads/analyze` | 分析所有活动 |
| POST | `/api/ads/optimize` | 自动优化 |
| GET | `/api/keywords/opportunities` | SEO 机会关键词 |

### Value Probe API

| 方法 | 端点 | 说明 |
|---|---|---|
| POST | `/api/value/upload` | 上传 PDF 并返回 doc_id + page_count |
| POST | `/api/value/analyze` | 运行规则引擎分析文档价值 |
| POST | `/api/value/trigger` | 返回唯一推荐 Action（Open Loop） |
| POST | `/api/value/action` | 执行推荐 Action |
| POST | `/api/value/event` | 追踪用户事件（带 A/B variant） |
| GET | `/api/value/metrics` | 实验数据看板 |
| GET | `/api/value/download/:filename` | 下载执行结果 |

### V13 Growth API

| 方法 | 端点 | 说明 |
|---|---|---|
| GET | `/api/v13/status` | 系统状态 |
| POST | `/api/v13/build` | 构建所有页面 |
| GET | `/api/v13/seo/pages` | 所有 SEO 页面 |
| POST | `/api/v13/seo/generate` | 生成 SEO 页面 |
| POST | `/api/v13/seo/expand` | 扩展 1500+ 页面 |
| GET | `/api/v13/competitor/pages` | 竞品页面 |
| POST | `/api/v13/competitor/generate` | 生成竞品页面 |
| POST | `/api/v13/abtest/create` | 创建 A/B 测试 |
| POST | `/api/v13/abtest/impression` | 记录展示 |
| POST | `/api/v13/abtest/click` | 记录点击 |
| GET | `/api/v13/abtest/results` | 测试结果 |
| POST | `/api/v13/conversion/evaluate` | 转化率评估 |
| POST | `/api/v13/conversion/log` | 记录转化事件 |
| POST | `/api/v13/optimizer/decide` | 自动决策 |
| POST | `/api/v13/optimizer/decide-batch` | 批量决策 |
| GET | `/api/v13/scheduler/status` | 调度器状态 |
| POST | `/api/v13/scheduler/start` | 启动调度器 |
| POST | `/api/v13/scheduler/stop` | 停止调度器 |

---

## 7. 关键字与 SEO 数据

### 基础关键字 (20个，可扩展至 1500+)

| 关键字 | 月搜索量 | 难度 | 分类 |
|---|---|---|---|
| edit PDF | 33,000 | 65 | edit |
| merge PDF files | 45,000 | 72 | merge |
| compress PDF | 38,000 | 68 | compress |
| convert PDF to Word | 52,000 | 75 | convert |
| split PDF | 28,000 | 45 | split |
| sign PDF | 20,000 | 40 | sign |
| unlock PDF | 18,000 | 35 | security |
| PDF OCR | 15,000 | 30 | ocr |
| delete pages from PDF | 16,000 | 28 | edit |
| reorder PDF pages | 8,000 | 20 | edit |
| extract PDF pages | 14,000 | 32 | split |
| resize PDF | 9,000 | 22 | edit |
| PDF to JPG | 25,000 | 50 | convert |
| add text to PDF | 12,000 | 35 | edit |
| remove text from PDF | 8,000 | 30 | edit |
| watermark PDF | 7,000 | 25 | security |
| flatten PDF | 5,000 | 20 | edit |
| optimize PDF | 6,000 | 22 | compress |
| rotate PDF pages | 12,000 | 25 | edit |
| PDF to PNG | 11,000 | 28 | convert |
| **总计** | **~423,000/月** | | |

### 竞品流量价值

| 竞品 | 月搜索量 (估算) | 转换潜力 |
|---|---|---|
| Smallpdf 替代 | 50,000+ | 高 |
| iLovePDF 替代 | 35,000+ | 高 |
| Adobe Acrobat 替代 | 80,000+ | 极高 |
| PDF24 替代 | 20,000+ | 中 |
| PDF Candy 替代 | 15,000+ | 中 |

---

## 8. 项目文件结构

```
pdfsail-v12/
│
├── frontend/src/                    # React + TypeScript 前端
│   ├── App.tsx                      # 主应用 (路由 + 导航 + 页脚)
│   ├── main.tsx                     # 入口
│   ├── index.css                    # 全局样式
│   ├── editor/
│   │   ├── PDFEditor.tsx            # PDF 编辑器 (三栏布局 + 缩略图 + 右侧面板)
│   │   ├── SignaturePad.tsx         # 签名面板（手写/图片/24种艺术字体）
│   │   ├── export-pdf.ts            # 前端 PDF 导出 (pdf-lib)
│   │   ├── coord.ts                 # LockCoordSystem 坐标系统
│   │   ├── ocr.ts                   # OCR 模块
│   │   ├── types.ts                 # Block 类型定义
│   │   ├── store.ts                 # Store 导出
│   │   ├── engine.ts                # 编辑器引擎接口
│   │   ├── extract.ts               # PDF 文本提取
│   │   ├── reflow.ts                # 文本重排
│   │   ├── text-layer.ts            # 文本层渲染
│   │   ├── pdf-renderer.ts          # PDF 渲染器
│   │   ├── TextEditor.tsx           # 文本编辑器组件
│   │   └── undo-redo.ts             # 撤销/重做
│   ├── value-probe/                 # PDF Value Probe v0 实验系统
│   │   ├── ValueProbePage.tsx       # 8 阶段用户旅程 + A/B 文案系统
│   │   ├── value-probe.css          # 暗色主题样式
│   │   └── types.ts                 # 类型定义
│   ├── landing/
│   │   ├── SEOPage.tsx              # SEO 着陆页
│   │   └── CompetitorPage.tsx       # 竞品劫持页面
│   └── routing/
│       └── routes.tsx               # 17+ 路由定义（含 /value-probe）
│
├── backend/                         # Express.js 后端
│   ├── server.ts                    # 主服务 (端口3001)
│   ├── billing.ts                   # 计费路由 (Stripe + PayPal + 使用量)
│   ├── export.ts                    # 后端 PDF 导出
│   ├── upload.ts                    # 文件上传 (multer)
│   ├── seo.ts                       # SEO API 路由
│   ├── v13.ts                       # V13 Growth API 路由
│   ├── value-analyzer.ts            # PDF Value Probe 规则引擎
│   └── value-probe.ts               # PDF Value Probe API 路由
│
├── growth/                          # Growth Engine (核心商业逻辑)
│   ├── seo/generator.ts             # AI SEO 生成器
│   ├── competitor/generator.ts      # 竞品页面生成器
│   ├── abtest/engine.ts             # A/B 测试引擎
│   ├── conversion/engine.ts         # 转化率优化引擎
│   ├── adsOptimizer.ts              # ROI 优化
│   ├── db.ts                        # 内存+JSON持久化
│   ├── scheduler.ts                 # 定时调度系统
│   └── system.ts                    # 全系统编排器
│
├── billing/                         # 支付 SDK 封装
│   ├── stripe.ts                    # Stripe SDK
│   └── paypal.ts                    # PayPal REST API
│
├── shared/
│   ├── types.ts                     # 共享类型定义
│   └── keywords.ts                  # 预定义关键词数据
│
├── worker/
│   └── ocr.ts                       # Tesseract.js OCR 工作线程
│
├── config/
│   ├── package.json                 # 依赖管理
│   ├── tsconfig.json                # TypeScript 配置
│   └── vite.config.ts               # Vite 构建配置
│
└── docs/
    ├── system-guide.md              # 系统说明文档
    └── user-guide.md                # 用户操作手册
```

---

## 9. 技术栈

| 层级 | 技术 | 版本 | 用途 |
|---|---|---|---|
| 前端框架 | React | ^18.3.1 | UI 组件 |
| 语言 | TypeScript | ^5.5.3 | 类型安全 |
| 构建工具 | Vite | ^5.4.0 | 开发/打包 |
| PDF 渲染 | pdfjs-dist | ^4.0.379 | 浏览器端 PDF 渲染 |
| PDF 操作 | pdf-lib | ^1.17.1 | 创建/编辑/导出 |
| OCR | Tesseract.js | ^5.1.1 | 图片文字识别 |
| 字体 | Google Fonts | - | 24 种手写签名字体（index.html） |
| 后端框架 | Express.js | ^4.19.2 | API 服务 |
| 支付 | Stripe | ^16.1.0 | 信用卡支付 |
| 支付 | PayPal REST API | - | PayPal 支付 |
| 文件上传 | Multer | ^1.4.5 | 文件处理 |
| UUID | uuid | ^10.0.0 | ID 生成 |
| 并行程式 | concurrently | ^8.2.2 | 前后端并行启动 |

---

## 10. PDF Value Probe v0（实验系统）

> **这是一套用户心智验证系统，用于验证核心假设：** 低成本获取的 PDF 是否天然存在"可继续收费的第二步需求"。

### 10.1 核心理念

```
不是 PDF 工具，而是：
"从'任务完成'→'任务未完成感'→'价值解锁'的心理驱动系统"
```

### 10.2 用户旅程（8 阶段）

```
Upload → Passive Processing → Value Suggestion
    ↓
Perceived Incompletion (Open Loop Trigger)
    ↓
Single Action → Value Confirmation → Optional Continuation
```

| 阶段 | 用户心理 | UI 状态 |
|---|---|---|
| ① Upload | "我要处理一个PDF" | 上传页 — Drop your PDF here |
| ② Analyzing | "正常处理流程" | Loading spinner — "Analyzing your document..." |
| ③ Value Suggestion | "嗯？还能做别的？" | Badge + Detection + Implication（紫色高亮条） |
| ④ Perceived Incompletion | "好像还没处理完？" | 黄色边框 — "You are currently seeing a static version" |
| ⑤ CTA | "我点一下看看" | `[Unlock Full Value]` — 好奇心驱动，不是功能选择 |
| ⑥ Action | "原来是这个意思" | 推荐单一 Action + Execute 按钮 |
| ⑦ Confirmation | "确实比原来更有用" | "Your document has been enhanced" + ✔ 3 checkmarks |
| ⑧ Continuation | "还能继续？" | "further improvement opportunities" + Upload another |

### 10.3 A/B Test 文案系统

3 个变体，每次访问随机分配（33% 各版）：

| 版本 | 语风 | CTA | 适用场景 |
|---|---|---|---|
| **A（基础版）** | 中性检测 | "Unlock More Value" | 对照基线 |
| **B（价值版）** | 价值发现 | "🔥 Unlock Full Value" | 感知价值注入 |
| **C（缺口刺激版）** | 未完成感 | "🔥 Complete Processing" | 最强转化预期 |

所有事件（upload / analyze / open_loop_view / click_action）携带 `variant` 字段，可通过 metrics 端点对比各版本表现。

### 10.4 规则引擎（无 AI / 纯规则）

**位置**: `backend/value-analyzer.ts`

```
6 个信号 → 加权评分 → 决策
  multi_page (+2) | table_like_structure (+2)
  financial_document (+3) | contract_document (+3)
  likely_scanned (+2) | rich_text (+2)

≥ 5 → YES (有二次价值)
≤ 2 → NO  (单一用途)
3-4 → UNCERTAIN
```

### 10.5 成功指标

| 指标 | 公式 | 目标 |
|---|---|---|
| Upload Volume | 上传 PDF 总数 | — |
| YES Ratio | YES / ALL uploads | > 30% |
| Click Rate | CTA点击 / YES PDFs | > 10~20% |
| Secondary Intent | 执行下载 / CTA点击 | > 5% |

### 10.6 数据模型

```typescript
type AnalyzeInput = {
  text: string;        // pdf.js 提取文本
  pageCount: number;
  hasImages: boolean;
};

type AnalyzeResult = {
  valueFlag: "YES" | "NO" | "UNCERTAIN";
  signals: string[];   // 触发的信号列表
  score: number;       // 0-10
};

type ValueEvent = {
  doc_id: string;
  event: "upload" | "analyze" | "open_loop_view" | "click_action" | "download";
  timestamp: number;
  metadata: { variant?: string; score?: number };
};
```

### 10.7 API 端点

| 方法 | 端点 | 说明 |
|---|---|---|
| POST | `/api/value/upload` | 上传 PDF（含 pdf-lib 页数提取） |
| POST | `/api/value/analyze` | 运行规则引擎，返回 valueFlag/signals/score |
| POST | `/api/value/trigger` | Open Loop — 返回唯一的推荐 Action |
| POST | `/api/value/action` | 执行 Action（extract_tables / ocr_text / convert_word） |
| POST | `/api/value/event` | 追踪事件 → 持久化到 MemoryDB |
| GET | `/api/value/metrics` | 实验看板数据（upload_volume / yes_ratio / click_rate） |
| GET | `/api/value/download/:filename` | 下载 Action 执行结果 |

---

*PDFSail V13 — 从 PDF 工具到 SaaS Growth Machine 到 Document Value Detection System*
