# Integrations ↔ HolaApp 合并规划

**日期:** 2026-07-12
**状态:** 设计已定,待实现
**范围:** holaOS desktop + runtime。只合并 integration ↔ HolaApp,**不**扩到 capability。

## 背景:两套世界,底层同一条链

今天 integration 和 HolaApp 用两套目录、两套 UI、两套心智维护,但底层是同一条链——都 key 在同一个 Composio provider slug、绑定同一张 `integration_connections` / `integration_bindings` 表,最后都进 `workspace.yaml` → `composeMcp` → agent。

| | Integration(Composio) | HolaApp(app-builder) |
|---|---|---|
| 目录 | `runtime/api-server/src/integration-store-catalog.ts` | `apps/desktop/src/lib/holaAppMarketplace.ts` + `/api/v1/apps` |
| UI | `IntegrationsPane` + `AddIntegrationDialog` | `HolaAppMarketplacePane` + `HolaAppCard` |
| 连接 | Composio OAuth → `integration_connections` | 绑定**同一张** `integration_connections`(按 provider slug) |
| 工具 | `holaboss_composio` 单 MCP registry + 24 工具均衡预载 | 自己进程 + 自己 MCP server + resources/actions/syncs |
| 进程/状态 | 无 | 有(bun 进程 + SQLite + 可选 dashboard) |

关键结论:**integration 本质上已经是一个「connection-only HolaApp」**。marketplace 的 `AppCatalogEntry`(`holaAppMarketplace.ts:36`)已经是超集——它有 `integrations?`、`surface:{type:"none"}`、`mcpTools?`。所以**合并方向是把 integration 折叠进 HolaApp,不是反过来**。

## 已定决策

1. **激进程度:展示 + 数据模型统一。** Tier 0 保持无进程的 Composio 透传;只统一目录 / 卡片 / 安装编排 / 管理 UI。重运行时只留给策展模块。
2. **命名:统一叫 App。** 连接型 = 「没有界面的 App」。
3. **不扩到 capability。** 但合并后 capability 更干净:它以后只需说「我依赖 App X」。

## 统一对象模型

在 `AppCatalogEntry` 上加一个判别式,其余字段全复用:

```ts
kind: "connection" | "module" | "hosted"
```

- `connection` → `surface:{type:"none"}` + `integrations:[slug]`,工具来自 Composio 透传,**无进程**(= 今天的原始 integration)
- `module` → 现有 app-builder 物化模块(自己进程 + MCP)
- `hosted` → 现有 web surface

**`kind` 是推导值,不是 provider 的固有属性。** 它判的是「这个 slug 今天有没有一份 app-builder 模块」:有手写模块 → `module`;只有 Composio slug → feeder 合成成 `connection`。同一个 provider 会随「有没有人写它的模块」在 tier 间移动。

**去重规则:** 同一个 slug 若既有 feeder 合成的 connection 卡、又有真实 module,**module 覆盖 connection**——绝不能出现两张同名卡。

「已安装」按 kind 分流:connection 看「有 active 连接 + composio MCP 已 ensure」;module 看「已物化 + 进程健康」。

**无损升级性质:** 三个 tier 都 key 在同一 provider slug + 同一连接表上,把 connection 升级成 module **无损**——用户已授权的 OAuth 连接原封不动继续用。这给出渐进策展路线:先让 ~90 toolkit 全以 `connection` 上架,再挑高频的升级到 `module`。**Notion 是头号升级目标**(SKILL 里的 integration-only module 样板),但仓库今天还没有它的模块源码,所以在 Step 1 里它先以 `connection` 出现——这正是要验证的升级路径,而非它的永久归类。

## 核心概念:两个轴必须分离(headless-first)

「App」这个词在现有代码里隐含「有 webview」,但 **webview 从来不是底座——MCP 工具才是**。把被混在一起的两个轴拆开:

1. **能力面(capability surface)= MCP 工具。** 普适、无头、agent 可调。integration 和 HolaApp 都有,都独立于任何界面存在。
2. **交互面(interaction surface)= webview / dashboard。** 可选附加层,只有部分 App 有。

