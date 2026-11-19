# React 功能接入说明：B/C/D/E 从这里开始

2026-11-19；适用分支 `a5-a5b-react-1119`，代码基线 `b35a8b0`，尚未合 main。本文描述当前代码中实际存在的接入点；接口最终以 `components/app-shell/ports.ts` 和公共 `contracts/` 为准。

## 1. 先拿到正确的代码

推荐按 [群公告](1119-a-群公告-React接入与拉取-v1.md) 在新目录 clone 指定分支、启动开发模式。已有仓库也可以另开 worktree，不切换自己的业务分支；在仓库根执行：

```powershell
git fetch origin
git worktree add -b review-a5-v25 ..\kan-a5-v25 origin/a5-a5b-react-1119
Set-Location ..\kan-a5-v25
```

`review-a5-v25` 和目标目录须尚未存在；若已建好，就进入那份目录更新，不重复创建。在 review 分支更新 A 基线可执行 `git pull --ff-only origin a5-a5b-react-1119`，仅用于这份无自己业务提交的预览检出。

安装与启动仍使用公告中的 `npm.cmd ci`、两个环境变量和 dev 命令。专用 `a5-development*.sqlite` 开发库与非 production 模式是必需条件，默认配置不会开放测试身份。Node 版本用 `node --version` 查看，应为 24+。

接功能前，把“从哪个基线开发”写在回交说明中。可以从 A 分支另开自己的功能分支进行适配，也可以保留既有业务分支交导出与依赖清单，由 A 集成；不要把预览目录当多人共推的集成分支，也不要通过强推/重置覆盖已有业务。

## 2. 理解现在的结构

| 文件/目录 | 做什么 | 谁维护 |
| --- | --- | --- |
| `app/layout.tsx` | 根布局已包 AppProviders，所有路由组共享上下文 | A |
| `app/(a)/adopt`、`home`、`trip` | 三个实际路由的薄入口 | A |
| `components/app-shell/adopt-page.tsx` | 领养状态与请求、草稿、创建重试 | A |
| `components/app-shell/home-page.tsx` | 小屋固定入口、角色与状态 | A |
| `components/app-shell/trip-page.tsx` | 过程/归来页面及内容读取 | A |
| `components/app-shell/shell.tsx` | 会话、单一面板、草稿挂载、焦点、扩展注册 | A |
| `components/app-shell/ports.ts` | 组件/读取适配器的类型边界 | A 收口，相关负责人一起核对 |
| `components/app-shell/wiring.tsx` | 把真实模块绑定到页面，目前 bindings 为空 | **仅 A 修改** |
| `components/v25/presentation.tsx` | Frame、信纸、参考角色和静态场景 | A；正式角色通过 E 接入 |
| `components/v25/theme.css` | 从原稿生成的隔离主题，不手改 | A，生成脚本 `scripts/a5/sync-v25.cjs` |
| `components/v25/integration.css` | React 接入覆盖和本次穿搭尺寸修订 | A |
| `lib/adoption` | 暂行页面 DTO、仅开发身份的 HTTP/存储实现 | A；C 收口正式身份与公共契约 |
| `contracts/` | 公共业务类型、API、schema 与迁移约定 | C 的契约流程 |

`app/(a)/_design/a4-v25` 是保留的静态参考。实际页面不加载其 app.js、HomeAdapters 或 KanshanMotion。React Hooks、事件和 CSS 应写在自己的模块内，不能把参考 HTML 的全局脚本再次引入产品。

## 3. B：聊天、心愿与邀请

聊天、心愿只交面板正文，类型都是：

```ts
import type { PanelContext } from '@/components/app-shell/ports'

// 组件可用默认导出或命名导出，回交时写清导出名。
// ChatPanel / WishPanel 的 props 必须能接受：
type Props = PanelContext
// { dogId: string; reducedMotion: boolean;
//   onClose: () => void; onCommitted: () => void }
```

| 参数 | 用法 |
| --- | --- |
| `dogId` | 当前伙伴 ID；服务端仍必须校验当前账号归属，不能只信这个参数 |
| `reducedMotion` | 系统或用户要求减少动态时为 true；当前保持静态 |
| `onClose()` | 需要收起面板时调用，关闭行为交给宿主 |
| `onCommitted()` | **真实写入成功后**通知宿主刷新会话/伙伴信息；不代表宿主会刷新你组件的业务列表 |

