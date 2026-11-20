# 群公告：React 页面已推分支，请从指定分支拉取

各位，A 的 React 领养、小屋和统一面板容器已推送，**还没有合并 main**。只 pull main 看不到这批改动。

**仓库：** https://github.com/Sadie1226/zhihu-hackathon

**分支：** `a5-a5b-react-1119`

**在线查看：** [GitHub 分支目录](https://github.com/Sadie1226/zhihu-hackathon/tree/a5-a5b-react-1119)

**当前代码基线：** `b35a8b0`（之后可能继续增加接入文档）。

## 怎么拿到

推荐在自己的工作目录旁新拉一份，保留原来的业务分支和未提交修改。在你准备放项目的目录打开 PowerShell：

```powershell
git clone --branch a5-a5b-react-1119 --single-branch https://github.com/Sadie1226/zhihu-hackathon.git kan-a5-v25
Set-Location .\kan-a5-v25
npm.cmd ci --no-audit --no-fund
$env:APP_IDENTITY_PROVIDER='development'
$env:DATABASE_PATH='./data/a5-development-review.sqlite'
npm.cmd run dev -- --hostname 127.0.0.1 --port 3105
```

需要 Node 24+。打开自己电脑的 http://127.0.0.1:3105/adopt ，用“以测试身份开始”领养后看小屋。这是本地地址，不是已部署的公网链接；不需要配置知乎密钥。

若你已经有一份**专门用于此分支的干净检出**，先确认 `git branch --show-current` 为 `a5-a5b-react-1119`，再更新：

```powershell
git pull --ff-only origin a5-a5b-react-1119
```

不要在自己的 B/C/D/E 业务分支直接执行这条 pull 来“看效果”，那会尝试把 A 分支合进当前分支。已有仓库另开目录查看的方法见下方 React 说明。

## 这次有什么，大家接哪里

- **A 已搭好：** 六场景领养、真实 React 小屋、档案改名/设置、单一面板、测试身份持久化、等待/失败/重试状态；v25 静态视觉已迁入。穿搭页看山按最新要求左栏居中、放大 25%。
- **B：** 交聊天/心愿面板的正文组件，以及可复用邀请/回应组件；不要再套弹窗或做另一套导航。
- **C：** 收口正式身份/会话/唯一归属/创建幂等及归来内容只读接口；A 当前开发身份不等于真实 OAuth 完成。
- **D：** 对齐稳定 owner、测试池隔离、兴趣为空/快照为空与社交事实读取；不要在页面加载时创建交换或投递。
- **E：** 交正式看山渲染器、旅途过程/归来两态视觉，以及来信/手账页面。**旅途页面由 A 实现，E 交视觉**，以 11-19 的 02 为准。

所有模块由 A 在 `components/app-shell/wiring.tsx` 统一装配；各位交自己的组件/服务导出，不多人修改这个文件。实际接口看 `components/app-shell/ports.ts`。

**注意现状：** 聊聊/心愿/来信/手账尚未接通，当前禁用；真实 OAuth、正式角色和旅途两态仍待接。原静态稿的按钮动效、角色动作事件尚未迁入 React，现在只留了 Dog 替换口与减少动态偏好，暂不启用动画。

请先读 [React 功能接入说明](1119-a-React功能接入说明-v1.md)，再按自己的请求单接入。回交时附：**分支 + commit、导出路径、真实接口/依赖、测试结果、手机/桌面截图**。A 统一适配、验证后再合 main；请求文件不算对方已完成交付。
