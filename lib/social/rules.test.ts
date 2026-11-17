/**
 * rules.ts 的用例。15 正例 + 13 反例，跑法：
 *
 *   node --experimental-strip-types lib/social/rules.test.ts
 *
 * 跑绿的标准不是「全过了」，是 **反例 16 被拒且理由是 UNKNOWN_KEY** ——
 * 前者说明白名单结构生效了，如果它报 FORBIDDEN_KEY，说明在靠关键词猜，猜是会漏的。
 *
 * 两处对原规格的调整，写在前面：
 *
 *   1. **测试对象自带 imagePath，不是数据缺口。** types.ts 11-16 晚加了
 *      `imagePath: string | null`（必填键）；本分支基于 `43d623f`，那版 fixture
 *      还没有这个键。**main 上已补齐**（`ex_gift` 带真实图路径
 *      `/assets/gen/fixture-yarn.webp`），所以不用找 c 补，只是基线旧。
 *      测试里各对象自带 `imagePath: null`，跑在哪个基线都通。
 *      —— 2026-11-17 更正：初版注释误报成「c 的数据缺口」，已撤回。
 *
 *   2. **反例 26 改了内容。** 原方案是「sourceMode: 'live' 但 sourceUrl: null」，
 *      但 sourceMode 还没批，传了会先被 UNKNOWN_KEY 拒，测不到那条规则。
 *      改成「sourceUrl 不是知乎域名」—— 这条现在就能测，且是同一类错误。
 *      sourceMode 批下来后把原方案加回来。
 */

import assert from 'node:assert/strict'
import { normalize, validate, countChars } from './rules.ts'

let pass = 0
let fail = 0
const failures: string[] = []

function expectOk(name: string, draft: unknown, opts?: { blockedTopics?: string[] }): void {
  const v = validate(draft, opts)
  if (v.ok) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    const msg = `${name} → 期望通过，实际被拒：${v.code} @ ${v.path}（${v.reason}）`
    failures.push(msg)
    console.log(`  ❌ ${msg}`)
  }
}

function expectCode(
  name: string,
  draft: unknown,
  code: string,
  opts?: { blockedTopics?: string[] },
): void {
  const v = validate(draft, opts)
  if (v.ok) {
    fail++
    const msg = `${name} → 期望 ${code}，实际通过`
    failures.push(msg)
    console.log(`  ❌ ${msg}`)
    return
  }
  if (v.code !== code) {
    fail++
    const msg = `${name} → 期望 ${code}，实际 ${v.code} @ ${v.path}（${v.reason}）`
    failures.push(msg)
    console.log(`  ❌ ${msg}`)
    return
  }
  pass++
  console.log(`  ✅ ${name} → ${v.code}`)
}

// ===========================================================================
// 正例
// ===========================================================================

console.log('\n【正例】fixtures/exchange.json 四条')

// 1. ex_gift —— 基线 43d623f 早于 imagePath 引入，测试对象自带该键
expectOk('1 ex_gift（自带 imagePath: null）', {
  fromDog: 'dog_seed_07',
  toDog: 'dog_owner',
  kind: 'gift',
  payload: {
    kind: 'gift',
    giftName: '一小卷灰蓝色的毛线',
    note: '天气要冷了',
    imagePath: null,
  },
})

// 2. ex_find
expectOk('2 ex_find', {
  fromDog: 'dog_seed_07',
  toDog: 'dog_owner',
  kind: 'find',
  payload: {
    kind: 'find',
    findTitle: '修鞋摊旁边的搪瓷缸',
    findExcerpt: '缸沿上磕了两个口，茶还是满的。',
    sourceUrl: null,
  },
})

// 3. ex_greeting
expectOk('3 ex_greeting', {
  fromDog: 'dog_owner',
  toDog: 'dog_seed_07',
  kind: 'greeting',
  payload: { kind: 'greeting', line: '这边下了两天雨，你那边呢', weather: '雨' },
})

// 4. ex_co_owner_message
expectOk('4 ex_co_owner_message', {
  fromDog: 'dog_owner',
  toDog: 'dog_seed_07',
  kind: 'co_owner_message',
  payload: {
    kind: 'co_owner_message',
    message: '楼下的桂花开了，你那边闻得到吗',
    fromOwnerOf: 'dog_owner',
  },
})

console.log('\n【正例】d1 十例（e 拿来当文案底本，c 拿来当 fixtures 正例）')

// 5. 例1 find · 看物的狗给对方看一个物 —— 石头 → 豆子
expectOk('5 d1-1 石头→豆子 find 搪瓷缸', {
  fromDog: 'dog_shitou',
  toDog: 'dog_douzi',
  kind: 'find',
  payload: {
    kind: 'find',
    findTitle: '修鞋摊旁边的搪瓷缸',
    findExcerpt: '缸沿上磕了两个口，茶还是满的。',
    sourceUrl: null,
  },
})

