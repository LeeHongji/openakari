# Akari Architecture

> 本文档描述 akari 的完整技术架构。任何框架改动必须同步更新本文件。
>
> 最后更新：2026-03-14

---

## 1. 系统定位

akari（明かり）是一个由 LLM agent 自主运营的研究组。这个 monorepo 既是代码库，也是 agent 的持久记忆——repo 就是 agent 的大脑。

**核心不对称性**：人类研究员有跨会话记忆，LLM agent 没有。所有设计决策都源于这个不对称。

## 2. 技术栈

| 层 | 技术 | 版本 | 用途 |
|---|------|------|------|
| 运行时 | Node.js | v25.7.0 | scheduler 主进程 |
| 语言 | TypeScript | 5.9.3 | 全部 scheduler 代码 |
| 构建 | tsc (直接编译) | — | src/ → dist/，无 bundler |
| 测试 | vitest | 4.0.18 | 单元测试 + 集成测试 |
| 进程管理 | pm2 | — | 守护进程，崩溃自动重启 |
| Slack 集成 | @slack/bolt | 4.6.0 | Socket Mode，实时消息 |
| 定时调度 | croner | 9.0.0 | cron 表达式解析 |
| 数据库 | better-sqlite3 | 12.6.2 | opencode 后端会话成本查询 |
| 图表 | chart.js + chartjs-node-canvas | 4.5.1 / 5.0.0 | Slack 内联报告图表 |
| LLM 后端 | Claude Code CLI | — | `claude -p` 命令行调用 |
| 版本控制 | git | — | 知识持久化 + 协作 |

## 3. 仓库结构

```
openakari/
├── CLAUDE.md                    # agent 行为准则（治理文件，修改需审批）
├── ARCHITECTURE.md              # 本文件
├── APPROVAL_QUEUE.md            # 人类审批队列
├── CHANGELOG.md                 # 版本变更记录
│
├── infra/                       # 基础设施（唯一有代码的地方）
│   ├── scheduler/               # 核心调度器（本架构的主体）
│   │   ├── src/                 # TypeScript 源码 (~90,000 行)
│   │   ├── dist/                # 编译产物
│   │   ├── package.json         # 依赖定义
│   │   └── tsconfig.json        # TS 配置
│   ├── experiment-runner/       # 实验启动器（Python）
│   └── experiment-validator/    # 实验目录校验器（Python）
│
├── projects/                    # 研究项目（每个项目独立目录）
│   └── akari/                   # 元项目：研究 akari 自身的改进
│
├── decisions/                   # ADR 架构决策记录（67 个）
├── docs/                        # 文档（设计理念、SOP、规范）
│   ├── conventions/             # 操作规范
│   ├── schemas/                 # 文件格式模板
│   └── sops/                    # 标准操作流程
│
└── .claude/
    └── skills/                  # agent 技能（25 个）
```

## 4. Scheduler 核心架构

### 4.1 模块总览

