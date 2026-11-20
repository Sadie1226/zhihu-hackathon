/**
 * rules.ts 的用例。15 正例 + 16 反例，跑法：
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
import { readProvenance } from './provenance.ts'

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
    sourceFindId: null,
    sourceMode: null,
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
    sourceFindId: null,
    sourceMode: null,
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
    sourceFindId: null,
    sourceMode: null,
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
    sourceFindId: null,
    sourceMode: null,
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
    sourceFindId: null,
    sourceMode: null,
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
    sourceFindId: null,
    sourceMode: null,
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
    sourceFindId: null,
    sourceMode: null,
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
    sourceFindId: null,
    sourceMode: null,
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
    sourceFindId: null,
    sourceMode: null,
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

// 19b–19d：越权字段共五个，18/19 只覆盖了两个。
// 缺的这三条不是补代码，是补证据 —— 代码里 OVERREACH_KEYS 早就有，但没测就等于没验。

// 19b. repliedAt —— b 独占。d 写它 = 狗替主人回话
expectCode(
  '19b 传 repliedAt',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'greeting',
    payload: { kind: 'greeting', line: '我这边晴。', weather: '晴' },
    repliedAt: '2026-11-17T00:00:00Z',
  },
  'FORBIDDEN_KEY',
)

// 19c. readAt —— e 独占
expectCode(
  '19c 传 readAt',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'greeting',
    payload: { kind: 'greeting', line: '我这边晴。', weather: '晴' },
    readAt: '2026-11-17T00:00:00Z',
  },
  'FORBIDDEN_KEY',
)

// 19d. id —— 主键由库生成，草稿带 id 就是允许调用方指定身份
expectCode(
  '19d 传 id',
  {
    id: 'ex_made_up',
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'greeting',
    payload: { kind: 'greeting', line: '我这边晴。', weather: '晴' },
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
    payload: { kind: 'gift', giftName: '   ', note: null, imagePath: null, sourceFindId: null, sourceMode: null },
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

// 26. sourceUrl 不是知乎 —— 11-20：K v4 明确「sourceUrl 不是来源证明」，
//     所以它只管格式（必须是指向知乎的 https），不参与 sourceMode 推断。
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
      sourceFindId: null,
      sourceMode: null,
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
// 【K v4】来源字段的形状（find / gift）
// ===========================================================================
//
// 只测**形状**。归属（这条 find 是不是寄件狗的）、以及「声称的 mode 是否等于
// 库里那一行」，要查库才知道，纯函数做不了 —— 那些在 gift.test.ts / meet.test.ts
// 里用真 schema 建库测。
//
// 契约出处：contracts/api.md「K v4：交换来源（仅 find / gift）」那张表。

console.log('\n【K v4】来源字段的形状')

const ZHIHU_URL = 'https://www.zhihu.com/question/000000000/answer/000000000'

// 35. 正例：指向一条真实发现，档位 live
expectOk('35 find 有来源 + live', {
  fromDog: 'dog_a1',
  toDog: 'dog_b1',
  kind: 'find',
  payload: {
    kind: 'find',
    findTitle: '为什么井盖是圆的',
    findExcerpt: '因为圆的怎么转都不会掉下去。',
    sourceUrl: ZHIHU_URL,
    sourceFindId: 'find_a1_1',
    sourceMode: 'live',
  },
})

// 36. 正例：来源是自己捡到的一个场景 —— scene/moment 的档位**必须**是 null，
//     不能因为带了图或链接就标成 live（契约原话）。
expectOk('36 gift 来源是 scene → mode 为 null', {
  fromDog: 'dog_a1',
  toDog: 'dog_b1',
  kind: 'gift',
  payload: {
    kind: 'gift',
    giftName: '一块被水冲圆的石头',
    note: null,
    imagePath: '/assets/gen/stone.webp',
    sourceFindId: 'find_a1_2',
    sourceMode: null,
  },
})

// 37. 反例：没有来源却声称 live —— 凭空造出处，正是不变量四要拦的
expectCode(
  '37 无来源却声明 live',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'gift',
    payload: {
      kind: 'gift',
      giftName: '一小卷毛线',
      note: null,
      imagePath: null,
      sourceFindId: null,
      sourceMode: 'live',
    },
  },
  'PROVENANCE_MISMATCH',
)

// 38. 反例：档位不在三值里
expectCode(
  '38 sourceMode 非法值',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'find',
    payload: {
      kind: 'find',
      findTitle: '井盖',
      findExcerpt: null,
      sourceUrl: null,
      sourceFindId: 'find_a1_1',
      sourceMode: 'realtime',
    },
  },
  'WRONG_TYPE',
)

// 39. 反例：空串 id —— 要么给真 id，要么给 null，别给 ''
expectCode(
  '39 sourceFindId 空串',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'gift',
    payload: {
      kind: 'gift',
      giftName: '毛线',
      note: null,
      imagePath: null,
      sourceFindId: '',
      sourceMode: null,
    },
  },
  'EMPTY_STRING',
)

// 40. 反例：带首尾空格 —— 会被当成另一个 id，查库查不到，不如当场拒
expectCode(
  '40 sourceFindId 带前导空格',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'gift',
    payload: {
      kind: 'gift',
      giftName: '毛线',
      note: null,
      imagePath: null,
      sourceFindId: ' find_a1_1',
      sourceMode: null,
    },
  },
  'WRONG_TYPE',
)

// 41. 反例：类型不对
expectCode(
  '41 sourceFindId 是数字',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'gift',
    payload: {
      kind: 'gift',
      giftName: '毛线',
      note: null,
      imagePath: null,
      sourceFindId: 123,
      sourceMode: null,
    },
  },
  'WRONG_TYPE',
)

// 42. 反例：只给 id 不给 mode —— 「新 payload 必须两键俱全」
expectCode(
  '42 只有 sourceFindId，缺 sourceMode',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'find',
    payload: {
      kind: 'find',
      findTitle: '井盖',
      findExcerpt: null,
      sourceUrl: null,
      sourceFindId: 'find_a1_1',
    },
  },
  'MISSING_FIELD',
)

// 43. 反例：只给 mode 不给 id
expectCode(
  '43 只有 sourceMode，缺 sourceFindId',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'find',
    payload: {
      kind: 'find',
      findTitle: '井盖',
      findExcerpt: null,
      sourceUrl: null,
      sourceMode: null,
    },
  },
  'MISSING_FIELD',
)

// 44/45. 反例：greeting 和捎话都不许挂来源（契约原话：
//   「greeting/捎话不能借此夹带来源、私人内容或额外身份信息」）
expectCode(
  '44 greeting 带 sourceFindId',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'greeting',
    payload: { kind: 'greeting', line: '我这边晴。', weather: '晴', sourceFindId: 'find_a1_1' },
  },
  'UNKNOWN_KEY',
)

expectCode(
  '45 捎话带 sourceMode',
  {
    fromDog: 'dog_a1',
    toDog: 'dog_b1',
    kind: 'co_owner_message',
    payload: { kind: 'co_owner_message', message: '楼下的桂花开了', fromOwnerOf: 'dog_a1', sourceMode: 'live' },
  },
  'UNKNOWN_KEY',
)

// 50. 正例：find 明确没有来源 —— 两个键都写 null，键在、值为空（不是省略）
expectOk('50 find 无来源，两键显式 null', {
  fromDog: 'dog_a1',
  toDog: 'dog_b1',
  kind: 'find',
  payload: {
    kind: 'find',
    findTitle: '路边的井盖',
    findExcerpt: null,
    sourceUrl: null,
    sourceFindId: null,
    sourceMode: null,
  },
})

// ===========================================================================
// 五、读侧：历史 payload 缺来源键怎么办（K v4 请求的「历史缺键只做读取兼容」）
// ===========================================================================
//
// 写入闸门 validate 要求两个来源键必须在；读取不能照这个标准卡历史行。
// readProvenance 只取值、不拒绝，但要把「缺键」和「明确无来源」区分开。

function expectRead(
  name: string,
  payload: unknown,
  want: { sourceFindId: string | null; sourceMode: string | null; legacy: boolean },
): void {
  const got = readProvenance(payload)
  const same =
    got.sourceFindId === want.sourceFindId &&
    got.sourceMode === (want.sourceMode as never) &&
    got.legacy === want.legacy
  if (same) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    const msg = `${name} → 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`
    failures.push(msg)
    console.log(`  ❌ ${msg}`)
  }
}

// 46. 历史行：K v4 之前写的 gift，payload 里没有这两个键
expectRead(
  '46 历史 gift 缺两个来源键 → 读出 null/null，标 legacy',
  { kind: 'gift', giftName: '一小卷灰蓝色的毛线', note: null, imagePath: null },
  { sourceFindId: null, sourceMode: null, legacy: true },
)

// 47. 新记录明确无来源：两个键在，值为 null —— 这不是历史行
expectRead(
  '47 新 gift 显式 null/null → 同样读出 null/null，但不标 legacy',
  { kind: 'gift', giftName: '一颗螺帽', note: null, imagePath: null, sourceFindId: null, sourceMode: null },
  { sourceFindId: null, sourceMode: null, legacy: false },
)

// 48. 半个来源（只有 id、没有 mode）→ 按历史行对待，不假装出处完整
expectRead(
  '48 只有 sourceFindId、没有 sourceMode → 不当成可用出处，标 legacy',
  { kind: 'gift', giftName: '一颗螺帽', note: null, imagePath: null, sourceFindId: 'find_a1_1' },
  { sourceFindId: 'find_a1_1', sourceMode: null, legacy: true },
)

// 49. scene/moment 的真实来源：id 有值、mode 本来就是 null，但这不是历史行
expectRead(
  '49 scene 来源（id 有值、mode 为 null）→ 不标 legacy',
  { kind: 'gift', giftName: '一颗螺帽', note: null, imagePath: null, sourceFindId: 'find_scene_1', sourceMode: null },
  { sourceFindId: 'find_scene_1', sourceMode: null, legacy: false },
)

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
