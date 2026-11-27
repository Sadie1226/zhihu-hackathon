// 聊天发送业务逻辑回归测试（Node 24，--experimental-strip-types）。
// 不依赖 chat_message 迁移、不连真实库：用内存假存储模拟 owner 作用域查重、
// 唯一约束与同事务裁决，覆盖「提交成功但响应丢失」「持久化失败」「重复提交」
// 「生成失败」四类场景。契约本体见 c-chat-contract-1125，正式取用待 A 发布 SHA。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { decideChatWrite, isChatKeyConflict } from '../lib/chat/write-decision.ts'
import {
  MAX_CHAT_ATTEMPTS,
  applyGenerationOutcome,
  applySendResult,
  cancelInFlight,
  canRetry,
  createChatItem,
  dedupeItems,
  markSending,
  retryDelayMs,
  retryOutbound,
  sendChatOnce,
} from '../lib/chat/send.ts'

const DOG = 'dog_chat_001'
const OWNER = 'owner_a'
const TEXT = '今天想和你说件小事'
const KEY = () => randomUUID()

function fakeChatStore() {
  const rows = new Map()
  const keyOf = (ownerId, clientMessageId) => `${ownerId}\u0000${clientMessageId}`
  return {
    find(ownerId, clientMessageId) {
      return rows.get(keyOf(ownerId, clientMessageId)) ?? null
    },
    insert(record) {
      const key = keyOf(record.ownerId, record.clientMessageId)
      if (rows.has(key)) {
        throw new Error('UNIQUE constraint failed: chat_message (owner_id, client_message_id)')
      }
      rows.set(key, record)
      return record
    },
    count() {
      return rows.size
    },
    all() {
      return [...rows.values()]
    },
  }
}

const responseOf = (record) => ({
  id: record.id,
  dogId: record.dogId,
  text: record.text,
  createdAt: record.createdAt,
})

/** 模拟服务端同事务：授权 → 按 owner+key 查 → 裁决 → 写入/回读 → 提交后才回 200。 */
function serverSend(store, options) {
  return async (outbound) => {
    const ownerId = options.ownerId ?? OWNER
    const authorized = (options.authorizedDogs ?? [DOG]).includes(outbound.dogId)
    const existing = store.find(ownerId, outbound.clientMessageId) // 永不跨 owner 查
    const decision = decideChatWrite({
      dogAuthorized: authorized,
      existing,
      dogId: outbound.dogId,
      text: outbound.text,
    })
    if (decision.kind === 'forbidden') return { kind: 'forbidden' }
    if (decision.kind === 'conflict') return { kind: 'conflict' }
    if (decision.kind === 'replay') return { kind: 'ok', response: responseOf(decision.record) }
    if (options.writeFails) return { kind: 'retriable', reason: 'server' }

    if (options.onBeforeInsert) options.onBeforeInsert(store, outbound)
    const record = {
      id: `chat_${ownerId}_${outbound.clientMessageId}`,
      ownerId,
      clientMessageId: outbound.clientMessageId,
      dogId: outbound.dogId,
      text: outbound.text,
      createdAt: options.createdAt ?? '2026-11-25T08:00:00.000Z',
    }
    try {
      store.insert(record)
    } catch (error) {
      if (!isChatKeyConflict(error)) return { kind: 'retriable', reason: 'server' }
      const raced = store.find(ownerId, outbound.clientMessageId)
      return { kind: 'ok', response: responseOf(raced) }
    }
    if (options.responseLost) throw new Error('connection reset before 200')
    return { kind: 'ok', response: responseOf(record) }
  }
}

// ---- 写入裁决：授权优先、同键同值、同键异值 ----

