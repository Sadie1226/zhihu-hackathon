# 数据库历史基线

`schema-v1.sql` 原样取自 main 提交 `edd8592` 的 `contracts/schema.sql`，只统一 LF 换行；不含 event/trip_event。它是版本 1 升级测试的固定输入，不能随当前 schema 一起更新，否则会把旧库升级误测成新库初始化。

测试通过原 C2 `initializeDatabase(db, () => historicalSchema, [])` 建真实版本 1 临时库，再写入明确标记为 fixture 的 dog、trip、exchange 数据。用户应用数据库不参与测试。
