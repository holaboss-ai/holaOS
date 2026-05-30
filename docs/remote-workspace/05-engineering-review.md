# Engineering Review: Remote Workspace（Cloud Workspace）

## Understanding

让 desktop 用户的 cloud workspace 在功能上等同于 local workspace。

沙箱技术 = **Sprites**（1 workspace = 1 sprite sandbox，Fly remote 路径已 deprecated）。Backend 通过 `sprite proxy` 端口转发与 sprite 通信。Runtime 从 `holaOS-priv` GitHub release 拉到 sprite（或 local bundle fallback）。控制面 endpoints + auth + 文件 / runtime 代理 / 删除流程**代码已合并到 dev**；剩下：**速度优化、CLI-backed 方案打磨、真实测试、通知、成本观测**。

---

## Proposed implementation approach

### Frontend changes（desktop）

- 已基本完成（`upstream/feat/remote-workspace` 分支）
- 剩：契约对齐 + auth token refresh + 竞态边角修复

### Backend / API changes

**已合并**：
- 7 个 control plane endpoints（`desktop_workspaces.py`）：list / create / get / delete / lifecycle / activate / open
- 文件 mutate endpoint
- Workspace runtime 透传代理（含 SSE）
- Sprites provider（`sprites_provider.py`，484 行）+ Sprite CLI wrapper
- GitHub release runtime client + local bundle fallback
- Runtime auth 头转发（`X-API-Key` / `X-Holaboss-User-Id` / `X-Holaboss-Sandbox-Id`）
- 删除流程（含 stale sandbox 容忍）
- `last_activity_at` 追踪 + 手动 `provider.suspend()`

**待做**：
- **Out-of-workspace 通知路由** —— 渠道 email；v1 触发 3 项（overnight 摘要 / workspace 状态变化 / 成本接近上限）；长任务完成留 v1.x
- **Per-workspace 成本观测 + 上限** —— UI 在 workspace settings + dashboard 汇总入口；上限触发 = 通知 + 软暂停（推 email + 拒新 agent run，保留 read / 跑完中任务）；含 per-user workspace 数量软上限默认 ~5
- **Auto idle suspend cron** —— 活动定义 = `max(last_http, last_agent_run, last_cron, last_background_task)`，阈值 30 min；调用 `provider.suspend()`
- **Auth token refresh** —— 30 天 + silent refresh（desktop 长会话场景）
- **集成账号集中管理**（原 PRD 核心承诺）—— workspace-only accounts + app reference（账号在 workspace 层唯一一份，App 引用，不"绑定"也不"持有"）
- **集成记忆共享**（原 PRD 核心承诺）—— v1 简单版：workspace 共享 namespace + app 私有目录，所有 app / agent 可读写；冲突解决 / 单写者约束 v2 再说
- **Runtime updater 集中管理**（原 PRD 核心承诺）—— sprite (re)start 时拉最新 release（复用 `runtime_release_client.py`），不做热升级 / staged / pinned

### Data model changes

- Supabase migration 已合：drop remote binding 的 user-uniqueness，支持 workspace-scoped binding（`20260508113000_drop_remote_user_binding_uniqueness.sql`）

### Agent / tooling changes

- 无新增 agent / tool 改动

### Rollout / migration

- 内部 dogfood 先行
- 无破坏性 schema migration（已兼容；删除路径容忍 stale）

### 性能路径（v1 内待优化）

`sprite proxy` 是 CLI-backed —— 每次 `client.proxy_port(...)` 付**进程 spawn / auth handshake / 端口分配 / forwarding setup** 的固定开销。是 `with` context manager 所以单 session 内 proxy 复用，但**每次操作 / 每次 open 仍有大开销**。

设计文档原话："CLI-backed ... should be treated as a **spike harness, not production integration**"。

优化方向（具体动作待 profile）：
- 从 CLI-backed 迁到 API-backed
- 长连接复用 / 端口缓存 / active workspace 预热
- Profile 找出 CLI 调用里最贵的步骤再针对性优化

---

## Risk level

**Low-Medium**

放心的地方：
- 核心实现已合并，单测覆盖到位
- 最近一周 commits 都是收尾性 fix（`align / stabilize / harden / tolerate`），没大改

不放心的地方：
- `sprite proxy` 慢，优化可能涉及架构调整（迁 API-backed）
- 当前 CLI-backed 路径自己设计文档说是 "spike harness, not production integration"
- 端到端 / 压测 / 真实流验证没做
- 通知 / 成本观测 / auto idle cron 还没实现