```
infra/scheduler/src/
│
├── 入口与控制 ─────────────────────────────────
│   cli.ts              # CLI 入口，命令路由，.env 加载
│   api/server.ts       # HTTP API (localhost:8420)
│   drain-state.ts      # 优雅关闭状态
│   instance-guard.ts   # 单实例锁
│
├── 调度与执行 ─────────────────────────────────
│   store.ts            # Job 持久化 (.scheduler/jobs.json)
│   schedule.ts         # cron 表达式 → 下次执行时间
│   executor.ts         # Job 执行：预检查 → spawn agent → 后处理
│   budget-gate.ts      # 预算门控（所有项目超预算才阻止）
│
├── Agent 调度 ──────────────────────────────────
│   agent.ts            # 统一 spawn 入口，profile 定义，安全守卫
│   sdk.ts              # Claude CLI 封装（-p --output-format stream-json）
│   backend.ts          # 多后端抽象（claude/cursor/opencode）
│   backend-preference.ts # 后端偏好持久化
│
├── Slack 交互 ──────────────────────────────────
│   slack.ts            # Socket Mode 消息接收/发送/通知
│   slack-files.ts      # 文件上传
│   channel-mode.ts     # dev/chat 模式管理
│   thread-mode.ts      # thread 追踪
│
├── 对话系统 ────────────────────────────────────
│   chat/
│   ├── chat.ts         # 对话主循环，action 执行，状态管理
│   ├── chat-context.ts # 上下文加载（系统状态/项目/预算）
│   ├── chat-prompt.ts  # system prompt 构建
│   └── thread-turns.ts # thread 轮次追踪
│
├── Action Tag 系统 ─────────────────────────────
│   action-tags.ts      # tag 解析/剥离/确认提示
│
├── 事件 Agent ──────────────────────────────────
│   event-agents.ts     # deep work / evolution spawn
│
├── 会话管理 ────────────────────────────────────
│   session.ts          # 内存注册，watcher，消息缓冲
│   session-persistence.ts # 磁盘持久化（pm2 重启恢复）
│   session-autofix.ts  # 崩溃会话恢复
│   team-session.ts     # Agent Team 协调
│
├── 自我进化 ────────────────────────────────────
│   evolution.ts        # 进化状态机（pending → validate → apply）
│   worktree.ts         # git worktree 隔离（创建/验证/合并/清理）
│
├── Git 操作 ────────────────────────────────────
│   auto-commit.ts      # 散落文件自动提交
│   rebase-push.ts      # 并发安全推送（push queue + rebase 重试）
│   branch-cleanup.ts   # 清理过期 session-* 分支
│
├── 实验管理 ────────────────────────────────────
│   experiments.ts      # 启动/停止/追踪实验
│   orphan-cleanup.ts   # 废弃实验清理
│
├── 任务管理 ────────────────────────────────────
│   recurring-tasks.ts      # 当 open task < 5 时自动生成维护任务
│   recycled-task-manager.ts # 循环任务管理
│   task-parser.ts          # TASKS.md 解析
│   recommendations.ts     # 任务推荐排序
│
├── 健康监控 ────────────────────────────────────
│   health-watchdog.ts      # 综合健康评分（5 维度加权）
│   anomaly-detection.ts    # 统计异常检测（σ/百分位/阈值）
│   warning-escalation.ts   # 告警升级到 Slack
│   auto-diagnose.ts        # 失败自动诊断
│
├── 验证与合规 ──────────────────────────────────
│   verify.ts               # SOP 合规检查（最大文件，2870 行）
│   security.ts             # shell 命令校验，路径注入防护
│   sleep-guard.ts          # L0 强制：禁止 sleep >30s
│   stall-guard.ts          # L0 强制：shell 命令 >120s 终止
│
├── 技能系统 ────────────────────────────────────
│   skills.ts               # 技能枚举/读取/路由
│   orient-tier.ts          # orient 分级（full vs fast）
│
├── 指标与审计 ──────────────────────────────────
│   metrics.ts              # 交互记录
│   interaction-audit.ts    # 用户交互模式分析
│   role-metrics.ts         # 按模型统计用量
│
├── 报告系统 ────────────────────────────────────
│   report/                 # 运营/研究/项目/实验对比报告
│   notify.ts               # Slack 通知（审批/预算/实验/进化）
│
├── Fleet 系统 ──────────────────────────────────
│   fleet-scheduler.ts      # Fleet 接口定义（实现在 reference-implementations/）
│
└── 共享类型 ────────────────────────────────────
    types.ts                # Job, Schedule, FleetTask 等类型
    constants.ts            # 排除项目列表
    patterns.ts             # 共用正则
```

### 4.2 Agent Profile 体系

| Profile | 模型 | maxTurns | 超时 | 用途 |
|---------|------|----------|------|------|
| `workSession` | opus | 无限制 | 30 min | cron 自主工作 |
| `teamWorkSession` | opus | 256 | 120 min | Agent Team 协作 |
| `chat` | sonnet* | 16 | 2 min | Slack 即时对话 |
| `autofix` | opus | 32 | 10 min | 实验失败自动修复 |
| `deepWork` | opus | 256 | 60 min | 人类触发的深度工作 |
| `skillCycle` | sonnet | 48 | 15 min | 技能执行 |
| `fleetWorker` | opus | 64 | 15 min | Fleet 并行工人 |

*chat 模型可通过 `SLACK_CHAT_MODEL` 环境变量覆盖

### 4.3 后端抽象

支持三个 LLM 后端，自动降级：

```
Claude Code CLI (主力) → Cursor Agent CLI → opencode CLI
```

每个后端有独立的 profile override（如 opencode 有更严格的超时和轮次限制）。

## 5. 两条执行路径

### 5.1 Cron Job 路径（自主工作）

```
30 秒轮询 → getDueJobs()
  │
  ├─ 预检查
  │   ├─ autoCommitOrphanedFiles()      散落文件提交
  │   ├─ checkBudget()                  预算门控
  │   └─ orient 分级决策                 full(首次/每6次) vs fast
  │
  ├─ 执行
  │   └─ spawnAgent(workSession)        opus, SOP: orient→选任务→执行→提交
  │
  └─ 后处理
      ├─ 写日志 .scheduler/logs/
      ├─ autoCommitOrphanedFiles()      再次清理
      ├─ rebaseAndPush()                通过 push queue 序列化
      ├─ verify()                       SOP 合规检查
      └─ Slack 通知完成
```

### 5.2 Slack Chat 路径（人类交互）

