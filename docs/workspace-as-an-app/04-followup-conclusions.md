# 复盘结论

针对 `03-user-scenarios.md` 末尾遗留的三件事，已收敛。

---

## 结论 1：Public App ≠ Access Entry，分两个对象

### 三个场景的实证

| 场景 | Publish 次数 | 访问入口数 |
|---|---|---|
| 林夏 | 1 | 多个 token（朋友们） |
| 阿哲 | 1 | N 个 token（每客户一个） |
| 小川 | 1 | 1（匿名只有一个 URL） |

### 模型

```
Public App                ← 一对一，workspace 对某 app 的对外承诺
   ├── Anonymous          ← 单一公开访问（小川）
   └── Access Entry[]     ← 多实体，每个有 token / label / quota / 用量 / 吊销
```

- **Publish** = "我把这个 app 暴露了"
- **Access** = "我给某个人/某个用途的具体访问凭证"

文档当前用 "publish" 一个词覆盖两件事，会产生数据模型 / UI / 生命周期 / 定价的**四重含糊**。

### 回写文档

在 Key product decisions 加：

> **Public App vs Access Entry —— 是同一个对象还是两个？**
> 推荐：分为两个对象。一个 Public App 可承载多个 Access Entry（共享链接模式）或一个 Anonymous 入口。Access Entry 拥有独立的 token / label / quota / usage / 吊销能力。

acceptance criteria 补一条：

> 运营者可以为一个 public app 管理多个独立 access entry。

---

## 结论 2：v1 不收费，但必须可观测

文档现在是"功能产品"，不是"商业产品"。`Workspace As an APP` 改变了 workspace 的**单位经济**：

| 类型 | 经济属性 |
|---|---|
| 私有 workspace | 一个 user，可预测的 LLM / 资源用量 |
| 公开 workspace | **不可预测**的外部流量 + 外部触发 LLM + 持续在线 |

不在 v1 设经济护栏的话，三件事一定发生：
1. 某个 builder 的 app 被刷爆，账单失控
2. 不知道哪些 public app 在赚钱（无成本对比数据）
3. 想加付费层时无数据，全靠拍

### v1 必做

| 项 | v1 | 理由 |
|---|---|---|
| Per public app 成本观测 | ✅ | 否则未来没数据定价 |
| Per access entry 用量观测 | ✅ | 同上 |
| 每个 public app 日成本上限（默认 + 可调） | ✅ | 安全护栏 |
| 单 IP / 单 token 速率限制 | ✅ | 安全护栏 |
| 达到上限的行为（拒绝 / 降级 / 暂停） | ✅ | 配置项 |
| **实际收费** | ❌ | v1 不收，但**有数据**支持以后定价 |

### 回写文档

新增 section **"经济模型假设"**：

> v1 不向用户收取 Workspace As an APP 的额外费用，作为现有订阅的延伸功能。但 v1 必须包含 per-public-app 的成本观测、用量观测、和成本上限护栏，以支持后续定价判断。
> 
> 未来定价候选维度：每个 public app 月费、external traffic 量、LLM token 量、外部访客数。最终选择延后到有真实数据。

这一段的作用：
- 让工程知道"成本可观测"是 v1 必做
- 让商业知道这件事**没有被遗忘**，只是延后
- 解释"为什么不收费但有上限"

---

## 结论 3：Design spike 跑 A + C

候选 UX 形态：

| 编号 | UX 形态 | 重要度 | Spike 入选 |
|---|---|---|---|
| A | Publish 流 | ⭐⭐⭐ | ✅ |
| B | 撤销下线页 | ⭐⭐ | ❌（视觉决定，2 版稿即可） |
| C | Access 管理面板 | ⭐⭐⭐ | ✅ |
| D | Analytics 面板 | ⭐⭐ | ❌（可参考通用 SaaS 模式） |
| E | 匿名 abuse → 运营者通知 + kill | ⭐⭐ | ❌（ops 流程，不是 UX 创新） |
| F | 第一次 publish 的 onboarding | ⭐ | ❌（等 A 跑完再说） |

### 为什么 A 必跑

- 第一次 publish 是用户对产品的**第一印象**
- modal 里要塞下很多决策（auth / slug / 成本上限 / kill switch）
- 文档里**最容易做太重**的地方 —— spike 的价值是找到"5 分钟能学会"的形态

### 为什么 C 必跑

- 场景一、二都自然走到这里
- 多个新概念**同框出现**：access entry / label / quota / usage / revoke
- 没设计交给工程一定做成"表格 + 几个按钮" —— 缺信息密度和情感温度
- 跑 C 顺手验证结论 1（access entry 独立对象的判断）

### Spike 的产物清单

| 产物 | 用途 |
|---|---|
| Publish flow 高保真稿（3 版） | PM 选 |
| Access 管理面板高保真稿 | 同上 |
| 端到端 3 场景 storyboard | 验证设计能覆盖所有场景 |
| **"产品没答案"清单** | 反推 PM 补决策 |

最后一项是 spike 最重要的副产物 —— **design 经常是发现产品决策缺失的最好工具**。

---

## 汇总：对文档的修改建议

```
文档新增 / 修改：
├── Key product decisions
│   └── 新增："Public App vs Access Entry 是一个还是两个对象"
├── 新增 section："经济模型假设"
│   ├── v1 不收费
│   ├── v1 必须可观测（per app / per access entry）
│   └── 未来定价维度候选（不定具体方案）
└── Acceptance criteria
    ├── 补："运营者可管理多个独立 access entry"
    └── 补："每个 public app 有日成本上限和速率限制"

Design spike 立项：
├── A：Publish flow（3 版高保真）
└── C：Access 管理面板（高保真 + 操作流）
```