---

## Estimate range

| | |
|---|---|
| Optimistic | 0.5 周 dogfood / 1 周 prod |
| **Expected** | **1 周 dogfood / 1.5 周 prod** |
| Pessimistic | 1.5 周 dogfood / 2 周 prod（若速度优化需要大迁移） |

主要变量是**速度优化的深度**。Gate point：profile 第 2 天结束时，若 `sprite proxy` 单次调用 ≥ 200ms 量级，进 Pessimistic（走 CLI → API 大迁移）。

并行 + MVP pace 分配（1 周 dogfood 窗口内）：

| 类别 | 项 | 估 |
|---|---|---|
| 新特性 | Out-of-workspace 通知（触发器 + 1 渠道 + 用户配置最小版） | 1-2 天 |
| 新特性 | Per-workspace 成本观测（用量采集 + 上限 cron + UI） | 1-2 天 |
| 新特性 | Auto idle suspend cron（如未接上） | 1 天 |
| 新特性 | 集成账号集中管理（workspace 层 + 多 app 共享 + status / 解绑） | 2-3 天 |
| 新特性 | 集成记忆共享（共享 memory 命名空间 + 读写 API） | 1-2 天 |
| 新特性 | Runtime updater 集中管理（已有 sprite 升级新 release 流程 + operator 路径） | 1-2 天 |
| 速度优化 | `sprite proxy` 优化（profile + CLI → API / 长连接 / 预热） | 2-3 天 |
| 方案打磨 | CLI-backed 生产可靠性 + edge case | 2 天 |
| 真实测试 | 端到端集成 + 真实流验证 + dogfood 准备 | 2 天 |
| 联调 | Desktop ↔ backend 收尾 | 1-2 天 |
| Dogfood + ship | 反馈窗 + 修复 + prod ship | 2-3 天 |

---

## Blocking questions

1. **Auto idle suspend cron 是否已接上** —— 代码里 `last_activity_at` tracked + `provider.suspend()` 可调，但 cron trigger 没明确证据。**需 backend 同事一句话确认**；如未接上 v1 补（~1 天）
2. **Dogfood 用户群** —— 谁来 dogfood？几个人？哪些场景？
3. **Sandbox 计费规则** —— 按 active minute 还是 workspace 数量？v1 不向用户暴露但 backend 要可观测

---

## Suggested smallest useful v1

**已合并**（不动但优化）：

- Cloud workspace 创建 / 列表 / 打开 / 删除（仅 empty）
- File explorer read / write / mutate
- Workspace runtime SSE 透传（agent runs / chat / outputs）
- Per-workspace 独立 sprite（A 模型）
- Auth token + 头转发

**待做（v1 必做）**：
- Out-of-workspace 通知（最小版：1 渠道 + 触发器 + 配置）
- Per-workspace 成本观测 + 上限
- Auto idle suspend cron
- `sprite proxy` 速度优化（至少 profile-and-fix 级别）
- **集成账号集中管理**（原 PRD 核心承诺）
- **集成记忆共享**（原 PRD 核心承诺）
- **Runtime updater 集中管理**（原 PRD 核心承诺）

**Dogfood readiness 标准**（ship to prod 的 gate）：
- uptime ≥ 99%
- P0 bug 清零
- 成本上限触发实测过至少一次（验证软暂停行为）
- 在 cloud workspace 里 vibe-code 出至少一个新 local app 并跑起来（PRD acceptance criteria）
- 至少一个真实 dogfood workspace 远程优先创建并使用

**V1 不做**：

- Marketplace templates / Browser surface
- Agent 自动行为可追溯
- Team / 多 operator

---

## Suggested scope cuts

| 可砍项 | 节省 | 代价 |
|---|---|---|
| 成本观测 UI（只采集 + 上限 cron，不做 dashboard） | ~0.5 天 | dogfood 用 SQL 查 |
| 通知渠道砍到只剩 1 个（如只 email） | ~1 天 | 场景体感降级 |
| `sprite proxy` 优化推到 v1.x | ~2-3 天 | dogfood 体感差，"远端 = 难用"口碑风险 |

**不能砍**：
- 通知触发器（dogfood 必须能感受到 24h 在线承诺）
- 成本上限 cron（dogfood 阶段就要防账单失控）
- Auto idle suspend（per-workspace sprite 不 suspend = 账单线性）