```
用户 DM → slack.ts (Socket Mode)
  │
  ├─ 即时处理
  │   ├─ pendingAction? → 检测 yes/no 确认
  │   ├─ 活跃 deep work? → streamInput 转发消息
  │   └─ 常规消息 → 进入 chat 流程
  │
  ├─ Chat 流程
  │   ├─ gatherChatContext()            系统状态 + 项目摘要
  │   ├─ detectRelevantProjects()       识别相关项目
  │   ├─ buildChatPrompt()             构建 prompt + action tag 协议
  │   └─ spawnAgent(chat)              sonnet, 16轮, 2min
  │
  ├─ 流式处理（实时）
  │   ├─ 拦截 Edit/Write → 升级 deep work
  │   ├─ 拦截 Skill 调用 → 升级 deep work
  │   ├─ 解析 action tag → 设置 pendingAction
  │   └─ 安全校验 → 阻止危险命令
  │
  └─ 完成
      ├─ 保存 resumeSessionId           用于 --resume 多轮续接
      ├─ 执行 action                    deep_work/experiment/task/...
      └─ 回复 Slack
```

## 6. Action Tag 系统

Chat agent 通过在回复中嵌入 action tag 来触发系统操作：

### 即时执行（无需确认）
| Tag | 用途 |
|-----|------|
| `[ACTION:deep_work task="..." project="..."]` | 启动 opus 深度工作（60min） |
| `[ACTION:create_task project="..." task="..." done_when="..."]` | 创建 fleet 任务 |
| `[ACTION:stop_session id="..."]` | 终止运行中的会话 |
| `[ACTION:ask_session id="..." message="..."]` | 向活跃会话注入消息 |
| `[ACTION:watch_session id="..."]` | 监听会话输出 |
| `[ACTION:stop_experiment project="..." id="..."]` | 停止实验 |
| `[ACTION:generate_report type="..." ...]` | 生成报告 |
| `[ACTION:send_files paths="..." caption="..."]` | 上传文件 |
| `[ACTION:start_evolution task="..." description="..."]` | 在 worktree 中启动自我修改 |
| `[ACTION:restart]` | 优雅重启 scheduler |

### 需要确认（回复 yes/no）
| Tag | 用途 |
|-----|------|
| `[ACTION:approve item=N]` / `[ACTION:deny item=N]` | 审批队列处理 |
| `[ACTION:launch_experiment project="..." id="..." command="..."]` | 启动实验 |
| `[ACTION:run_job id="..."]` | 手动执行 job |
| `[ACTION:run_burst job="..." ...]` | burst 模式 |
| `[ACTION:fleet_control op="..." size=N]` | Fleet 控制 |
| `[ACTION:approve_evolution]` / `[ACTION:reject_evolution]` | 代码修改审核 |

## 7. 自我进化机制

### 7.1 文件修改权限矩阵

| 范围 | agent 可直接修改 | 需要 worktree review | 需要 APPROVAL_QUEUE |
|------|:---:|:---:|:---:|
| `projects/*/` | ✅ | — | — |
| `.claude/skills/*/` | ✅ | — | — |
| `decisions/` | ✅ | — | — |
| `docs/` | ✅ | — | — |
| `infra/scheduler/src/` | — | ✅ | — |
| `CLAUDE.md` 治理规则 | — | — | ✅ |
| `budget.yaml` 限制 | — | — | ✅ |
| 生产模块代码 | — | — | ✅ |

### 7.2 Worktree 隔离流程

```
触发 → createWorktree()
         │  git worktree add .worktrees/evo-<ts> -b evo/<description>
         ▼
      spawnEvolutionWork()
         │  opus agent 在 worktree 中修改代码
         ▼
      validateWorktree()
         │  tsc --noEmit ✓
         │  vitest run ✓
         │  敏感文件扫描 ✓
         ▼
      getWorktreeDiff() → Slack 发送 diff
         │
         ├─ approve → mergeWorktree() → 合并到 main → 自动重启
         └─ reject  → removeWorktree() → 丢弃
```

### 7.3 安全保障

1. **隔离**：worktree 独立目录，不影响运行中的 main
2. **验证**：tsc + vitest + 敏感文件扫描（.env/credentials/secret/private_key）
3. **人类审核**：Slack 发 diff，等待 approve/reject
4. **单一活跃**：同时只允许一个 evolution worktree
5. **持久化**：`.scheduler/evolution-worktree.json` 跨重启恢复

## 8. Git 操作规则

### 提交
- **自动提交**：session 前后各一次，提交散落的 .md/.yaml/.py/.ts 等文件
- **冷却机制**：5 分钟内不重复提交，除非 ≥3 个文件
- **消息格式**：`[scheduler] auto-commit N orphaned artifact(s) before session`

### 推送
- **Push Queue**：通过 `/api/push/enqueue` 序列化，避免并发冲突
- **Rebase 重试**：`git pull --rebase --autostash`，指数退避，最多 3 次
- **失败兜底**：创建 `session-{id}` 分支推送，人工合并

