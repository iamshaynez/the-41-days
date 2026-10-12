# 《第 41 天》单镜像部署（ADR-001：零依赖 Node 方案，无 node_modules）
# 发版流程：容器启动 → npm run migrate（显式迁移，幂等）→ 起服务（schema 落后则拒启）
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV DB_PATH=/app/data/game.db
ENV PORT=3000
ENV ADMIN_PASSWORD=war-admin

# 源码（内容包 + 包 + 前端静态 + 测试与迁移）
COPY package.json ./
COPY content/ ./content/
COPY packages/ ./packages/
COPY test/ ./test/

# 数据卷
RUN mkdir -p /app/data
VOLUME /app/data

EXPOSE 3000

# 启动序：显式迁移（幂等，带 --status 可预检）→ 起服务；exec 让 node 直接接管 SIGTERM
CMD ["sh", "-c", "npm run migrate && exec node packages/server/index.js"]