test('同键同值回放首次记录，改目标或改文本均为冲突', () => {
  const first = {
    id: 'chat_first',
    ownerId: OWNER,
    clientMessageId: 'first',
    dogId: DOG,
    text: TEXT,
    createdAt: '2026-11-25T08:00:00.000Z',
  }
  assert.deepEqual(decideChatWrite({ dogAuthorized: true, existing: null, dogId: DOG, text: TEXT }), {
    kind: 'created',
  })
  assert.deepEqual(decideChatWrite({ dogAuthorized: true, existing: first, dogId: DOG, text: TEXT }), {
    kind: 'replay',
    record: first,
  })
  assert.equal(decideChatWrite({ dogAuthorized: true, existing: first, dogId: DOG, text: TEXT + '。' }).kind, 'conflict')
  assert.equal(decideChatWrite({ dogAuthorized: true, existing: first, dogId: 'dog_other', text: TEXT }).kind, 'conflict')
})

test('授权先于幂等，且查重必须按 owner 作用域', () => {
  const existing = {
    id: 'chat_first',
    ownerId: OWNER,
    clientMessageId: 'shared_key',
    dogId: DOG,
    text: TEXT,
    createdAt: '2026-11-25T08:00:00.000Z',
  }
  // 未授权目标即使已有同键记录也返回 forbidden，不泄露存在性。
  assert.equal(decideChatWrite({ dogAuthorized: false, existing, dogId: DOG, text: TEXT }).kind, 'forbidden')
  // 别的主人传来的记录不应被本 owner 当成同键命中（调用方负责 owner 作用域查询）。
  assert.equal(decideChatWrite({ dogAuthorized: true, existing: null, dogId: DOG, text: TEXT }).kind, 'created')
})

test('只有目标唯一键冲突能当重放，其他数据库异常不得吞成成功', () => {
  assert.equal(isChatKeyConflict(new Error('UNIQUE constraint failed: chat_message (owner_id, client_message_id)')), true)
  assert.equal(isChatKeyConflict(new Error('UNIQUE constraint failed: chat_message.owner_id, chat_message.client_message_id')), true)
  assert.equal(isChatKeyConflict(new Error('FOREIGN KEY constraint failed')), false)
  assert.equal(isChatKeyConflict(new Error('database is locked')), false)
  assert.equal(isChatKeyConflict(new Error('UNIQUE constraint failed: dog(id, owner_id)')), false)
})

// ---- 客户端状态机 ----

test('200 且回执与目标文本一致才确认，使用服务端 id', async () => {
  const item = createChatItem({ dogId: DOG, text: ` ${TEXT} `, clientMessageId: KEY() })
  assert.equal(item.delivery, 'pending')
  assert.equal(item.text, TEXT, '只做 trim，不改内部内容')
  const confirmed = await sendChatOnce(item, async (outbound) => ({
    kind: 'ok',
    response: {
      id: 'chat_server_1',
      dogId: outbound.dogId,
      text: outbound.text,
      createdAt: '2026-11-25T08:00:00.000Z',
    },
  }))
  assert.equal(confirmed.delivery, 'confirmed')
  assert.equal(confirmed.serverId, 'chat_server_1')
  assert.equal(confirmed.createdAt, '2026-11-25T08:00:00.000Z')
  assert.equal(canRetry(confirmed), false)
  assert.equal(retryOutbound(confirmed).clientMessageId, item.clientMessageId)
})

test('200 回执与目标或文本不符按冲突处理，不确认错误内容', () => {
  const item = createChatItem({ dogId: DOG, text: TEXT, clientMessageId: KEY() })
  const wrongTarget = applySendResult(markSending(item), {
    kind: 'ok',
    response: { id: 'x', dogId: 'dog_other', text: TEXT, createdAt: '2026-11-25T08:00:00.000Z' },
  })
  const wrongText = applySendResult(markSending(item), {
    kind: 'ok',
    response: { id: 'x', dogId: DOG, text: '被改过的文本', createdAt: '2026-11-25T08:00:00.000Z' },
  })
  assert.equal(wrongTarget.delivery, 'conflict')
  assert.equal(wrongText.delivery, 'conflict')
  assert.equal(wrongTarget.serverId, null)
})