// 6. 例2 find · 看人的狗注意的是人 —— 老周 → 小满
expectOk('6 d1-2 老周→小满 find 老陈没出摊', {
  fromDog: 'dog_laozhou',
  toDog: 'dog_xiaoman',
  kind: 'find',
  payload: {
    kind: 'find',
    findTitle: '修鞋的老陈今天没出摊',
    findExcerpt: '工具箱还在，上面压了块砖。',
    sourceUrl: null,
  },
})

// 7. 例3 find · 带真实出处 —— 慢慢 → 三毛
expectOk('7 d1-3 慢慢→三毛 find 井盖为什么是圆的', {
  fromDog: 'dog_manman',
  toDog: 'dog_sanmao',
  kind: 'find',
  payload: {
    kind: 'find',
    findTitle: '为什么井盖是圆的',
    findExcerpt: '因为圆的怎么转都不会掉下去。',
    sourceUrl: 'https://www.zhihu.com/question/000000000/answer/000000000',
  },
})

// 8. 例4 find · 风景 —— 秋秋 → 团子
expectOk('8 d1-4 秋秋→团子 find 河面上的雾', {
  fromDog: 'dog_qiuqiu',
  toDog: 'dog_tuanzi',
  kind: 'find',
  payload: {
    kind: 'find',
    findTitle: '河面上的雾',
    findExcerpt: '七点还没散，对岸的楼只剩轮廓。',
    sourceUrl: null,
  },
})

// 9. 例5 greeting · 话痨 —— 吵吵 → 叮当
expectOk('9 d1-5 吵吵→叮当 greeting 下雨', {
  fromDog: 'dog_chaochao',
  toDog: 'dog_dingdang',
  kind: 'greeting',
  payload: { kind: 'greeting', line: '这边下了两天雨，路上全是水，你那边呢。', weather: '雨' },
})

// 10. 例6 greeting · 寡言 —— 阿盐 → 灰灰
expectOk('10 d1-6 阿盐→灰灰 greeting 我这边晴', {
  fromDog: 'dog_ayan',
  toDog: 'dog_huihui',
  kind: 'greeting',
  payload: { kind: 'greeting', line: '我这边晴。', weather: '晴' },
})

// 11. 例7 gift · 婉转 —— 年糕 → 麦子（测试对象自带 imagePath）
expectOk('11 d1-7 年糕→麦子 gift 毛线', {
  fromDog: 'dog_niangao',
  toDog: 'dog_maizi',
  kind: 'gift',
  payload: {
    kind: 'gift',
    giftName: '一小卷灰蓝色的毛线',
    note: '天气要冷了',
    imagePath: null,
  },
})

// 12. 例8 gift · 直给，note 为 null —— 铁蛋 → 冒冒
expectOk('12 d1-8 铁蛋→冒冒 gift 石头 note:null', {
  fromDog: 'dog_tiedan',
  toDog: 'dog_maomao',
  kind: 'gift',
  payload: {
    kind: 'gift',
    giftName: '一块被水冲圆的石头',
    note: null,
    imagePath: null,
  },
})

// 13. 例9 co_owner_message · 豆子的主人 → 石头
expectOk('13 d1-9 豆子主人→石头 捎话桂花', {
  fromDog: 'dog_douzi',
  toDog: 'dog_shitou',
  kind: 'co_owner_message',
  payload: { kind: 'co_owner_message', message: '楼下的桂花开了', fromOwnerOf: 'dog_douzi' },
})

// 14. 例10 co_owner_message · 收件方是种子狗
expectOk('14 d1-10 小满主人→石头 捎话书店', {
  fromDog: 'dog_xiaoman',
  toDog: 'dog_shitou',
  kind: 'co_owner_message',
  payload: {
    kind: 'co_owner_message',
    message: '下次路过那家书店，帮我看看有没有植物图鉴',
    fromOwnerOf: 'dog_xiaoman',
  },
})

// 15. gift 带图 —— 11-16 晚新增 imagePath 的正例
expectOk('15 gift 带 imagePath', {
  fromDog: 'dog_niangao',
  toDog: 'dog_maizi',
  kind: 'gift',
  payload: {
    kind: 'gift',
    giftName: '一小卷灰蓝色的毛线',
    note: null,
    imagePath: '/assets/gen/gift-niangao-01.webp',
  },
})

// ===========================================================================
// 反例
// ===========================================================================

console.log('\n【反例】每条必须只报一个错，且报对')

// 16. 塞主人聊天原文 —— 这份规格的验收标准
expectCode(
  '16 payload 塞 chatText（主人聊天原文）',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'gift',
    payload: {
      kind: 'gift',
      giftName: '一颗糖',
      note: null,
      imagePath: null,
      chatText: '主人昨天说她想回老家',
    },
  },
  'UNKNOWN_KEY',
)

// 17. chatSummary —— 摘要也算原文派生
expectCode(
  '17 payload 塞 chatSummary',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'greeting',
    payload: { kind: 'greeting', line: '我这边晴。', weather: '晴', chatSummary: '主人最近很累' },
  },
  'FORBIDDEN_KEY',
)

