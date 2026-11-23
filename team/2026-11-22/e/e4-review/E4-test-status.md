# E4 v2 · 浏览器验收进度

沿用本地喀纳斯候选页与现有测量脚本。11 月 22 日重试 Chromium 后，浏览器在 ProcessSingleton 初始化时报 `socket() failed: Operation not permitted`，在打开页面前即退出。未产出截图或 DOM 数值。

包内已有页面和测量脚本。可在支持 Playwright 浏览器的环境从包根目录运行 `node measure-e4.cjs`，生成 375×667、320×568、1440×900 两态和 375×667 五种异常或降级态。候选页结果与仓库正式 /trip 实测应分别记录。
