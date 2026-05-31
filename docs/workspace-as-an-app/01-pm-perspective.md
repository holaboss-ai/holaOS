# PM 视角：`Workspace As an APP`

只看这一份。保持作为独立领域，不与 `Remote Workspace` 合并叙事。

---

## 一、文档真正在卖什么"产品故事"

文档自己的措辞是"把 remote workspace 的一部分通过 gateway 对外暴露"。这是工程语言，不是产品语言。翻成产品语言：

> **让用户用 agent 把一个 workspace 搭出来，然后一键变成一个对外的应用。**

潜台词：
- 你不用从零写一个 app
- 你不用走 deploy / hosting 的传统链路
- 你在 holaOS 里**搭的就是你最终发布的**
- 中间没有"打包 / 导出 / 编译"的鸿沟

这就是这个产品**真正的 wedge**：**"创作 → 发布"之间没有断层**。区别于 Vercel / Replit / Lovable 这类产品 —— 不是又一个 "AI 帮你写代码再 deploy"，而是 **"你已经在用的运营环境就是生产环境"**。

文档里没有把这句话写出来，但所有决定都是围着这句话转的。**这是 PM 自己应该补在文档第一行的事。**

---

## 二、价值给谁、谁付钱

| 用户 | 角色 | 是否买单 | 重要度 |
|---|---|---|---|
| 内部 dogfood | 验证 | 不 | 跑通就行 |
| **现有客户（想把工作区变成对外产品）** | **付费方** | **是** | **最重要** |
| agent 构建者 | 创作者 | 间接 | 决定深度使用 |
| Admin / 团队所有者 | 决策方 | 是 | 决定企业扩展 |
| 终端外部用户 | 消费方 | 不 | 间接决定 builder 成功 |

判断：核心买单方是**已经在用 workspace 的 builder**。终端用户体验是 builder 成功的杠杆，但不是直接收入。

这影响优先级：
- "声明对外暴露是 5 分钟能学会的" > "终端用户页面有多漂亮"
- "我对外公开了什么" > "公众看到的视觉品质"
- "出问题 builder 能自己关掉" > "support 干预流程"

非目标里"默认不要每个 workspace 都暴露"其实是 builder-friendly 的判断 —— 让一次误操作不会泄露数据。

---

## 三、PM 必须先回答而文档列为 open 的事

### 1. 暴露粒度：root app / 多 route / app-owned manifest？

文档把三者并列。PM 视角看，这是三种完全不同的产品：

| 粒度 | 产品形态 | 比喻 |
|---|---|---|
| Root app | 一个 workspace = 一个网站 | Vercel project |
| 多 route | 一个 workspace = 多页应用 | Webflow site |
| App-owned manifest | App 自己声明对外 surface | iOS App with deep links |

**v1 选 root app**。心智最简单（"我把这个 App 公开"），dogfood 路径最短，未来可以演进到 manifest。

### 2. URL 形态（文档完全没提，PM 必须答）

直接是营销资产：
- `<workspace>.holaboss.app` → "我做了一个 holaboss app"
- `<custom-name>.holaboss.app` → "这是我的产品"
- 自定义域名 → "这是我的品牌"

v1 不做自定义域名是合理的，但**用什么默认形态必须定**，且这决定 builder **在朋友圈怎么介绍这个东西**。

**v1：子域 + 用户可改 slug**（不能用 workspace UUID）。

### 3. Auth 模型

不是技术选项题，是**产品类别题**：

| Auth | 产品类别 |
|---|---|
| 匿名 | 公开 web 工具 / landing page |
| 共享链接 | 内部分享、半私密产品 |
| 认证用户 | 真正的 SaaS 应用 |
| 混合 | 平台型产品 |

**v1：匿名 + 共享链接**。覆盖大部分 dogfood 场景。"认证用户"留 v2 —— 它会带出一整个"应用内用户系统"的题。

### 4. Publish 模型

文档列了 live / 显式 publish / 版本化。**v1 必须是显式 publish**。原因：
- builder 会经常在工作区里试验、改、撤
- live 直接对外 = builder 每次试错都对公众可见 = 信任崩塌
- 显式 publish 给一个"准备好了"的瞬间

这条**不能让工程意见主导**，必须 PM 拍板。

---

## 四、第一刀切在哪（Wedge）

问题不是"切多窄"，而是"切哪种 surface 才能讲清楚故事"。

候选：

| Dogfood 场景 | 故事清晰度 | 风险 |
|---|---|---|
| 内部把 workspace 暴露成公司内部工具 | 中 | 看不出对外价值 |
| 早期客户做"AI 文案生成器"对外公开 | **高** | 故事清楚 |
| 用 workspace 驱动一个 landing page | 中 | 偏 marketing |
| Builder 做对外小工具（tweet 生成器等） | **高** | 可验证可分享 |

选**"Builder 做对外小工具"**作为第一刀。最能体现"workspace 里搭好的东西**直接**变成 public 应用"。

---

## 五、文档没写但必须想的（沉默处即风险）

### 1. 计费模型

文档完全没提钱。对外公开的 workspace 有真实成本：长期运行、外部流量、公网带宽、vibe-coded 应用消耗的 token。

**PM 必须知道最终怎么挣钱**：
- 按 workspace 数量？
- 按公网流量？
- 按外部用户数？
- 按 token 使用量？
- 按"是否公开"加价？

### 2. 失败场景的产品体验

- 公网 URL 挂了怎么办？
- workspace 被 sandbox 强制重启时，公众看到什么？
- vibe-coded 代码崩了，公众看到 stack trace 还是 fallback？
- 撤销 publish 后旧链接看到什么？

**都不是工程细节，都是产品决定** —— 直接决定**公众用户对这个产品的印象**。

### 3. Builder 关掉这个东西的体验

文档讲了"声明 public"，**没讲"撤销 public"**：
- 立刻生效还是有 grace period？
- 已有公网链接：404 / 下线页 / 跳转？
- 能不能"暂停"而不是"删除"？

撤销路径的体验**直接影响 builder 敢不敢公开**。不敢撤销 = 不会公开。

### 4. 内部杠杆

"我们的产品是用我们的产品做的" —— 这是**对外故事**，是**隐性 marketing 价值**，文档没提。

---

## 六、衡量成功的指标

文档的 acceptance criteria 是工程口径。PM 视角的指标：

| 维度 | 指标 |
|---|---|
| **可达性** | 多少 workspace 在 30/60/90 天内用过 publish |
| **留存性** | publish 之后多少**仍然 public** |
| **使用性** | 公开 surface 的外部访问量、留存 |
| **builder 信心** | publish 一个之后**会不会再 publish 第二个** |
| **故事性** | 是否产出 1–2 个可对外讲的案例 |
| **安全性** | 0 起内部 runtime 路由泄露事件 |

最后两条 PM 必须自己持有。

---

## 七、对文档的核心 push back

1. **需要一个**短**的产品名**（`Workspace As an APP` 太工程化，builder 看不懂）
2. **Publish 模型不能列为 open**，v1 必须是显式 publish
3. **Auth v1 范围必须收敛**（匿名 + 共享链接两种）
4. **必须有"撤销/暂停"的产品定义**，不只是"声明 public"
5. **必须有 URL 形态的默认值**
6. **必须补一段商业模型假设**
7. **第一刀 dogfood 场景需要更具体**
