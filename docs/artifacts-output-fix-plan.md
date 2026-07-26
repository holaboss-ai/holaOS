# Artifacts / Output 待办与修改方法

> 状态图例:🐛 Bug · ✨ 功能 · 🤔 决策待拍板 · ⏸️ 暂缓

---

## 🐛 Bug

### 1. Agent 写 doc 时文件落到了 workspace 外面
- **现象**:让 agent 写 doc,文件被写到沙箱/工作目录之外,实际 workspace 文件夹是空的。属于核心链路问题(agent 产出文件)。
- **修改方法**:排查 runtime/harness 的 file-write 工具,确保写入路径**以 workspace 根目录解析**,而不是进程 cwd。Agent 的所有产出文件必须落在 `/holaboss/workspace/<workspace_id>/` 内。重点看 harness 的工作目录设置 + write_file 工具的路径拼接。
- **涉及**:`holaOS/runtime/`(harness-host / api-server 的文件写入),可能联动后端沙箱 cwd。
- **备注**:〔需 runtime 侧排查后再定确切改法〕

### 2. (= #1)
- PM 确认:**和 #1 是同一个问题**,随 #1 一起排查修复即可,不单列。

---

## ✨ 功能 / 改进

### 3. 浏览器 overflow 弹窗(Downloads / History / Import browser profile)样式奇怪 → 改用纯 native 菜单
- **现状**:浏览器 "..." 更多菜单是一个**手写 HTML + CSS 的自定义 WebContents 弹窗**——`browser-pane/popups.ts` 的 `createOverflowPopupHtml(themeCss)`(`~455-527`),通过 `browser:toggleOverflowPopup` 打开。自定义样式导致观感怪。
- **修改方法**:弃用自定义 HTML 弹窗,改成 **Electron 原生菜单**——`Menu.buildFromTemplate([Downloads / History / Import browser profile]).popup({ window, x, y })`,在锚点位置弹出系统原生下拉,不写任何 HTML/CSS。原来的三个动作(openDownloads / openHistory / openImportProfile)直接挂到菜单项的 `click` 上。
- **涉及**:`apps/desktop/electron/browser-pane/popups.ts`(删除 `createOverflowPopupHtml` 那条路径,`toggleOverflowPopup` 改为弹原生 Menu)、`overflowPopupPreload.ts`(可一并移除)。
- **备注**:原生 Menu 用主题色受限(跟随系统),但这正是"纯 native 不加样式"的取舍。

### 4. pptx 只读预览(方向已定)
- **结论**:pptx 只做只读预览,**不做 editor**(editor 成本高)。无需额外开发,保持现状。

### 5. HTML 输出:已支持,找优化空间
- **澄清**(PM):本意是"html 文件没支持";经核实 **html/htm 已在 `DOCUMENT_EXTENSIONS`(`ArtifactBrowserModal.tsx:76-77`)、已被归为 Document 且能用内置 tab 打开**——基础已支持。
- **转为:找优化空间**(已支持,不必从零做):
  - 打开 html 文件时给一个**真正的网页预览**(渲染而非纯文本/编辑器),贴近"这是个网页"的直觉。
  - 把 HTML 从 Documents 里**单列一个 "Web page" kind**(图标/标签更准确)。
  - 支持**内容型 HTML 输出**(`html_content` 字段、无文件)的渲染。
- **涉及**:`ArtifactBrowserModal.tsx`(归类/kind)、`useOpenWorkspaceOutput.ts`(打开/预览)。
- **优先级**:低(锦上添花,基础可用)。

### 6. Apps 类型空状态加入口
- **现状**:Apps filter 下没有内容时缺引导。
- **修改方法**:ArtifactsPane 的 Apps 过滤为空时,渲染一个引导入口(连接/安装 app 的 CTA)。
- **涉及**:`apps/desktop/src/components/panes/ArtifactsPane.tsx`(注:增强版在 `release/2026.612`)。

### 7. 让"能 pin 的地方尽量都有 pin"
- **目标**(PM):Pin(= 收藏 / `toggleFavoriteAtom`)不必新建概念,只要**凡是展示 artifact/文件/output 的表面,都提供 pin(star)入口**,保持一致。
- **修改方法**:盘点所有展示这些项目的表面,逐一确认有 pin 操作(行内 star 或右键菜单),缺的补上。已知已有:artifact 行 star、文件树右键 "Pin to sidebar"。需要排查补齐的候选:Recent 列表项、聊天内联 Outputs 行、文件预览(FilePreviewPane)、搜索结果等。
- **涉及**:`favorites.ts`(`toggleFavoriteAtom` / `favoriteKey`)、各展示表面(ArtifactsPane / Outputs / FilePreviewPane / Recent / 搜索)。
- **做法**:统一复用 `toggleFavoriteAtom` + `isFavoriteAtom`,在缺失处加一致的 star 按钮/菜单项。

