# A4 静态预览 v25

A4 领养线框与字段标注的独立 HTML 预览，归 A 维护。`_design` 是 Next.js 私有文件夹，不注册产品路由；本包不代表 A5 生产实现。

在仓库根目录运行：

```powershell
python -m http.server 8767 --directory "app\(a)\_design\a4-v25"
```

打开 http://127.0.0.1:8767/index.html 。顶部可选择页面与验收状态，底部有字段标注。

- 领养入口：`index.html?page=auth`
- 小屋站姿：`index.html?page=home`
- 小屋坐姿：`index.html?page=home&state=sitting`

预览没有真实授权、模型调用或服务端写入。演示草稿保存在当前浏览器页签的 sessionStorage；穿搭选择仅保存草稿，角色固定为参考看山。坐姿为静态素材，动画尚未启用。

字段、状态、资源分别集中于 config.js、preview-service.js、wardrobe.js、home-scene.js；角色阴影在角色容器内部，姿态与阴影共同使用脚底锚点。动作、功能扩展和 UI 动效接口保留，正式资产/契约接入仍属后续实现。

## 复验

在本目录安装隔离的开发依赖并运行（需要已安装 Google Chrome；其他 Chromium 可设置 CHROME_PATH）：

```powershell
npm.cmd install
npm.cmd test
```

四套脚本检查 99 个页面/视口组合、20 项交互/动作接口、111 项小屋行为、20 项 v25 布局/扩展及 30 项阴影/姿态条件。输出 JSON 与截图由本地生成并忽略，不冒充真实后端验收。设计说明与交付截图见仓库 team/2026-11-18/a/1118-a4-领养线框-v1.md。

素材由用户提供的参考图与 AI 生成/编辑素材加工形成，仅用于本项目 A4 设计评审；本包不包含参考聊天截图、历史备份、生成凭据或机器绝对路径。角色五张静态拆分层不等于完整动作部件，也不是已定稿的 C/E 正式装配标准。