// 18. deliverAfterTripSeq —— c 算，d 不许传
expectCode(
  '18 传 deliverAfterTripSeq',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'greeting',
    payload: { kind: 'greeting', line: '我这边晴。', weather: '晴' },
    deliverAfterTripSeq: 3,
  },
  'FORBIDDEN_KEY',
)

// 19. deliveredAt —— c 独占
expectCode(
  '19 传 deliveredAt',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'greeting',
    payload: { kind: 'greeting', line: '我这边晴。', weather: '晴' },
    deliveredAt: '2026-11-17T00:00:00Z',
  },
  'FORBIDDEN_KEY',
)

// 20. 狗给自己寄东西
expectCode(
  '20 fromDog === toDog',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_a1',
    kind: 'greeting',
    payload: { kind: 'greeting', line: '我这边晴。', weather: '晴' },
  },
  'SELF_EXCHANGE',
)

// 21. 第五种 kind
expectCode(
  '21 kind: relay（第五种）',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'relay',
    payload: { kind: 'relay', line: '我这边晴。' },
  },
  'BAD_KIND',
)

// 22. 两边 kind 不一致
expectCode(
  '22 gift 配 payload.kind: find',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'gift',
    payload: {
      kind: 'find',
      findTitle: '一颗糖',
      findExcerpt: null,
      sourceUrl: null,
    },
  },
  'BAD_KIND',
)

// 23. gift 缺 note 键（不是 null，是没这个键）
expectCode(
  '23 gift 缺 note 键',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'gift',
    payload: { kind: 'gift', giftName: '一颗糖', imagePath: null },
  },
  'MISSING_FIELD',
)

// 24. giftName 全空白
expectCode(
  '24 giftName: "   "',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'gift',
    payload: { kind: 'gift', giftName: '   ', note: null, imagePath: null },
  },
  'EMPTY_STRING',
)

// 25. fromOwnerOf 是人名
expectCode(
  '25 fromOwnerOf: "小林"（人名）',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'co_owner_message',
    payload: { kind: 'co_owner_message', message: '楼下的桂花开了', fromOwnerOf: '小林' },
  },
  'WRONG_TYPE',
)

// 26. sourceUrl 不是知乎 —— 原方案（sourceMode live + sourceUrl null）要等 c 批
expectCode(
  '26 sourceUrl 不是知乎域名',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'find',
    payload: {
      kind: 'find',
      findTitle: '一条不该有的链接',
      findExcerpt: null,
      sourceUrl: 'https://example.com/something',
    },
  },
  'WRONG_TYPE',
)

// 27. 命中屏蔽主题
expectCode(
  '27 blockedTopics 命中「雪」',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'greeting',
    payload: { kind: 'greeting', line: '这边下雪了，你那边呢', weather: '雪' },
  },
  'BLOCKED_TOPIC',
  { blockedTopics: ['雪'] },
)

// 28. weather 超过 4 字
expectCode(
  '28 weather 超长',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'greeting',
    payload: { kind: 'greeting', line: '我这边晴。', weather: '晴转多云有小雨' },
  },
  'TOO_LONG',
)

// ===========================================================================
// normalize 的独立检查：fixture 那种缺 payload.kind 的形状要能吃进去
// ===========================================================================

console.log('\n【normalize】形状转换（不做校验）')

{
  const draft = normalize({
    from_dog: 'dog_a1',
    to_dog: 'dog_b1',
    kind: 'gift',
    payload: { gift_name: '一颗糖', note: null, image_path: null },
  })
  assert.equal(draft.fromDog, 'dog_a1', 'snake_case 没转成 camelCase')
  assert.equal(draft.toDog, 'dog_b1')
  const p = draft.payload as Record<string, unknown>
  assert.equal(p.kind, 'gift', '外层 kind 没补进 payload')
  assert.equal(p.giftName, '一颗糖', 'payload 内部 snake_case 没转')
  assert.equal(p.imagePath, null)
  pass++
  console.log('  ✅ normalize 转 snake_case + 补 payload.kind')
}

{
  // 没补成 camelCase 的形态，validate 必须照拒 —— normalize 不替校验做决定
  const v = validate({ from_dog: 'dog_a1', kind: 'gift', payload: {} })
  assert.equal(v.ok, false)
  pass++
  console.log('  ✅ normalize 后仍缺 toDog，validate 照拒')
}

{
  // countChars 的数法：只去空白，标点算一个字
  assert.equal(countChars('我这边晴。'), 5)
  assert.equal(countChars(' 我 这边 晴。 '), 5)
  pass++
  console.log('  ✅ countChars 只去空白，标点算一个字')
}

// ===========================================================================
// 汇总
// ===========================================================================

console.log('\n' + '─'.repeat(56))
console.log(`通过 ${pass} 条，失败 ${fail} 条`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log('  · ' + f)
  process.exitCode = 1
} else {
  console.log('全绿。反例 16 报的是 UNKNOWN_KEY —— 白名单结构生效，不靠关键词猜。')
}