列表更新仍由正文自己在成功后处理。失败保留输入，分别呈现空列表、加载、失败、未授权；不自动回退 fixture 或提示假成功。自己的请求在卸载/换 dogId 时取消或丢弃旧响应。

宿主负责标题、关闭按钮、遮罩、Escape、焦点恢复。正文不再创建 dialog、全屏遮罩、第二套头部/导航/登录。面板首次打开后会保留挂载，关闭或切换只是隐藏；当前 props **没有 active 信号**，不要假设隐藏会卸载、自动停止定时器。需要 active 订阅控制时先提最小扩展，由 A 改共同类型。

固定 `chat`、`wish` 由 A 直接绑定，不调用 registerFeature。邀请在归来区的现有接口：

```ts
type InvitationProps = {
  dogId: string
  tripId: string
  origin: 'trip'
  returnTo: string
}
```

这里的 origin 是页面上下文，不是新增回应来源枚举；提交仍用公共契约的 invitationId/exchangeId 规则。来信、手账应复用 B 的回应能力，但不能把当前只允许 `'trip'` 的绑定直接当三路通用签名；由 B/E/A 对齐适配，返回各自入口，不复制三套回应实现。

## 4. C：身份与归来读取

页面暂行 DTO 见 `lib/adoption/view.ts`。当前开发接口包括 `/api/session`、`/api/auth/development`、`/api/adoption/profile`、`/api/adoption/personality`、`/api/dogs` 与改名接口。它们可演练流程，但不代表正式账号底座已完成；当前退出只清 cookie，服务端撤销仍待交。

真实身份要统一 C4/B/D/E 的归属读取，落实一真实账号一狗、跨浏览器恢复、测试狗不迁移、创建幂等和会话撤销。浏览器不传 owner/token，不接收完整私有 Dog。`draftScope` 仅用于按身份隔离浏览器草稿，不能当鉴权凭证；六倾向保留 `[-2,2]`、步进 `0.2` 的 21 档精度。

归来页现有读取边界：

```ts
import type { TripContent } from '@/components/app-shell/ports'

// 返回值使用 contracts 的 Find / Message，不另造同义业务模型。
type ReadTripContent = (
  tripId: string,
  signal: AbortSignal,
) => Promise<TripContent>
// TripContent = { finds: Find[]; message: Message | null }
```

请交只读端点、归属校验、排序、空值/部分内容语义与错误规则。A 在 wiring 写 fetch 适配器；如果实际端点拆为两条，由 A 组合。读取不能触发 finish、投递或写 Message。页面已区分 running 与 done/timeout/failed：running 不创建发现区，终态读取已有内容；失败不冒充空结果。

## 5. D：业务事实通过现有服务交付

D 无需新建 A 的导航或会话。匹配、关系、交换、礼物/捎话与测试池规则继续由 D 的服务收口；C 统一 owner 契约后消费它。开发池不接正式匹配，不因页面加载/打开面板写社交事实。同一经历与出处保持一致。

跳过兴趣当前为 null，Snapshot 兴趣为数组；转换由 C/D 定一套规则，不在页面编造兴趣。向 E 提供 snapshot=null、过滤后空结果、真正读取失败的区别与字段白名单。寄礼物/朋友圈入口未在本轮新增，若需入口先给 A 动作和返回规则。

## 6. E：正式角色、两态视觉和来信/手账

正式角色绑定接收：

```ts
import type { Assembly } from '@/contracts/types'
type DogProps = { assembly: Assembly; reducedMotion: boolean }
```

交组件导出及 manifest：素材路径、尺寸、原点/足底锚点、层序、none/null、阴影归属、组合截图。当前参考角色外框为 100×116，足底 `(50,107.5)`；正式素材可不同，但要在渲染器内部归一，不能让各页面分别补偏移。组件应适应宿主大小，避免写死页面坐标。不要向 Assembly 增加 body/color/path 等额外键。