### 分支清理
- 已合并的 `session-*` 分支：立即删除
- 未合并的 `session-*` 分支：>7 天删除

## 9. 安全守卫（L0 代码强制）

| 守卫 | 检测内容 | 处理方式 |
|------|---------|---------|
| Sleep Guard | `sleep >30s` 的 Bash 命令 | 立即终止会话 |
| Stall Guard | Shell 命令执行 >120s | 立即终止会话 |
| PM2 Guard | `pm2 stop/delete` 命令 | 立即终止会话 |
| Shell Security | 命令注入、危险命令 | 阻止执行 |
| Path Security | 路径遍历攻击 | 阻止执行 |

## 10. 健康监控

### 异常检测
- **统计异常**：成本/时长 >2σ 告警；轮次/时长 >P95 告警
- **上下文利用率**：>80% 警告，>90% 严重
- **预算漂移**：实际消耗 vs 时间线性预期的偏差

### 健康评分（5 维度加权）
| 维度 | 权重 | 含义 |
|------|------|------|
| Orient 开销 | 30% | orient 轮次占总轮次比例 |
| 发现/美元 | 25% | 知识产出效率 |
| 跨项目未命中率 | 20% | 任务选择准确性 |
| 质量回归 | 15% | 验证失败率趋势 |
| 预算漂移 | 10% | 资源消耗偏差 |

### 评分等级
- `healthy` (< 0.17) → `monitor` (0.17-0.56) → `warning` (0.56-0.78) → `critical` (≥ 0.78)

## 11. 技能系统

25 个技能位于 `.claude/skills/`，按能力分类：

| 类别 | 技能 | 工人 |
|------|------|------|
| 战略规划 | orient, orient-simple | Opus |
| 研究执行 | design, lit-review, publish | Opus |
| 诊断分析 | diagnose, postmortem, slack-diagnosis | Opus |
| 知识合成 | synthesize, critique, review | Opus |
| 自我改进 | compound, compound-simple, feedback, gravity | Opus/Fleet |
| 维护运营 | self-audit, audit-references, refresh-skills, report, simplify | Fleet |
| 基础设施 | develop, architecture, project, horizon-scan | Opus |
| 协调 | coordinator (唯一可在 chat 中直接使用) | Sonnet |

## 12. 环境变量

### 必须
```
SLACK_BOT_TOKEN          # Slack Bot Token (xoxb-...)
SLACK_APP_TOKEN          # Slack App Token (xapp-...)
SLACK_USER_ID            # 指定 mentor 的 Slack User ID
```

### 可选
```
SLACK_CHAT_MODEL         # chat agent 模型 (默认: sonnet)
AGENT_BACKEND            # 后端选择 (claude/cursor/opencode/auto)
CLAUDE_BIN               # claude CLI 路径 (默认: claude)
MAX_CONCURRENT_SESSIONS  # 最大并发会话数 (默认: 1)
FLEET_MAX_WORKERS        # Fleet 最大工人数 (0=禁用)
FLEET_POLL_INTERVAL_MS   # Fleet 轮询间隔 (默认: 30000)
```

## 13. 数据流与持久化

| 数据 | 存储位置 | 格式 |
|------|---------|------|
| Job 配置 | `.scheduler/jobs.json` | JSON |
| 会话日志 | `.scheduler/logs/{job}-{ts}.log` | 文本 |
| 活跃会话 | `.scheduler/active-sessions/{id}.json` | JSON |
| 待确认操作 | `.scheduler/pending-actions.json` | JSON |
| 进化状态 | `.scheduler/evolution-worktree.json` | JSON |
| 循环任务冷却 | `.scheduler/recurring-cooldown.json` | JSON |
| 后端偏好 | `.scheduler/backend-pref.json` | JSON |
| 交互指标 | `.scheduler/metrics/interactions.jsonl` | JSONL |
| 会话指标 | `.scheduler/metrics/sessions.jsonl` | JSONL |

## 14. API 端点

HTTP 服务监听 `http://127.0.0.1:8420`：

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/status` | GET | 系统状态快照（会话/实验/Job） |
| `/api/sessions` | GET | 活跃会话列表 |
| `/api/push/enqueue` | POST | 入队 git push 请求 |
| `/api/push/status/:id` | GET | 查询 push 结果 |
| `/api/experiments/register` | POST | 注册实验追踪 |
| `/api/restart` | POST | 触发优雅重启 |

---

> **维护提示**：任何涉及以下变更的 PR 都必须同步更新本文件：
> - 新增/删除模块文件
> - 新增/修改 Agent Profile
> - 新增/修改 Action Tag
> - 修改执行路径或安全守卫
> - 修改 Git 操作规则
> - 修改环境变量
> - 修改 API 端点
