# AGENTS.md

本文件是 AI 编码代理与协作者在本仓库的最高行动准则。**任何变更都必须同时满足：架构宪法 → 研发标准 → 分支标准。** 三者冲突时以本文件为准；本文件未覆盖的以 `docs/技术架构-v0.1.md` 与 `ADR/` 为准。

## 1. 架构宪法（不可违背）

零依赖 Node 24 原生方案（原生 ESM + `node:test` + `node:http` + `node:sqlite`，见 ADR-001），单体 Docker 部署。

| 原则 | 含义 |
|---|---|
| 内核纯函数 | `packages/core` 不碰 I/O/LLM/时间；同输入+同种子 → 同输出 |
| 内容即数据 | 一切设计参数住 `content/`（JSON），改数值不动代码 |
| 测试即设计 | 机制先写业务场景测试（红），再实现（绿） |
| LLM 可拔插 | LLM 全挂仍可玩（直读降级）；e2e 不依赖真实 LLM |
| 模块化单体 | 单进程单库，workspace 严格分层 |

**依赖方向强制单向**：`web → shared ← server → {core, content, llm, sim} → shared`。禁止反向 import。

**LLM 边界**：LLM 只产出文本或结构化意图建议，对游戏状态的写入权为零（LLM 提议 → 内核裁决 → LLM 演出）。

## 2. 研发标准（每次变更的完成定义）

变更循环：`场景测试(红) → 实现/内容改动(绿) → 自测通过 → PR 评审`。

1. **TDD**：新机制先补 `test/scenario/` 或 `test/unit/` 场景测试再写实现；测试用游戏业务语言命名。
2. **测试命令**：合并前本地跑 `npm test`（单测+属性+场景+LLM 回放+e2e 全量），全绿才允许开 PR。内核改动另跑 `npm run test:core`。
3. **确定性**：引入随机性必须走调用方注入的种子 RNG；内核内禁止 `Math.random()`/`Date.now()`。
4. **数据库变更**：落 `packages/server/migrations/NNN-名称.sql`，事务内执行、幂等；提交前 `npm run migrate:status` 必须通过（ADR-002）。内容包改动不走 schema 迁移。
5. **内容包变更**：改 `content/` 数值/提示词/文案 → 内容包升 semver；触达 `core` 或 `content` 的 PR 须附 sim 平衡报告（KPI 阈值见 `content/base/kpis.json`，越带须显式修改并附设计说明）。
6. **提示词变更**：改 `content/base/prompts/` 须带金样本/评测断言（意图解析准确率、越界拒绝、封印泄漏），不允许纯文本改动无验证。
7. **零依赖**：新增 npm 依赖视为架构例外，必须先在 ADR 中记录理由并获批准，否则一律用 Node 原生能力。
8. **配置与密钥**：env 单入口 + fail-fast 校验；密钥（`api_key_enc`、`MASTER_KEY`）不进库、不回显。

## 3. 分支标准（唯一提交流程）

```
feat/fix 分支 → PR → dev → PR → main
```

| 分支 | 用途 | 规则 |
|---|---|---|
| `main` | 稳定主线，仅接受 `dev` 的合并 | 受保护，禁直接 push |
| `dev` | 开发主线，日常集成 | 受保护，禁直接 push |
| `feat/<name>` / `fix/<name>` | 单功能/修复的短命分支 | 从 `dev` 拉出，合并后自动删除 |

执行细则：

1. 从 `dev`（不是 `main`）拉分支，命名 `feat/<功能>` 或 `fix/<问题>`，小写连字符（如 `feat/save-system`）。
2. 完成自测后开 PR 到 `dev`；审批 0 人可自行合并，但合并前 `npm test` 必须全绿。
3. 合入 `dev` 后源分支被自动删除，**禁止复用已合并分支**，下次重新拉。
4. 发布时开 `dev → main` 的 PR（`dev` 受删除保护，合并后不会被删）。
5. 禁止任何形式的直接 push、force push、删除受保护分支；禁止绕过 `dev` 直接把 feature 分支合到 `main`。
6. 紧急热修复例外：可从 `main` 拉 `fix/` 分支 PR 回 `main`，同时必须同步合入 `dev`。

## 4. AI 代理特别约束

- 改动前先定位分层归属：数值/文案 → `content/`；规则逻辑 → `core/`；接入与编排 → `server/`；界面 → `web/`。跨层改动在 PR 描述中说明。
- 不许为图省事绕过测试或降级要求；不许引入未批准的依赖；不许修改 `main`/`dev` 历史。
- 评审内容三合一：设计 diff（GDD/内容）+ 代码 diff + 测试/平衡报告 diff，缺任何一项的 PR 不得合并。
