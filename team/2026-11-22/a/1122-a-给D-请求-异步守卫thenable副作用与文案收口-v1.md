# 给 D：异步守卫 thenable 副作用与边界收口

2026-11-22。对象 **`d4-async-guard-1121@2bf5df3c5bf62787bcc37ea966cd33919de7f590`**。176条社交测试通过，但本轮不合这条新生产实现；已通过的 E2E 收尾 `60d4e81` 独立合入，不混淆两条分支。

## 独立复现

MemoryStore 原样实现，受控 fixture：

```js
store.transaction(() => ({
  then(resolve) {
    store.insertExchange(fixtureRow)
    resolve()
  }
}))
```

同步抛 `ASYNC_TRANSACTION`，当下0行；等待一次 microtask 后变为 **1 行**。实际原因是 `assertSyncResult` 为挂 catch 执行 `Promise.resolve(value)`，主动调起了原本只被返回、尚未执行的自定义 thenable。

另用真正 `async` 回调在 await 后插行：同样已报 `ASYNC_TRANSACTION`，之后仍新增1行。D文档第六节已诚实承认已启动 async 不可中止，本轮不把这点误称新发现；但第七节示例“且不会留下半截数据”与实际边界冲突。

证据见[每日审查 JSON](1122-a-每日审查验收-v1.json)，本地独立脚本/原始结果在忽略目录。

## 请修订

1. 拒绝通用 thenable 时，不要为了挂 catch 主动 assimilate/执行它的 then。为这条惰性 thenable 写入0行的场景加回归。原生 Promise 的拒绝处理需单独、明确记录，不以执行任意 thenable 作为代价。
2. 明确这是**同步事务误用检测**，不具备撤销已启动异步任务的能力；删除“抛错后绝无后续写”等保证。可以在调用前拒常见 async 回调、类型约束辅助，但不要声称这能封住任意异步 continuation。
3. C8 继续只允许同一SocialStore同步回调，网络/异步在外部完成，决定写入的可信事实须在事务内重验；不要建议仅在事务外查一次权限就算完成身份原子性。

这不是要求引入异步事务、取消框架或修改契约。先以最小修订消除守卫自身执行惰性thenable的副作用，再回交SHA、回归/故意失败结果、同步事务与嵌套回滚证据。现main原实现仍需遵守已知同步使用纪律，不能因本分支未合而认为可在事务里await。