纯 integration = **能力面满、交互面空** 的 App。

**设计原则:headless-first,surface-optional。** 既然选了「everything is App」,就要主动防止「App ⇒ 有前端」漏进代码和 UX。默认 App 无头,webview 是例外。

信息流两种,不是一种:
- **webview App:** 两条道 —— `@holaboss/app-host` RPC(webview ↔ shell)+ MCP 工具(agent ↔ app)。
- **无头 App(纯 integration):** 只走 MCP 工具调用本身。入参进、结果出,上下文来自 agent run。**不需要 UI 通道**,「UI 层传信息」这个问题对它不存在。

**无头 App 点开看什么:** shell 渲染的通用「App 详情面」,内容全部来自 runtime metadata(连接状态 `getIntegrationStatus`/readiness 码、账号+binding+默认账号、可用工具清单、最近工具调用活动/日志)——**shell 拼的,不是 app-host RPC 传的**。webview App 用自己的 surface **覆盖**这个默认详情。现有 `IntegrationsPane` manage 模式就是这个详情面的雏形,泛化即可。

## 三个实现步骤(每步独立可发)

### Step 1 — 数据模型统一(服务端,风险最低)

- `integration-store-catalog.ts` 从平行目录降级为 **Tier 0 的 feeder**:新增合成器,把 ~90 toolkit slug 映射成 `kind:"connection"` 的 `AppCatalogEntry`(icon 用现有 `integrationLogo`,category/tier 沿用 catalog 字段)。
- `/api/v1/apps` 把合成卡和现有 HolaApp 卡合进**同一列表**返回。服务端仍是唯一真相源(符合 `2026-06-27-holaapp-marketplace-api-contract.md`)。
- 前端 `useHolaAppCatalog.ts` 拿统一列表;store-catalog 前端调用逐步指向它。
- **验收:** `/api/v1/apps` 返回里一个纯连接 slug(如 `hubspot` / `figma`)以 `kind:"connection"` 出现且字段完整;同 slug 若已有 module,只出一张 `module` 卡(去重生效);老 integration 目录仍能读旧数据(灰度)。

### Step 2 — 安装编排统一

- 写 `addApp(entry)`,按 `entry.kind` 分支:
  - `connection`:复用 `useIntegrationConnect` → Composio OAuth → finalize → `bindConnectionToWorkspace` → `composioMcpEnsureRunning`(**不起进程**)
  - `module`:现有物化 + `bun install` + start + `workspace.yaml` 注册;若声明 required integration,**同一套连接流**跑一遍
- 连接步骤是两分支的公共子过程——合并核心收敛点。
- bot-token 类(Discord/Telegram/QQ/WeCom)走 `apiKeyInstall` 风格分支,auth-mode 多态保留。

### Step 3 — UI 收敛(含 headless-first)

- `AddIntegrationDialog`(browse)与 `HolaAppMarketplacePane` 合并成一个「Apps」浏览面。卡片统一,connection 卡显示 **Connect**,module 卡显示 **Install/Open**。
- 新增 shell 侧通用 `AppDetailPane`,`surface:none` 时渲染它(泛化现有 `IntegrationsPane` manage 模式)。
- `AppCatalogEntry.surface` 作为**交互面**判别式(`none` 是默认、常见态,不是降级态)。
- `@holaboss/app-host` RPC **只在** `surface:hosted/local` 时接线;无头 App 不碰它。
- `IntegrationsPane` manage 模式保留并重构成「App 的账号管理」——多账号 / binding / workspace 默认账号仍是一等公民,沉在 App 之下的连接层。
- chat 里 `IntegrationProposalCard` / `WorkspaceIntegrationsRail` 指向统一概念,文案 integration → App。

## 红线(实现时盯死)

