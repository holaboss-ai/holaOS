# 走 Proposal Discussion → Engineering Review 流程

针对 `Remote Workspace`。

---

## 一、Proposal Discussion 阶段：建议判定

**选项：Needs product revision**（带具体清单）

理由：
- 9 个 Key product decisions 里，**至少 4 个直接决定工程估算量级**（lifecycle / 集成记忆架构 / 权限模型 / 集成账号模型）
- 现在直接进 Engineering Review，工程会原路打回索要这些答案
- 不适合 prototype-first 整体 —— 开放问题大多是产品/商业判断，不是 UX 探索问题
- 可以**部分**走 prototype（sleep-wake 唤醒体验），但不作为主路径

**不选 small task**：明显大；**不选 parked**：是底座类工作，再拖只会让上层悬空；**不选直接 approved**：4 个量级决定项没答案。

---

## 二、Discussion 阶段必须先锁的事 + Owner

按"影响工程量级"排序：

| # | 必须先决 | 建议立场 | Owner |
|---|---|---|---|
| 1 | Lifecycle 模型 | **sleep-wake** | PM |
| 2 | Update 模型（内部对运营者） | **live stateful** | PM |
| 3 | 计费模型框架（不是定价，是结构） | **按 active workspace** | PM + 商业 |
| 4 | Onboarding 是否让用户选 remote/local | **默认 remote，不让用户选** | PM + Design |
| 5 | Desktop 用户的去向 | **并存，远程作默认推荐** | PM |
| 6 | "集中集成记忆"的产品定位 | **核心差异化承诺，写进文档** | PM |
| 7 | 多操作者权限 v1 范围 | **owner + member 两层** | PM |

其余 open question（central integration 的 workspace/app 边界、runtime updater policy、ready/health 呈现）可以进 Engineering Review **之后**和工程一起讨论 —— 影响实现选择，不影响是否能估出量级。

**Discussion 退出标准**：上面 7 条每条有 owner，前 4 条有答案，文档 PR 更新。

---

## 三、Cheaper v1

**v1 = 一个内部团队的远程工作区，sleep-wake，无团队权限，无 onboarding 改造**

具体：
- ✅ 创建即远程（但只对内部账号开放这个入口）
- ✅ Sleep-wake（不做 always-on）
- ✅ 现有 runtime 契约不动
- ✅ 集成账号集中管理 surface（最小可用：列表 + 状态 + 解绑）
- ✅ 集成记忆共享存储（最小可用：workspace 级 key-value，agent 可读）
- ❌ Runtime updater 集中化（v2）
- ❌ 团队权限模型（v2）
- ❌ Onboarding 改造（v2）
- ❌ 多 surface 运营者面板（v2，只做基本 status）

逻辑：把"远程 + 长期活着 + 集中集成/记忆"三件最差异化的事跑通，把"团队 / updater / UX"三件可以延后的事推到 v2。

---

## 四、Engineering Review 示范模板（假设 revision 完成）

### Engineer's understanding of the feature

让 workspace 在远端长期运行，使用与桌面端**完全相同**的 runtime 契约，不做功能裁剪。在工作区层面新增两个产品对象：集中集成账号、集中集成记忆。v1 内部 dogfood，sleep-wake 生命周期。

### Proposed implementation approach

- **远程沙箱**：复用现有 `sandbox-runtime` 的 `fly` provider，不新增 provider 层
- **创建路径**：projects 服务新增 `remote-first` 创建标记，复用现有 workspace 模板与 setup/start 路径
- **Sleep-wake**：sandbox-runtime 增加 idle 判定 + 唤醒 endpoint；fly machine stop/start 已有原生支持
- **集中集成**：新增 workspace 级 integration store（runtime 内 SQLite + 后端镜像），app 通过 runtime API 读取，broker 凭据继续由后端持有
- **集中集成记忆**：workspace 级共享 memory 命名空间（`memory/integrations/<provider>/`），agent 与 app 通过 runtime API 读写
- **运营者 surface**：不做新增面板，复用现有 workspace UI，增加"集成"页签

### Risk level: **Medium**

- 不是 Low：sleep-wake 涉及状态恢复、唤醒延迟、agent run 中断恢复，是新行为
- 不是 High：核心 runtime 契约不动，沙箱已有 fly provider，集成/记忆是新增 surface 不是替换

### Estimate range

**6–9 工程周**（1 senior backend + 1 fullstack，含联调，不含 design）

- sleep-wake 状态机与唤醒体验（~2 周）
- 集中集成 + 集中记忆 store + API（~3 周）
- 创建流与 dogfood 验收（~1–2 周）
- 联调 + 修 bug + 内部 dogfood 反馈（~1–2 周）

### Blocking questions

1. sleep 触发的阈值由谁定？（产品 vs 运维 vs 用户设置）
2. 唤醒中的 agent run 排队还是拒绝？
3. 集成账号集中后，现有 app-level 绑定数据是否需要迁移？（影响是否 breaking）
4. 集成记忆的写入权限：所有 app 可写？还是只 agent 主会话可写？
5. dogfood 团队是哪个？什么时候可以用？

### Suggested smallest useful v1

与 PM 提的 cheaper v1 一致（见上）。

### Suggested scope cuts

如果要再砍：
- 砍掉"集中集成记忆"v1（先只做集中集成账号），减约 1.5 周
- 砍掉"创建即远程"产品流，先做"内部命令行创建远程 workspace"，减约 0.5 周
- **不砍** sleep-wake —— 这是远程 workspace 的产品身份核心

---

## 五、与 `Workspace As an APP` 流程的差异

只为说明这份**不能复制另一个领域的处理**：

- 这份 risk 等级**更低**（Medium vs High）—— 不引入新的信任边界
- 这份估算**更短**（6–9 周 vs 10–14 周）—— 主要是把现有 runtime 契约**包装成产品**，不是新建系统
- 这份 Discussion 阶段**不需要并行 design spike** —— 开放问题大多是商业/产品判断，不是 UX 探索
- 这份 blocking questions **不涉及 security 模型** —— 它没引入公网边界

---

## 六、一句话总结

> **PM 这一侧的材料已经准备充分，前 4 个量级决定（lifecycle / update / 计费框架 / onboarding 默认）必须由 PM 一周内拍板，工程才能进 Engineering Review。其余 3 条决定可以进入工程评审后再补。**
