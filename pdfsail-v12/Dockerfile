# Render Docker 部署 — PDFSail V12/V13
#
# 单镜像方案：Node.js + Express serve 前端 dist/ 静态文件 + 后端 API
#
# 使用方法：
#   1. Render 控制台 → New → Web Service → 连接 GitHub 仓库
#   2. Environment 选 "Docker"
#   3. Render 会自动读取此 Dockerfile
#   4. 设置环境变量 STRIPE_KEY / PAYPAL_CLIENT_ID / PAYPAL_SECRET（可选，缺失则 mock 模式）
#
# Render 会自动注入 PORT 环境变量，server.ts 已读取 process.env.PORT

FROM node:18-alpine

WORKDIR /app

# 复制依赖声明文件
COPY package*.json ./

# 安装全部依赖（包括 devDependencies，因为 build 需要 tsc / vite）
RUN npm install

# 复制源码
COPY . .

# 构建前端静态文件到 dist/
RUN npm run build

# 生产模式标志（server.ts 据此 serve dist/ 静态文件 + SPA fallback）
ENV NODE_ENV=production
# CORS 允许所有来源（部署后可改为实际域名）
ENV CORS_ORIGIN=*

# Render 自动注入 PORT；EXPOSE 仅作声明
EXPOSE 3001

# 启动 Express server
CMD ["npm", "run", "server"]
