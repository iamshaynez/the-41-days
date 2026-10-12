# ADR-001：v1 实现技术取舍（零依赖 Node 方案）

日期：2026-10-11 ｜ 状态：已接受

## 背景

技术架构 v0.1 规划的栈为 TypeScript + Vitest + Fastify + Drizzle + better-sqlite3 +
React/Vite + Playwright。本仓库 v1 交付采用**零外部依赖的 Node 24 原生方案**。

## 决策与理由

| 规划 | v1 实现 | 理由 |
|---|---|---|
| TypeScript | 原生 ESM JavaScript + JSDoc 类型注释 | 无构建步骤，`node --test` 直接跑；分层与契约不变，迁移 TS 时 JSDoc 即类型底稿 |
| Vitest | `node:test`（Node 内置） | 零安装、确定性执行、子测试/断言齐全 |
| Fastify + SSE 库 | `node:http` + 手写路由 + 手写 SSE | 路由面小（<20 端点），SSE 协议简单，减一层依赖面 |
| Drizzle + better-sqlite3 | `node:sqlite`（Node 22.5+ 内置） | 无原生编译环节；WAL/预编译语句用法一致；schema 迁移手写版本化 |
| React + Vite | 原生 ES Modules SPA（无构建） | 界面为强文本流+阶段版式，DOM 面可控；UI 设计文档的词汇表（晨报/剖面/火柴）全部保留 |
| Playwright | HTTP 级 e2e（fetch 直打 API + 断言 SSE 流）+ 组件状态矩阵单测 | 无浏览器二进制依赖；前端渲染逻辑与数据渲染函数分离以便测试 |

不变的承诺（架构宪法）：内核纯函数、内容即数据、事件溯源、LLM 提议-内核裁决-LLM 演出、
直读降级、按用途路由、随机性宪章、KPI 门禁。

## 后果

- 单 Docker 镜像更薄（node:24-alpine + 源码，无 node_modules）。
- 升级路径：包边界（core/content/llm/server/web/sim）与技术架构 §3 完全一致，
  后续引入 TS/Vitest 只动构建层不动分层。
- Playwright 视觉回归留待 v1.x（见 UI 设计 §12）。