---

## 🤔 决策待拍板

### 8. 只删除浏览器书签栏的 "Folders" 按钮
- **决定**(PM):**导入保留、书签保留(有意义)**——书签栏继续显示散装书签,**只删掉 "Folders" 那个弹层按钮**。
- **修改方法**:在 `BrowserPane.tsx` 移除 `bookmarkTree.folders.length > 0` 时渲染的那段 Folders `Popover`(`~1059-1087`)。书签栏(`showBookmarkStrip`)和散装书签(`rootBookmarks`)保持不动;`bookmarkTree.folders` 的数据可以保留不用,也可顺手不再渲染。
- **涉及**:`apps/desktop/src/components/panes/BrowserPane.tsx`(仅那一段)。
- **范围**:不动 `BrowserProfileImportButton` / 导入流程 / 书签栏其余部分。

### 9. 实现 Artifact template(合并自原 13 / 15 / 17)— PM:做
- **现状(已查清)**:
  - 现有 "Save as template"(`SaveTemplateDialog` + Sidebar 2743 + IPC `workspace:saveAsTemplate` → `saveWorkspaceAsTemplate`)是 **workspace 级模板**:把整个 workspace 目录拷到 `userData/local-templates/<id>/`,供"新建 workspace"复用。
  - **没有** artifact(单个产出物)级别的模板机制。
- **目标**:让用户把**某个 artifact**(docx/pptx/xlsx/report 等)存成可复用模板,下次创建同类产出直接套用。

- **实现方法(建议)**:
  1. **存储**:镜像现有 local-templates 模式,新增 `userData/local-artifact-templates/<templateId>/`,内放 ① 该 artifact 的文件副本 ② `template.json` manifest(`output_type` / `title` / `extension` / 来源 metadata / emoji / 描述)。
  2. **入口(存)**:在 artifact 行的 `⋯` 菜单加 "Save as artifact template"(复用上一个 PR 已建的 ArtifactRow 行操作菜单),弹一个轻量 dialog 收名称/描述(复用 `SaveTemplateDialog` 模式)。
  3. **IPC**:新增 `workspace:saveArtifactAsTemplate`(拷文件 + 写 manifest)、`workspace:listArtifactTemplates`、`workspace:deleteArtifactTemplate`,在 `main.ts` 仿 `saveWorkspaceAsTemplate` 实现。
  4. **入口(用)**:在 Output 创建选择器(`Sidebar.tsx:3574-3624` 的 Folder/Markdown/Word/… picker)末尾追加 "From template…",列出已存的 artifact 模板;选中后把模板文件拷进当前 workspace 作为新文件(再交给 agent/editor)。
  5. **(可选)agent 复用**:把 artifact 模板登记进 workspace.yaml / skills,让 agent 创建同类产出时能引用模板结构。

- **涉及**:`electron/main.ts`(新 IPC + saveArtifactAsTemplate 实现,仿 `saveWorkspaceAsTemplate`)、`preload.ts`、`electron.d.ts`、`SaveTemplateDialog.tsx`(或新建轻量版)、`Sidebar.tsx`(创建选择器加 "From template")、ArtifactRow 行菜单。
- **备注**:〔请 PM 确认范围:先做 1-4(存 + 在创建流程里复用)即可,第 5 步 agent 复用作为后续;另确认"artifact 模板"是 per-workspace 还是全局共享〕

---

## ⏸️ 暂缓

### docx editor 操作图标清晰化
- docx 已支持 editor;操作图标可读性提升**暂缓**,后续再做。

---

## 已剔除(讨论后确认非任务)
- ~~editor 崩溃~~ — 实际没有此问题。
- ~~"创建 → 弹对话框 → agent 跑"统一流程~~ — 暂时不用。
- ~~可复用小组件~~ — 非确认任务。
- ~~看图识别录入 Notion / 看图自动填输入框~~ — 没有此任务。
- ~~plugin onboarding 表单(@Sam)~~ — 不在本范围。
