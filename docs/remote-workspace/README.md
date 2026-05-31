# `Remote Workspace` 思考归档

文件：

| 文件 | 内容 |
|---|---|
| `01-pm-perspective.md` | PM 视角重读文档 |
| `02-proposal-flow.md` | 假设走 Proposal Discussion → Engineering Review 流程的推演 |
| `03-user-scenarios.md` | 三个具体使用场景（陈璐 / 沐光 / 启明） |
| `04-followup-conclusions.md` | 场景复盘结论 |
| `05-engineering-review.md` | **基于真实代码的 Engineering Review（已对齐 origin/dev 最新状态）** |

---

## V1 Scope（已与 PM 锁定）

**核心诉求**：**Remote workspace 在 desktop 中可以正常使用所有的 workspace 功能。**

### V1 包含

- ✅ Cloud workspace 创建 / 列表 / 打开 / 删除（仅 empty workspace）—— **代码已合并**
- ✅ Cloud workspace 内的所有正常 workspace 功能（files / chat / agent / apps / 集成 / 自动化）—— **代码已合并**
- ✅ Per-workspace 独立 Sprite sandbox + auth token —— **代码已合并**
- ⚠️ Auto idle suspend —— **跟踪已在，cron 触发需确认**
- ❌ Out-of-workspace 通知 —— **待做**
- ❌ Per-workspace 成本可观测 + 上限 —— **待做**
- ⚠️ **速度优化** —— `sprite proxy` CLI-backed 自身有固定开销（进程 spawn / auth / port forwarding setup），可能需要迁到 API-backed
- ⚠️ **方案打磨** —— CLI-backed 仍是 spike-level；与速度优化是同一件事的两面
- ⚠️ **真实测试 / dogfood 验证** —— 现有 source-based 单测，端到端流程没真实跑过
- ❌ **集成账号集中管理** —— **待做**（原 PRD 核心承诺）
- ❌ **集成记忆共享** —— **待做**（原 PRD 核心承诺）
- ❌ **Runtime updater 集中管理** —— **待做**（原 PRD 核心承诺）

### V1 不做

- Marketplace templates / Browser surface（PM："V1 可不做"）
- Agent 自动行为可追溯（PM："不用考虑"）
- Team / 多 operator 权限（PM："暂时不用"）

---

## 总时间线（PM 给）

- **~1 周** 到内部 dogfood
- **~1.5 周** 到 prod

---

## 关键架构 lock-in（已在代码里）

- **沙箱技术 = Sprites**（不是 Fly machines；Fly remote 路径已 deprecated）
- **1 workspace = 1 sprite sandbox**
- 通信走 `sprite proxy` 端口转发（不走 Fly exec —— 但 `sprite proxy` CLI 本身有自己的开销，v1 内需要优化）
- Runtime 从 `holaOS-priv` GitHub release 拉取，含 local bundle fallback
- Workspace-scoped binding（Supabase migration 已 drop user-uniqueness）

---

## 第一轮评审里错的地方（已修正在 05）

我前面整个 engineering review 基于 stale 本地 dev 写，得出"backend 控制面完全没实现"的错误结论。实际 `origin/dev` 上整套 sprites-backed cloud workspace 已经合并。修正后估算与 PM 给的 1.5 周 / 2 周匹配。**根本错误是分析前没 fetch latest。**

---

## 下一步动作（1.5 周 dogfood 窗口内并行）

1. 实现 out-of-workspace 通知（~2–3 天）
2. 实现 per-workspace 成本观测 + 上限（~1–2 天）
3. 与 backend 同事确认 auto idle suspend cron（如未接上 ~1 天补）
4. **Profile 速度 + 优化**（~2–3 天）
5. **CLI-backed 方案打磨 + edge case**（~2 天）
6. **真实测试 / 端到端 / dogfood 准备**（~2 天）
7. Desktop ↔ backend 联调收尾（~1–2 天）
8. Dogfood + prod ship（~2–3 天）

> "**代码合进 dev ≠ ship 完成**" —— 中间还有约一半工作量在速度 / 方案打磨 / 真实测试。