1. **Tier 0 绝不物化进程**——继续用共享 `holaboss_composio` 单 MCP server 透传。
2. **连接层(账号 / binding / 默认账号)独立于 App 实例保留**,不被「一个 App 一个实例」吃掉。
3. **bot-token 的 auth-mode 多态不丢。**
4. **connection → module 升级无损**:同 provider slug、同连接表,授权不重来。
5. **工具可用性 ≠ 面板挂载**:automation/sync/cron 无人无 UI 触发时,关掉/从不打开详情面都不能影响工具调用。webview 只是查看器,工具绝不走 app-host RPC 这条 UI 通道。

## Settings → Integrations 迁移(2026-07-13 追加)

商店 + `ConnectionAppDetail` 落地后,退役旧的 `IntegrationsPane`。**已定决策**:Settings → Integrations **彻底退役、全走商店**(Installed 图标条 → ConnectionAppDetail);后台清理**抽成 hook 挂到商店**。

### 关联地图(渲染点)
- `SettingsScreenRoot.tsx:493` `<IntegrationsPane embedded />`(Settings → Integrations,连接 + MCP)——活的。
- `CapabilityDirectoryPane.tsx:128` `mode="browse"`——活的。
- `CustomizePane.tsx:148/177`——死的(integrations tab 已隐藏)。
- Settings 导航项:`SettingsScreenRoot.tsx:95`。

### 商店已覆盖(可直接退役)
浏览目录、managed OAuth 连接、账号列表 + whoami、状态、断开、重连 gate。

### 迁移缺口
1. 🔴 每个 workspace 的**默认账号选择器**(`IntegrationsPane.handleSetWorkspaceDefault:584`,IPC `get/setWorkspaceDefaultAccount`)——商店零覆盖。
2. 🔴 **后台清理**:dedup/merge(630–780)、僵尸清扫(783–820)、pending-connect 对账(303–334)——只在 IntegrationsPane 挂载时跑。
3. 🟡 MCP 管理——已由 `McpsPane`(Customize → MCPs)接管。
4. 🟡 手动 **Refresh account info**(1200–1240)——`ConnectionAppDetail` 没有。
5. bot-token 连接在 **Channels**(`ChannelsPane`),不属本次;商店须容忍本地 bot-token 行(已容忍)。

### 分阶段(按安全顺序,删除最后做)
- **Phase A**(加法):把**默认账号选择器** + **手动 Refresh** 补进 `ConnectionAppDetail`(需把 `selectedWorkspace.id` 从 pane 传入)。
- **Phase B**(必做):三段 sweep 抽成 `useIntegrationHygiene()`,挂 `HolaAppMarketplacePane`,行为原样搬。
- **Phase C**:确认 MCP 已在 Customize → MCPs;Settings 退役时随内嵌 MCP 段一并移除,不丢功能。
- **Phase D**(最后):删 `SettingsScreenRoot` 导航项 + 渲染 + import;删 Directory 的 integrations tab;删 CustomizePane 死分支;渲染点清零后**删** `IntegrationsPane.tsx` + `AddIntegrationDialog.tsx`。保留所有共享 lib。

## 关键文件索引

- 统一目标类型:`apps/desktop/src/lib/holaAppMarketplace.ts`(`AppCatalogEntry:36`, `AppSurface:28`)
- integration 目录(降级为 feeder):`runtime/api-server/src/integration-store-catalog.ts`
- 目录 hook:`apps/desktop/src/components/layout/shell/useHolaAppCatalog.ts`
- 连接流:`apps/desktop/src/lib/useIntegrationConnect.ts`、`bindConnectionToWorkspace.ts`、`rebindWorkspaceAppsForProvider.ts`
- composio MCP ensure:`electron/main.ts:11216`(`/api/v1/composio-mcp/ensure-running`)、`runtime/api-server/src/composio-tool-registry.ts`
- 管理 UI:`apps/desktop/src/components/panes/IntegrationsPane.tsx`、`AddIntegrationDialog.tsx`
- MCP 组合:`runtime/api-server/src/mcp-compose.ts`、`workspace-apps.ts`
- 契约:`docs/plans/2026-06-27-holaapp-marketplace-api-contract.md`、`2026-06-27-holaapp-bundles-prd.md`