test('503/超时进不确定态，保留原键原文，取消在途也可恢复', async () => {
  const item = createChatItem({ dogId: DOG, text: TEXT, clientMessageId: KEY() })
  const retryable = await sendChatOnce(item, async () => ({ kind: 'retriable', reason: 'server' }))
  assert.equal(retryable.delivery, 'uncertain')
  assert.equal(canRetry(retryable), true)
  assert.deepEqual(retryOutbound(retryable), retryOutbound(item), '重试请求体逐字不变')
  assert.equal(retryable.attempts, 1)

  const cancelled = cancelInFlight(markSending(item))
  assert.equal(cancelled.delivery, 'uncertain')
  assert.equal(cancelled.clientMessageId, item.clientMessageId)
  assert.equal(canRetry(cancelled), true)

  const networkError = await sendChatOnce(item, async () => {
    throw new Error('timeout')
  })
  assert.equal(networkError.delivery, 'uncertain', '抛错不得吞成已送达')
})

test('409/404 是终态；退避有上限；同键去重 confirmed 优先', () => {
  const item = createChatItem({ dogId: DOG, text: TEXT, clientMessageId: KEY() })
  assert.equal(applySendResult(markSending(item), { kind: 'conflict' }).delivery, 'conflict')
  assert.equal(applySendResult(markSending(item), { kind: 'forbidden' }).delivery, 'forbidden')
  assert.equal(canRetry(applySendResult(markSending(item), { kind: 'conflict' })), false)
  assert.equal(canRetry(applySendResult(markSending(item), { kind: 'forbidden' })), false)
  assert.equal(retryDelayMs(0), 0)
  assert.equal(retryDelayMs(3), 2000)
  assert.equal(retryDelayMs(99), 5000)

  const key = KEY()
  const uncertain = { ...item, clientMessageId: key, delivery: 'uncertain' }
  const confirmed = { ...item, clientMessageId: key, delivery: 'confirmed', serverId: 'chat_x' }
  const other = { ...item, clientMessageId: KEY() }
  const deduped = dedupeItems([uncertain, other, confirmed])
  assert.deepEqual(deduped.map((turn) => turn.clientMessageId), [key, other.clientMessageId])
  assert.equal(deduped[0].delivery, 'confirmed')
  assert.equal(MAX_CHAT_ATTEMPTS, 5)
})

test('生成失败只改 generation，不动投递状态、键和文本，也不在未确认时生效', () => {
  const item = createChatItem({ dogId: DOG, text: TEXT, clientMessageId: KEY() })
  assert.equal(applyGenerationOutcome(item, 'failed').delivery, 'pending', '未确认前不记录生成结果')
  const confirmed = { ...item, delivery: 'confirmed', serverId: 'chat_x' }
  const failed = applyGenerationOutcome(confirmed, 'failed')
  assert.equal(failed.delivery, 'confirmed')
  assert.equal(failed.generation, 'failed')
  assert.equal(failed.clientMessageId, confirmed.clientMessageId)
  assert.equal(failed.text, confirmed.text)
  assert.equal(failed.serverId, 'chat_x')
})

// ---- 端到端（内存假存储）：三类关键失败 ----

test('已提交但响应丢失：原键重试回放同一条，createdAt 不变', async () => {
  const store = fakeChatStore()
  const transport = serverSend(store, { responseLost: true })
  const item = createChatItem({ dogId: DOG, text: TEXT, clientMessageId: KEY() })

  const uncertain = await sendChatOnce(item, transport)
  assert.equal(uncertain.delivery, 'uncertain')
  assert.equal(store.count(), 1, '服务端其实已提交，客户端不知道')

  const confirmed = await sendChatOnce(uncertain, serverSend(store, {}))
  assert.equal(confirmed.delivery, 'confirmed')
  assert.equal(confirmed.serverId, `chat_${OWNER}_${item.clientMessageId}`)
  assert.equal(confirmed.createdAt, '2026-11-25T08:00:00.000Z')
  assert.equal(store.count(), 1, '重试不得写入第二条')
  assert.equal(store.all()[0].text, TEXT)
})

