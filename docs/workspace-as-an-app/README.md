# `Workspace As an APP` 思考归档

为 `Workspace As an APP` proposal 文档做的 PM 视角分析、流程推演、场景补充、复盘结论。

文件：

| 文件 | 内容 |
|---|---|
| `01-pm-perspective.md` | PM 视角重读文档：产品故事、买单方、必须先答的开放问题、隐性风险、成功指标、对文档的 push back |
| `02-proposal-flow.md` | 假设走 Proposal Discussion → Engineering Review 流程的推演：discussion 阶段判定 + 必须先锁的事 + cheaper v1 + 工程评审模板 |
| `03-user-scenarios.md` | 三个具体使用场景（林夏 / 阿哲 / 小川），覆盖不同 audience / auth / 风险象限，并提炼跨场景的产品要求 |
| `04-followup-conclusions.md` | 三个遗留问题的收敛：Public App vs Access Entry 分对象、v1 经济模型假设、design spike 跑 A+C |

---

## 核心立场

1. 这个产品的 wedge 是 **"创作 → 发布之间没有断层"** —— builder 在 workspace 里搭的就是最终发布的。
2. PM 必须先关闭 4 个量级决定（暴露粒度 / URL 形态 / Auth / Publish），文档才能进 Engineering Review。
3. 安全模型 risk 是 **High**（vibe-coded 代码 + 公网 + 凭据三重叠加），不能等评审尾段补。
4. v1 = 一个 workspace 一个 root app，子域路由，匿名 + 共享链接 auth，显式 publish，无版本管理。
5. **kill switch 即时生效**、**access 管理是一等公民**、**analytics 是 v1 必备** —— 这三条文档没写但必须有。
6. **Public App 和 Access Entry 分两个对象** —— 一个 Public App 可承载多个 Access Entry，独立 token / label / quota / 吊销（结论 1）。
7. **v1 不收费，但必须可观测 + 必须有成本护栏** —— 否则无法支持未来定价决策（结论 2）。
8. **Design spike 跑 Publish 流 + Access 管理面板** —— 这两个最容易被做重，且决定产品的第一印象与日常运营体验（结论 3）。

---

## 下一步可能的动作

- 把"对文档的修改建议"（见 `04-followup-conclusions.md` 末尾）写成可发给文档作者的反馈
- Design spike 立项（A + C）
- 商业 / 工程一起对 v1 经济护栏的具体数值（默认日成本上限、速率限制阈值）做一次小范围对齐
- 与 `Remote Workspace` 工作流的依赖关系排期（这件事不属于本领域，但落地时序需要协调）
