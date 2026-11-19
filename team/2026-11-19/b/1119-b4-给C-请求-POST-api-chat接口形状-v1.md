# 1119-b4 · 给 C 的请求：`POST /api/chat` 接口形状

> 经 A 站会转交，**不是已定契约**。B 不改 `contracts/`；在 C 定稿前，b4 用夹具/降级实现日常交流。

## 1. 背景与依据

- `1117-b3-聊天面板（修订后）.md:35`：`POST /api/chat` 形状未定，实现前请 c 给接口。
- `1117-11.16交付审查与修订.md:123`：需要「乐观上屏后如何确认、幂等键」。
- `STATUS.md:94,103`：c 那行仍写「尚未定义」。
- `1116-c3-接口补充-v2.md:105`：「B，尚未定义；本次不新增」。
- `1116-e3-页面流程-v2.md:536`：同上。

到 11-19 的 main 为止没有任何接口定义。b4 已按六态做夹具，接口一旦定下只需换发送函数，**不需要改 UI 状态机**。

## 2. 请 C 裁定的建议形状（供讨论，不是结论）

```
POST /api/chat
入：{ dogId: string, text: string, clientMessageId: string }
    session 由 cookie 提供，不在 body 传；text 去空格后非空，长度上限请 C 定

成功 200：
    { id: string, dogId: string, text: string, createdAt: string,
      replyText?: string }        // 可选：狗的回应，不落长期任务

幂等：clientMessageId 唯一。同一 clientMessageId 重复提交 → 返回首次结果，不新增第二条；
      同 ID 内容不同 → 409。

错误：400 text 为空或超长
      404 dogId 不属于当前 session（沿用 lib/auth/session.ts 的归属口径）
      409 clientMessageId 冲突且内容不同
      503 下游未接（b4 夹具/降级态用）

所有响应：Cache-Control: no-store；读取不触发写入。
写入范围：只写交流消息本身，不写 wish / 不生成长期任务（b4 硬约束）。
```

## 3. 为什么需要一个确定的形状

| 聊天面板状态 | 依赖接口的哪一点 |
| --- | --- |
| 发送中 | 乐观上屏后需要确认语义，界面标「还没送到」 |
| 已确认 | 需要成功响应体决定何时去掉「还没送到」 |
| 结果不确定 | 超时/丢响应要有可判别条件，且不能自动重复 POST |
| 失败 | 需要稳定的错误码区分「可重试」与「内容不合法」 |
| 幂等 | 用户连点或网络重试不能产生两条交流记录 |

## 4. B 侧的边界与时间

- 在 C 定稿并合进契约前，`app/(b)/b4-chat-fixture.ts` 保持示例通道，界面角标「示例对话」，不宣称真实送达或记忆。
- 这条**不卡 b4 交付**：夹具是 02 表第 336 行明文要求的形态。
- 请 A 在站会排优先级；B 不催 C 改 `contracts/`，也不自己写一份当既成事实。

## 5. 附：不需要 C 做的事

- 不要为 b4 新建 `v_wish_active` 视图或 `wish.source/source_url` 字段——那是另外的请求，b4 用不到。
- 不要为禁词检查新增 `scripts/check-words.sh`；`scripts/check-all.sh` 第 4 步已覆盖，`scripts/` 归 C。
