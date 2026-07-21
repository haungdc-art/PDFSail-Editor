# PDFSail V13 操作手册

> **适用对象**: 开发/运维/运营人员
> **版本**: 13.0.0 | **最后更新**: 2026-07-02

---

## 目录

1. [快速启动](#1-快速启动)
2. [环境配置](#2-环境配置)
3. [日常操作流程](#3-日常操作流程)
4. [PDF 编辑器操作](#4-pdf-编辑器操作)
5. [SEO 系统操作](#5-seo-系统操作)
6. [竞品劫持系统操作](#6-竞品劫持系统操作)
7. [A/B 测试操作](#7-ab-测试操作)
8. [广告优化操作](#8-广告优化操作)
9. [调度系统操作](#9-调度系统操作)
10. [API 调用示例](#10-api-调用示例)
11. [生产部署](#11-生产部署)
12. [故障排查](#12-故障排查)
13. [附录](#13-附录)

---

## 1. 快速启动

### 1.1 首次运行

```bash
# 进入项目目录
cd pdfsail-v12

# 安装依赖
npm install

# 启动开发环境 (前端 + 后端同时启动)
npm start
```

启动后：
- **前端**: http://localhost:5173
- **后端 API**: http://localhost:3001/api
- **健康检查**: http://localhost:3001/api/health

### 1.2 快速验证

```bash
# 1. 检查服务是否运行
curl http://localhost:3001/api/health

# 2. 检查 V13 系统状态
curl http://localhost:3001/api/v13/status

# 3. 构建所有页面（SEO + 竞品 + A/B测试 + 广告）
curl -X POST http://localhost:3001/api/v13/build

# 4. 启动所有定时任务
curl -X POST http://localhost:3001/api/v13/start
```

### 1.3 分步启动（故障排查用）

```bash
# 仅启动后端
npm run server

# 仅启动前端（需要后端已在运行）
npm run dev

# 先构建再预览
npm run build
npm run preview
```

---

## 2. 环境配置

### 2.1 环境变量

创建 `.env` 文件（位于项目根目录）：

```bash
# Stripe 支付配置（必选 - 启用付费功能）
STRIPE_KEY=sk_test_xxxxxxxxxxxxxxxxxxxx

# Stripe Webhook 密钥（用于支付回调验证）
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxx

# CORS 允许的前端域名
CORS_ORIGIN=http://localhost:5173

# 后端端口
PORT=3001

# 数据库持久化路径
DB_PATH=./data/db.json
```

**无 Stripe 密钥时的行为**: 系统以 Mock 模式运行，支付功能返回模拟数据，不会实际扣款。

### 2.2 配置文件

| 文件 | 用途 | 关键配置 |
|---|---|---|
| `vite.config.ts` | 前端构建 | API 代理到 localhost:3001 |
| `tsconfig.json` | TypeScript | 路径别名 @shared |
| `package.json` | 依赖和脚本 | dev/server/start 命令 |

---

## 3. 日常操作流程

### 3.1 运营日报操作

```
每日启动:
  1. npm start                    # 启动服务
  2. curl /api/v13/start          # 启动定时任务
  3. curl /api/v13/system/status  # 检查系统状态

运营检查:
  4. curl /api/v13/abtest/results?name=landing-hero
     → 查看A/B测试结果，哪个标题CTR最高
  
  5. curl -X POST /api/v13/optimizer/decide-batch
     → 获取广告优化建议（哪些停、哪些扩）
  
  6. curl /api/v13/conversion/trend
     → 整体转化趋势（improving/declining/stable）
  
  7. curl /api/v13/seo/expand
     → 生成新SEO页面（检查覆盖情况）
```

### 3.2 周度运营流程

```
周一:
  - 检查 A/B 测试结果，将胜出标题部署到生产
  - 分析上週广告ROI，调整关键词出价

周三:
  - 检查竞品页面排名（Google Search Console）
  - 添加新竞品到 COMPETITOR_LIST

周五:
  - 全系统健康检查
  - 检查数据库大小和持久化文件
  - 规划下周新增关键词
```

---

## 4. PDF 编辑器操作

### 4.1 前端操作

**访问**: 打开 http://localhost:5173/editor

**步骤**:

```
1. 点击 "Upload PDF" 按钮 → 选择 PDF 文件
2. 等待文件上传完成 → 左侧出现空白画布
3. 添加编辑块:
   - 点击 "+ Text" → 添加可编辑文本框
   - 点击 "+ Image" → 添加图片占位块
   - 点击 "+ Highlight" → 添加高亮区域
4. 拖拽块 → 按住鼠标左键移动位置
5. 编辑文本块 → 双击文本内容直接编辑
6. 删除块 → 双击块（高亮删除）
7. 导出 → 点击 "Export PDF"
   - 免费版: 每日前3次免费导出
   - 超出限制: 跳转到 Stripe 支付 ($1.99)
```

**注意事项**:

- 画布尺寸 800×1050px (对应 A4 比例)
- 文本块使用 `contentEditable`，支持富文本
- 拖拽坐标基于 `clientX/clientY`，相对于画布定位
- 导出使用 pdf-lib 在服务端将 Block 数据绘制到 PDF 页面

### 4.2 后端 API 测试

```bash
# 上传测试
curl -X POST http://localhost:3001/api/upload \
  -F "file=@test.pdf" \
  -H "Content-Type: multipart/form-data"

# 响应
{
  "fileId": "uuid-xxx",
  "fileName": "test",
  "totalPages": 1,
  "size": 12345
}

# 导出测试 (fileId 使用上传返回的 ID)
curl -X POST http://localhost:3001/api/export \
  -H "Content-Type: application/json" \
  -d '{
    "fileId": "uuid-xxx",
    "format": "pdf",
    "pages": [1],
    "blocks": [{
      "pageNumber": 1,
      "blocks": [{
        "id": "b1",
        "type": "text",
        "page": 1,
        "x": 100,
        "y": 100,
        "w": 200,
        "h": 40,
        "content": "Hello PDF"
      }]
    }]
  }'
```

---

## 5. SEO 系统操作

### 5.1 查看现有 SEO 页面

```bash
# 获取所有预定义 SEO 页面
curl http://localhost:3001/api/v13/seo/pages

# 查看 sitemap 格式
curl http://localhost:3001/api/seo/sitemap
```

### 5.2 生成新页面

```bash
# 从自定义关键词生成
curl -X POST http://localhost:3001/api/v13/seo/generate \
  -H "Content-Type: application/json" \
  -d '{
    "keywords": ["extract pdf images", "pdf metadata editor", "compare pdf files"]
  }'

# 扩展生成 1500+ 页面（从 20 个 base keywords）
curl -X POST http://localhost:3001/api/v13/seo/expand
# 响应: { "total": 1500, "sample": [...] }
```

### 5.3 修改 SEO 模板

编辑 `growth/seo/generator.ts`:

```typescript
// 修改标题模板（第18-26行）
const titleTemplates = [
  "Free online {keyword} tool — No signup needed",
  "Best way to {keyword} in seconds",
  // 添加您的自定义模板
  "{keyword} online — {year} best free tool",  // 新增
];

// 修改内容模板（第46-86行）
const contentSections = [
  // 添加新的内容区块
  `<h2>Step-by-Step Guide to {keyword}</h2>
   <ol>
     <li>Visit PDFSail.com</li>
     <li>Upload your file</li>
     <li>Click to {keyword}</li>
     <li>Download your result</li>
   </ol>`,
];
```

### 5.4 添加新 Base Keywords

编辑 `growth/seo/generator.ts` 中的 `PREDEFINED_KEYWORDS`:

```typescript
export const PREDEFINED_KEYWORDS = [
  // ... 现有 ...
  { 
    keyword: "anonymize PDF online",
    category: "security",
    volume: 4000,
    difficulty: 15,
  },
];
```

扩展机制会自动为新关键词生成动作 + 限定词的组合。

### 5.5 监控 SEO 效果

```bash
# 查看生成页面总数
curl http://localhost:3001/api/v13/db/seo_pages
# 响应: { "total": 150, "docs": [...] }
```

建议配合 Google Search Console 监控：
1. 提交 sitemap URL: `https://yourdomain.com/api/seo/sitemap`
2. 定期检查各页面索引状态
3. 跟踪核心关键词排名变化

---

## 6. 竞品劫持系统操作

### 6.1 查看竞品页面

```bash
curl http://localhost:3001/api/v13/competitor/pages
```

### 6.2 生成新竞品页面

```bash
# 为指定竞品生成
curl -X POST http://localhost:3001/api/v13/competitor/generate \
  -H "Content-Type: application/json" \
  -d '{
    "competitors": ["DocFly", "PDFSimpli", "PDFPro"]
  }'
```

### 6.3 添加新竞品

编辑 `growth/competitor/generator.ts` 中的 `COMPETITOR_LIST`:

```typescript
export const COMPETITOR_LIST = [
  // ... 现有 ...
  "DocFly",          // 新增
  "PDFPro",          // 新增
];
```

新增竞品后，重新调用 `/api/v13/competitor/generate` 即可生成页面。

### 6.4 自定义竞品内容

编辑 `growth/competitor/generator.ts` 中的 `generateCompetitorPage` 函数：

```typescript
// 可以为特定竞品定制不同的对比点
const content = `
<h1>${name} Alternative</h1>
<p>Looking for a faster, simpler, and truly free alternative to ${name}?</p>

// 添加专属优势描述
<h2>Why switch from ${name} to PDFSail?</h2>
<ul>
  <li>✅ No signup or account required</li>
  <li>✅ No watermark on your documents</li>
  <li>✅ 100% browser-based — nothing to install</li>
</ul>
`;
```

---

## 7. A/B 测试操作

### 7.1 创建 A/B 测试

```bash
# 创建着陆页标题测试
curl -X POST http://localhost:3001/api/v13/abtest/create \
  -H "Content-Type: application/json" \
  -d '{
    "name": "landing-hero",
    "titles": [
      "Your Complete PDF Toolkit — Free",
      "Edit PDF Free Without Signup",
      "Fastest PDF Tool in Your Browser",
      "Best PDF Editor Online — No Limits"
    ]
  }'

# 响应: { "success": true, "testName": "landing-hero", "variants": [...] }
```

### 7.2 记录展示和点击

```bash
# 用户看到页面时（前端调用）
curl -X POST http://localhost:3001/api/v13/abtest/impression \
  -H "Content-Type: application/json" \
  -d '{
    "testName": "landing-hero",
    "variantId": "ab-xxxx"
  }'

# 用户点击 CTA 时（前端调用）
curl -X POST http://localhost:3001/api/v13/abtest/click \
  -H "Content-Type: application/json" \
  -d '{
    "testName": "landing-hero",
    "variantId": "ab-xxxx"
  }'
```

### 7.3 查看测试结果

```bash
curl "http://localhost:3001/api/v13/abtest/results?name=landing-hero"

# 响应示例
{
  "testName": "landing-hero",
  "totalImpressions": 1200,
  "totalClicks": 48,
  "best": {
    "id": "ab-xxx",
    "title": "Edit PDF Free Without Signup",
    "clicks": 18,
    "impressions": 300,
    "startDate": 1720000000000
  },
  "variants": [
    { "variantId": "ab-xxx", "title": "Edit PDF Free Without Signup", "ctr": 0.06, "isWinner": true },
    { "variantId": "ab-yyy", "title": "Best PDF Editor Online", "ctr": 0.045, "isWinner": false },
    { "variantId": "ab-zzz", "title": "Your Complete PDF Toolkit", "ctr": 0.035, "isWinner": false },
    { "variantId": "ab-www", "title": "Fastest PDF Tool in Browser", "ctr": 0.03, "isWinner": false }
  ]
}
```

### 7.4 前端集成示例

在 SEO 页面中添加 A/B 测试代码：

```tsx
// 前端调用示例
const assignVariant = (testName: string, variants: string[]) => {
  const stored = localStorage.getItem(`ab_${testName}`);
  if (stored) return stored;
  
  const idx = Math.floor(Math.random() * variants.length);
  localStorage.setItem(`ab_${testName}`, variants[idx]);
  return variants[idx];
};

const trackImpression = async (testName: string, variantId: string) => {
  await fetch('/api/v13/abtest/impression', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ testName, variantId }),
  });
};
```

### 7.5 预设测试模板

系统预置了以下测试模板（位于 `growth/abtest/engine.ts`）：

```typescript
TITLE_TEST_TEMPLATES = {
  "editor-cta": [...],     // 编辑器CTA测试
  "merge-cta": [...],      // 合并页面CTA测试
  "landing-hero": [...],   // 首页大标题测试
}
```

---

## 8. 广告优化操作

### 8.1 注册广告活动

```bash
# 注册一个新的 Google Ads 活动
curl -X POST http://localhost:3001/api/ads/campaign \
  -H "Content-Type: application/json" \
  -d '{
    "id": "camp-google-001",
    "name": "PDF Editor - Google Ads",
    "platform": "google",
    "spend": 500,
    "clicks": 120,
    "impressions": 5000,
    "conversions": 15,
    "revenue": 750,
    "status": "ACTIVE",
    "dailyBudget": 50
  }'
```

### 8.2 查询广告分析

```bash
# 查看所有活动分析
curl http://localhost:3001/api/ads/analyze

# 分析单个活动
curl http://localhost:3001/api/ads/analyze/camp-google-001
```

### 8.3 执行自动优化

```bash
# 自动优化所有活动
curl -X POST http://localhost:3001/api/ads/optimize

# 响应示例
{
  "success": true,
  "scaled": 1,          # 扩量活动数
  "stopped": 2,         # 暂停活动数
  "scaledCampaigns": ["camp-google-002"],
  "stoppedCampaigns": ["camp-google-003", "camp-google-004"]
}
```

### 8.4 使用 V13 AutoOptimizer

```bash
# 单次决策
curl -X POST http://localhost:3001/api/v13/optimizer/decide \
  -H "Content-Type: application/json" \
  -d '{
    "clicks": 150,
    "conversions": 15,
    "context": {
      "page": "compress-pdf-landing",
      "campaignId": "camp-123",
      "currentSpend": 200
    }
  }'

# 响应
{
  "action": "SCALE_ADS",
  "reason": "CVR 10.00% exceeds threshold 8.00%. Scaling budget by 25%.",
  "scaleFactor": 1.25
}

# 批量决策
curl -X POST http://localhost:3001/api/v13/optimizer/decide-batch \
  -H "Content-Type: application/json" \
  -d '{
    "campaigns": [
      { "id": "c1", "name": "Camp A", "clicks": 200, "conversions": 2, "spend": 300 },
      { "id": "c2", "name": "Camp B", "clicks": 150, "conversions": 18, "spend": 200 },
      { "id": "c3", "name": "Camp C", "clicks": 120, "conversions": 6, "spend": 150 }
    ]
  }'
```

### 8.5 优化策略说明

| ROAS 范围 | 操作 | 说明 |
|---|---|---|
| < 1.0x | STOP | 亏损，暂停活动止损 |
| 1.0x - 2.0x | HOLD | 盈亏平衡，优化创意 |
| ≥ 2.0x | SCALE | 赚钱，预算增加25% |

| CVR 范围 | 操作 | 说明 |
|---|---|---|
| < 1% | PAUSE_ADS | 页面转化差，停止广告 |
| 1% - 8% | HOLD | 正常范围，建议优化 |
| > 8% | SCALE_ADS | 优异表现，扩大投放 |

**建议**: 同时使用 AdsOptimizer (V12) 和 AutoOptimizer (V13)：
- AdsOptimizer: 按 ROAS 做预算分配
- AutoOptimizer: 按 CVR 做广告启停决策

---

## 9. 调度系统操作

### 9.1 查看调度器状态

```bash
curl http://localhost:3001/api/v13/scheduler/status

# 响应
{
  "status": "running",
  "jobs": [
    { "id": "seo-generator", "name": "SEO Page Generator", "runCount": 5, "lastRun": 1720000000000, "intervalMs": 86400000 },
    { "id": "competitor-generator", "name": "Competitor Page Generator", "runCount": 3, "lastRun": 1720000000000, "intervalMs": 86400000 },
    { "id": "ads-optimizer", "name": "Ads ROI Optimizer", "runCount": 12, "lastRun": 1720000000000, "intervalMs": 21600000 },
    { "id": "maintenance", "name": "Daily Maintenance", "runCount": 3, "lastRun": 1720000000000, "intervalMs": 86400000 }
  ]
}
```

### 9.2 启动/停止调度器

```bash
# 启动所有定时任务
curl -X POST http://localhost:3001/api/v13/scheduler/start

# 停止所有定时任务
curl -X POST http://localhost:3001/api/v13/scheduler/stop
```

### 9.3 自定义调度任务

在 `growth/scheduler.ts` 中添加新任务：

```typescript
import { scheduler } from "./scheduler.js";

// 注册自定义任务
scheduler.register({
  id: "my-custom-job",
  name: "My Custom Job",
  intervalMs: 1000 * 60 * 60, // 每小时
  fn: async () => {
    console.log("[Custom Job] Running...");
    // 您的逻辑
  },
});

// 启动
scheduler.start("my-custom-job");
```

### 9.4 调度间隔参考

| 间隔 | ms 值 | 适用场景 |
|---|---|---|
| 1分钟 | 60000 | 高频监控 |
| 1小时 | 3600000 | 广告优化 |
| 4小时 | 14400000 | 内容更新检查 |
| 6小时 | 21600000 | 广告ROI分析 |
| 24小时 | 86400000 | SEO生成、维护 |

---

## 10. API 调用示例

### 10.1 完整运营流程

```bash
#!/bin/bash
# daily-operations.sh — 每日运营脚本

API="http://localhost:3001/api"

echo "=== PDFSail V13 每日运营检查 ==="

# 1. 系统健康
echo "[1/7] 健康检查..."
curl -s $API/health | jq .

# 2. 系统状态
echo "[2/7] V13 系统状态..."
curl -s $API/v13/system/status | jq .

# 3. 广告分析
echo "[3/7] 广告活动分析..."
curl -s $API/ads/analyze | jq '.analyses[] | {campaignName, roas, action}'

# 4. 自动优化
echo "[4/7] 自动优化..."
curl -s -X POST $API/ads/optimize | jq .

# 5. A/B 测试结果
echo "[5/7] A/B 测试..."
curl -s "$API/v13/abtest/results?name=landing-hero" | jq .

# 6. 转化趋势
echo "[6/7] 转化趋势..."
curl -s $API/v13/conversion/trend | jq .

# 7. SEO 生成
echo "[7/7] 扩展 SEO 页面..."
curl -s -X POST $API/v13/seo/expand | jq '.total'

echo "=== 完成 ==="
```

### 10.2 PowerShell 运营脚本 (Windows)

```powershell
# daily-operations.ps1
$api = "http://localhost:3001/api"

Write-Host "=== PDFSail V13 每日运营检查 ===" -ForegroundColor Cyan

Write-Host "[1/7] 健康检查..."
Invoke-RestMethod -Uri "$api/health" | ConvertTo-Json

Write-Host "[2/7] V13 系统状态..."
Invoke-RestMethod -Uri "$api/v13/system/status" | ConvertTo-Json

Write-Host "[3/7] 广告活动分析..."
$campaigns = Invoke-RestMethod -Uri "$api/ads/analyze"
$campaigns.analyses | Select-Object campaignName, roas, action

Write-Host "[4/7] 自动优化..."
Invoke-RestMethod -Uri "$api/ads/optimize" -Method Post | ConvertTo-Json

Write-Host "=== 完成 ===" 
```

### 10.3 cURL 对前端 API 的完整调用

```bash
# ===== SEO 页面 =====
# 获取所有页面
curl -s http://localhost:3001/api/seo/pages | jq '.pages | length'

# 获取特定关键词页面
curl -s http://localhost:3001/api/seo/page/compress%20PDF | jq .

# 获取 sitemap
curl -s http://localhost:3001/api/seo/sitemap | jq '.[:5]'

# ===== 竞价劫持 =====
# 访问竞品页面（浏览器打开）
open http://localhost:5173/smallpdf-alternative
open http://localhost:5173/ilovepdf-alternative

# ===== 商业 =====
# 查看使用量
curl -s http://localhost:3001/api/billing/usage
```

---

## 11. 生产部署

### 11.1 构建部署

```bash
# 构建前端
npm run build
# 输出到 dist/ 目录

# 启动生产服务
NODE_ENV=production STRIPE_KEY=sk_live_xxx npm run server
```

### 11.2 部署架构建议

```
                        Cloudflare CDN
                             │
              ┌──────────────┴──────────────┐
              │                             │
         静态资源 (/dist)              API 代理
              │                             │
              ▼                             ▼
         Vercel/Netlify              Node.js Server
         (托管前端)                    (Express on 3001)
                                          │
                                    ┌─────┴─────┐
                                    │           │
                                Stripe     OCR Worker
```

### 11.3 Vercel 部署 (前端)

在 `vercel.json` 中配置：

```json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "rewrites": [
    { "source": "/api/(.*)", "destination": "https://your-api.com/api/$1" }
  ]
}
```

### 11.4 Node.js 服务器部署 (后端)

```bash
# 使用 PM2 管理进程
npm install -g pm2
pm2 start backend/server.ts --interpreter tsx --name pdfsail-api
pm2 save
pm2 startup

# 日志查看
pm2 logs pdfsail-api
pm2 monit
```

### 11.5 环境变量检查清单

生产部署前确认：

```bash
- [ ] STRIPE_KEY 已设置为生产密钥
- [ ] STRIPE_WEBHOOK_SECRET 已配置
- [ ] CORS_ORIGIN 设置为实际域名
- [ ] PORT 设置为 3001 或其他端口
- [ ] DB_PATH 设置为持久化路径
- [ ] uploads/ 目录存在且有写入权限
- [ ] Node.js 版本 ≥ 18
- [ ] 反向代理已配置（Nginx/Caddy）
```

---

## 12. 故障排查

### 12.1 常见问题

| 问题 | 可能原因 | 解决 |
|---|---|---|
| 前端白屏 | 后端未启动 | 运行 `npm run server` |
| API 返回 502 | 后端崩溃 | 检查 pm2 status，重启服务 |
| 上传失败 | uploads/ 目录缺失 | 创建 `mkdir uploads` |
| Export 失败 | pdf-lib 文件缺失 | 检查上传文件是否在 uploads/ 目录 |
| Stripe 错误 | 密钥无效 | 检查 `STRIPE_KEY` 环境变量 |
| OCR 失败 | 未安装 Tesseract | 暂不影响核心功能，可跳过 |
| Scheduler 不运行 | 未调用 start | 调用 `POST /api/v13/scheduler/start` |
| A/B 测试无数据 | 未跟踪事件 | 检查前端是否调用了 trackImpression/trackClick |

### 12.2 TypeScript 编译错误

```bash
# 完整类型检查
npx tsc --noEmit

# 常见错误修复
# 1. 找不到模块 → 检查 import 路径是否正确
# 2. 类型不匹配 → 检查 shared/types.ts 中的类型定义
# 3. JSX 错误 → 确保文件扩展名是 .tsx
```

### 12.3 日志检查

```bash
# 后端日志
pm2 logs pdfsail-api

# 调度器日志
# 在 growth/scheduler.ts 中，每个 job 都有 console.log 输出

# 广告优化日志
# adsOptimizer.autoOptimize() 会打印：
# [AdsOptimizer] STOPPED campaign-name (ROAS: x.xx)
# [AdsOptimizer] SCALING campaign-name budget to $N/day
```

### 12.4 调试模式

```bash
# 启动后端并手动触发所有任务
cd pdfsail-v12
npx tsx backend/server.ts

# 在另一个终端手动触发
curl -X POST http://localhost:3001/api/v13/build
curl -X POST http://localhost:3001/api/v13/start
curl -X POST http://localhost:3001/api/ads/optimize
```

---

## 13. 附录

### 13.1 关键文件路径

| 功能 | 文件路径 |
|---|---|
| 应用入口 | `frontend/src/App.tsx` |
| 路由定义 | `frontend/src/routing/routes.tsx` |
| PDF 编辑器 | `frontend/src/editor/PDFEditor.tsx` |
| SEO 页面组件 | `frontend/src/landing/SEOPage.tsx` |
| 竞品页面组件 | `frontend/src/landing/CompetitorPage.tsx` |
| 后端服务 | `backend/server.ts` |
| V13 API 路由 | `backend/v13.ts` |
| SEO 生成器 | `growth/seo/generator.ts` |
| 竞品生成器 | `growth/competitor/generator.ts` |
| A/B 测试引擎 | `growth/abtest/engine.ts` |
| 转化优化引擎 | `growth/conversion/engine.ts` |
| 广告 ROI 优化 | `growth/adsOptimizer.ts` |
| 调度器 | `growth/scheduler.ts` |
| 系统编排器 | `growth/system.ts` |
| 关键字数据 | `shared/keywords.ts` |
| 类型定义 | `shared/types.ts` |
| Stripe 封装 | `billing/stripe.ts` |
| OCR 工作线程 | `worker/ocr.ts` |

### 13.2 端口号参考

| 服务 | 端口 | 说明 |
|---|---|---|
| Vite 前端 | 5173 | 开发服务器 |
| Express 后端 | 3001 | API 服务器 |
| Stripe | 443 | 外部 HTTPS |

### 13.3 速查命令

```bash
npm install        # 安装依赖
npm start          # 同时启动前后端
npm run dev        # 仅前端
npm run server     # 仅后端
npm run build      # 生产构建
npm run preview    # 预览构建
npx tsc --noEmit   # 类型检查
```

### 13.4 升级流程 (V12 → V13)

V13 向后兼容 V12：
- 旧的 `growth/*.ts` 文件已移至模块化子目录
- API 端点完全保留 (`/api/ads/*`, `/api/seo/*` 照常工作)
- 新的 V13 端点在 `/api/v13/*`
- 旧的 `seoEngine.ts` / `competitorEngine.ts` 已被删除，替换为模块化版本

### 13.5 扩展计划

- 接入真实 Google Ads API（自动同步广告数据）
- 接入 Google Search Console API（自动监控排名）
- 添加 PDF 渲染（pdfjs-dist 在画布显示原始 PDF）
- 添加用户认证（Supabase Auth / Auth0）
- 替换内存数据库为 PostgreSQL
- 添加邮件通知（SEO 报告、广告告警）
- 添加日志面板（Web UI 查看系统状态）

---

*PDFSail V13 — 从启动到自动运营的完整操作指南*
