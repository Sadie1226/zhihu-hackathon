/**
 * 在整库所有文本列里搜一段字，返回命中的表 / 列 / 行数。
 *
 * 为什么要扫全库而不是列白名单：串味不会只发生在某一处。今天可能是 `exchange.payload`，
 * 明天有人给 `snapshot` 加个字段，后天是某个诊断表。白名单会漏，全库搜不会 ——
 * 多花的这点时间很值。（这条最早写在 d7 的用例里，这里抽出来给 d10 复用。）
 *
 * 两个刻意的选择：
 *   · 只扫文本类型列。整型/布尔 CAST 成文本也可能巧合命中，那是噪声不是证据。
 *   · 查不动就抛错，不跳过。跳过的表会被误当成「干净」，那是比漏检更坏的结论。
 */
export function findTextEverywhere(db, needle) {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all()
  const hits = []
  for (const { name: table } of tables) {
    const columns = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all()
    for (const { name: column, type } of columns) {
      if (!/CHAR|CLOB|TEXT/i.test(String(type ?? ''))) continue
      let rows
      try {
        rows = db
          .prepare(`SELECT count(*) AS n FROM ${JSON.stringify(table)}
            WHERE CAST(${JSON.stringify(column)} AS TEXT) LIKE ?`)
          .get(`%${needle}%`).n
      } catch (error) {
        throw new Error(
          `扫描 ${table}.${column} 失败（${error.message}）—— 不能因为查不了就当作没命中`,
          { cause: error },
        )
      }
      if (rows > 0) hits.push({ table, column, rows })
    }
  }
  return hits
}

/** 把命中结果压成 `表.列` 的可读清单，方便断言里直接比。 */
export function hitList(hits) {
  return hits.map((hit) => `${hit.table}.${hit.column}`)
}