**当前替换范围要注意：** ReferenceActor 使用 Dog 绑定（穿搭、创建门口、小屋、档案）。授权/名字/倾向/标签左侧仍是 v25 的整张组合插画，其中角色没有独立分离；不是接了 Dog 就会自动替换那张图。若需该区域独立角色动画，E 交背景/角色拆分方案，由 A 适配。

旅途仍是 A 写页面、E 交两态视觉。简单静态图可交给 `tripScenes: { running: string; done: string }`；公共资源放 `public/`，绑定 URL 使用 `/assets/...`，不带 `public/` 前缀。若图不足以表达布局，请交 React 视觉组件和最小 props 建议，由 A 收口；不要另建 `/trip`。

来信/手账实际路由 `/mailbox`、`/journal` 由 E 实现；正文、请求与错误态就绪后，A 才打开 `routes.mailbox/journal`。这两个布尔标志只控制入口，不会自动创建路由或业务能力。根布局已包 Provider，不要再包第二个。

当前穿搭使用固定参考看山，四键选择照常保存。桌面看山左栏居中、345×400 是用户最新修订；原稿保留，手机布局沿用 v25。

## 7. 动效与新入口：先核对缺口

当前只有 Dog 替换口、reducedMotion 和静态反馈；原稿的按钮 UI 效果、角色动作事件、滑块松手动作**没有迁入 React**。不要直接调用 window.HomeAdapters/KanshanMotion，也不要各自绑定一套全局事件。动作接口、事件阶段和清理由 A 收口后再接 E 的实现；静态确认前不启用动画。

确有新增功能入口时可使用宿主的 `registerFeature`，注册会返回清理函数；id 必须唯一、匹配小写字母开头的英文/数字/连字符，label 1–4 字。`profile/settings/chat/wish/mail/journal` 六个固定 id 禁止重复注册。是否增加业务入口先与 A 核对，不因为接口存在就扩充产品范围。

新正文用自己命名的 CSS Module，避免全局 button/main 等选择器。v25 的 `[data-v25]` 样式会影响其内部正文，A 负责最终视觉组合；不要手改生成的 theme.css，也不要用页面私有偏移补偿正式角色素材问题。

## 8. 回交与验证

先在自己的分支交组件/服务与说明，A 负责把已验证导出放进唯一 `bindings`。**bindings 目前为空，所以页面中禁用的四个入口不算集成完成。** 不需要队员为联调直接提交 A 的 wiring 改动。

回交说明请写清：

1. 分支、commit、开发基线，新增/修改文件与实际导出名。
2. props 或服务签名，实际 HTTP 路由、方法、请求/响应与鉴权；尚未合并的依赖分支/commit。
3. 是否有 schema/迁移/环境变量变化；公共契约变更交 C 流程。
4. 加载、空、失败、无权限、重试、重复提交和旧响应处理的验证结果。
5. 手机 375、平板 768、桌面 1440、横屏 812 的截图或结果；关闭重开保草稿、切换身份不串数据。

基础检查（仓库根，Node 24+）：

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build
```

提交前再在 Git Bash 跑 `bash scripts/check-all.sh`。UI 复验脚本 `scripts/a5/verify-ui.cjs`、`verify-v25.cjs`、`verify-process-states.cjs` 需要另有 Chrome 与 Playwright 等宿主工具依赖，普通 npm ci 不会安装这些工具；缺工具时先完成基础检查和人工场景验证，在交付中说明，不把未运行写成通过。

## 9. 各自的详细请求

- B：[面板与邀请 v1](1119-a5b-给B-请求-面板与邀请接入-v1.md)。
- C：[身份/归来读取 v1](1119-a5-给C-请求-身份与归来读取契约-v1.md)、[输入精度/草稿隔离 v2](1119-a5-给C-请求-v25输入与草稿隔离-v2.md)。
- D：[归属与测试池隔离 v1](1119-a5-给D-请求-归属与测试池隔离-v1.md)。
- E：[两态视觉/页面 v1](1119-a5b-给E-请求-两态视觉与页面适配-v1.md)、[v25 接入补充 v2](1119-a5b-给E-请求-v25接入补充-v2.md)。
- 最新事实：[入口表 v3](1119-a5b-入口表-v3.md)、[接口与过程页复核 v3](1119-a5-v25接口与过程页复核-v3.md)。历史请求的旧视觉描述以这些最新说明为准。
