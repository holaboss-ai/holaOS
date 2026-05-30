# 走 Proposal Discussion → Engineering Review 流程

针对 `Workspace As an APP`。

---

## 一、Proposal Discussion 阶段：建议判定

**选项：Needs product revision**（带具体清单，建议同步起一个**小 design spike** 跑 UX 形态）

理由：
- 6 个 Key product decisions 里，**至少 4 个直接决定工程估算量级**（暴露粒度、路由映射、auth、publish）
- 这一份比 `Remote Workspace` 那份风险更尖锐 —— 技术风险栏明确写了"vibe-coded 代码 + 公网 + 凭据"三重叠加，安全门槛必须先定
- 不适合整体 prototype-first —— 但**"暴露粒度 + URL 形态"**有强 UX 含义，可并行起 design spike

**不选 small task**：明显大；**不选 parked**：是上层杠杆；**不选直接 approved**：4 个量级决定项没答案，工程会原路打回。

---

## 二、Discussion 阶段必须先锁的事 + Owner

按"影响工程量级"排序：

| # | 必须先决 | 建议立场 | Owner |
|---|---|---|---|
| 1 | 暴露粒度 | **root app** | PM |
| 2 | URL 形态默认值 | `<workspace>.holaboss.app` 子域 | PM + Design |
| 3 | Auth 模型 v1 范围 | **匿名 + 共享链接**，不做 authenticated user | PM |
| 4 | Publish 模型 | **显式 publish**，按钮触发 | PM |
| 5 | 公开 vs 运营者面默认 | **默认全部内部**，单一 surface 显式标记 | PM |
| 6 | Vibe-coded App 上线 safety gate | **出口网络白名单 + 二次确认**，不做代码审查 | PM + Security |
| 7 | 撤销 publish 的产品定义 | **立即下线 + 自定义下线页** | PM + Design |

只有第 7 条是文档**没列**但 PM 必须补的（撤销路径）。

**Discussion 退出标准**：7 条全部 owner + 答案就绪；文档 PR 更新；design spike 立项。

---

## 三、Cheaper v1

**v1 = 一个 workspace 把 root app 暴露成一个子域，匿名访问 + 显式 publish，无版本管理**

具体：
- ✅ 每个 workspace 选**一个** root app
- ✅ 子域路由 `<name>.holaboss.app`
- ✅ Gateway → sandbox-runtime → app 端口
- ✅ 显式 "Publish" 按钮
- ✅ 一键撤销（下线页 + 立即生效）
- ✅ 出口流量白名单默认开启
- ✅ Runtime / 运营者 route 默认 deny（**安全基线**）
- ❌ 多 route / manifest（v2）
- ❌ Authenticated user（v2）
- ❌ 版本化 publish / rollback（v2）
- ❌ 自定义域名（v2）
- ❌ 代码审查 gate（v2 / 永远不做）

逻辑：v1 做对"一个 workspace = 一个公开网站"+"出口和路由的安全边界默认就是对的"。

---

## 四、Engineering Review 示范模板（假设 revision 完成）

### Engineer's understanding of the feature

为现有 workspace 增加一个**对外暴露**的产品对象。运营者选一个 root app 作为 public surface，按 publish 后通过子域对外可访问。Gateway 默认 deny 所有路径，只允许显式 public manifest 列出的 route。v1 内部 dogfood，匿名 + 共享链接 auth。

### Proposed implementation approach

- **入口**：在边缘层（Cloudflare Worker / Hono gateway 上层）增加子域路由 → workspace public manifest 查询 → sandbox-runtime
- **Publish 流程**：runtime 内增加 `workspace.public` 配置；按 "Publish" 后产物是一个 manifest（app id、route 白名单、auth 配置、snapshot ref）
- **Snapshot**：v1 不做版本快照，publish 直接 reference 当前 live 状态（接受 "live 即 published"，但 publish 是显式 commitment）
- **Auth**：匿名 = pass-through；共享链接 = gateway 层校验签名 token；不进 sandbox
- **凭据隔离**：broker token 留在后端，公网请求不经过 broker；vibe-coded app 默认无法访问 broker（需 owner 显式授权）
- **出口策略**：sandbox 默认网络出口走白名单
- **撤销**：删除 manifest 即生效；gateway 返回固定下线页

### Risk level: **High**

原因：
- 公网边界 + vibe-coded 代码 + 凭据三重叠加
- 出口策略 / 凭据隔离 / 路由白名单**任一失守 = 数据事故**
- 不是纯加 feature，是引入一个新的**信任边界**

### Estimate range

**10–14 工程周**（1 senior backend + 1 fullstack + 1 security review）

- Gateway + 子域 + manifest 系统（~3 周）
- Publish / 撤销流程 + UI（~2 周）
- 出口白名单 + 凭据隔离（~3 周，含 security 评审）
- 共享链接 auth（~1 周）
- 内部 runtime / 运营者 route 显式 deny（~1 周）
- 联调 + dogfood + 修 bug（~2 周）

### Blocking questions

1. 子域基础域是哪个？谁管 DNS / 证书？
2. 共享链接的吊销策略？（token 重置 / 链接旋转）
3. Vibe-coded app fetch 外部 API：owner 一次性授权 vs 每次审批？
4. 公开 surface 崩了，公众看到的兜底页面是谁做？
5. dogfood 的第一个产品是什么？由谁拥有？

### Suggested scope cuts

如果还要砍：
- 砍掉共享链接 auth → 只支持匿名（-1 周，限制产品形态）
- 砍掉"自定义下线页" → 一律 404（-0.5 周，伤 builder 信任）
- **不要砍**出口白名单 / 凭据隔离 —— 安全基线砍了就别上线

---

## 五、一句话总结

> **PM 必须先把"暴露什么 / 怎么 auth / 怎么 publish / 怎么撤销"四件事的立场拍下来，工程才能开始估；同时安全模型必须从设计阶段就在场，不是评审尾段加上去的检查项。**