test('持久化失败：不回 200，保留键重试后才落一行', async () => {
  const store = fakeChatStore()
  const item = createChatItem({ dogId: DOG, text: TEXT, clientMessageId: KEY() })
  const failed = await sendChatOnce(item, serverSend(store, { writeFails: true }))
  assert.equal(failed.delivery, 'uncertain')
  assert.equal(store.count(), 0, '未提交不得有记录')
  const confirmed = await sendChatOnce(failed, serverSend(store, {}))
  assert.equal(confirmed.delivery, 'confirmed')
  assert.equal(store.count(), 1)
})

test('重复提交：同键同值回放，改文本/改目标冲突，不产生第二行', async () => {
  const store = fakeChatStore()
  const key = KEY()
  const item = createChatItem({ dogId: DOG, text: TEXT, clientMessageId: key })
  const first = await sendChatOnce(item, serverSend(store, {}))
  const replay = await sendChatOnce(createChatItem({ dogId: DOG, text: TEXT, clientMessageId: key }), serverSend(store, {}))
  assert.equal(replay.delivery, 'confirmed')
  assert.equal(replay.serverId, first.serverId, '同键回执必须复用首次 id')

  const changedText = applySendResult(markSending(createChatItem({ dogId: DOG, text: TEXT + '！', clientMessageId: key })),
    await serverSend(store, {})({ dogId: DOG, text: TEXT + '！', clientMessageId: key }))
  assert.equal(changedText.delivery, 'conflict')
  // dog_other 也是已授权狗，才能验证「同键换授权目标」是 409 而不是 404。
  const changedDog = applySendResult(markSending(createChatItem({ dogId: 'dog_other', text: TEXT, clientMessageId: key })),
    await serverSend(store, { authorizedDogs: [DOG, 'dog_other'] })({ dogId: 'dog_other', text: TEXT, clientMessageId: key }))
  assert.equal(changedDog.delivery, 'conflict')
  assert.equal(store.count(), 1)
})

test('未授权狗与跨 owner 同键：404 优先，不同 owner 互不冲突', async () => {
  const store = fakeChatStore()
  const key = KEY()
  const item = createChatItem({ dogId: DOG, text: TEXT, clientMessageId: key })
  await sendChatOnce(item, serverSend(store, {}))
  const forbidden = await sendChatOnce(item, serverSend(store, { authorizedDogs: [] }))
  assert.equal(forbidden.delivery, 'forbidden', '已有同键也不能借幂等绕过授权')

  const otherOwner = await sendChatOnce(
    createChatItem({ dogId: DOG, text: TEXT, clientMessageId: key }),
    serverSend(store, { ownerId: 'owner_b' }),
  )
  assert.equal(otherOwner.delivery, 'confirmed')
  assert.equal(otherOwner.serverId, `chat_owner_b_${key}`, '另一 owner 应有自己的记录')
  assert.equal(store.count(), 2)
})

test('并发同键：唯一约束冲突回读首次记录，两侧都确认同一 id', async () => {
  const store = fakeChatStore()
  const key = KEY()
  const item = createChatItem({ dogId: DOG, text: TEXT, clientMessageId: key })
  // 在第一笔 insert 前插入同键记录，模拟另一连接抢先提交。
  const racing = serverSend(store, {
    onBeforeInsert(current) {
      current.insert({
        id: `chat_${OWNER}_${key}`,
        ownerId: OWNER,
        clientMessageId: key,
        dogId: DOG,
        text: TEXT,
        createdAt: '2026-11-25T08:00:00.000Z',
      })
    },
  })
  const result = await sendChatOnce(item, racing)
  assert.equal(result.delivery, 'confirmed')
  assert.equal(result.serverId, `chat_${OWNER}_${key}`)
  assert.equal(store.count(), 1)
})
