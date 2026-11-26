import test from 'node:test'
import assert from 'node:assert/strict'
import {
  entryBody,
  isSealed,
  letterTitle,
  mergeExchanges,
  receivedGifts,
  revealHead,
  shouldMarkRead,
  shouldRevealOnOpen,
  sourceNote,
  tripOutcome,
  tripPlace,
  tripMessageText,
} from '../components/e7/journal-model.ts'
import { journalClient } from '../components/e7/journal-client.ts'

const DOG = 'dog_owner'

function exchange(overrides = {}) {
  return {
    id: 'ex_1', fromDog: 'dog_seed_07', toDog: DOG, kind: 'find',
    payload: { kind: 'find', findTitle: 'PRIVATE_TITLE', findExcerpt: 'PRIVATE_BODY', sourceUrl: null, sourceMode: 'fixture' },
    deliverAfterTripSeq: 1, createdAt: '2026-11-16T10:00:00Z',
    deliveredAt: '2026-11-16T11:00:00Z', repliedAt: null, readAt: null,
    ...overrides,
  }
}

test('inbox and outbox merge by exchange id, keep direction, newest first', () => {
  const shared = exchange({ id: 'ex_shared', readAt: '2026-11-16T12:00:00Z' })
  const out = exchange({ id: 'ex_out', fromDog: DOG, toDog: 'dog_seed_07', createdAt: '2026-11-17T10:00:00Z' })
  const older = exchange({ id: 'ex_older', createdAt: '2026-11-10T10:00:00Z' })
  const merged = mergeExchanges([shared, older], [out, { ...shared, readAt: null }], DOG)

  assert.deepEqual(merged.map(item => item.exchange.id), ['ex_out', 'ex_shared', 'ex_older'])
  assert.equal(merged[0].direction, 'out')
  assert.equal(merged[1].direction, 'in')
  // inbox 那一份带服务端最新 readAt，去重时保留它
  assert.equal(merged[1].exchange.readAt, '2026-11-16T12:00:00Z')
})

test('rows that belong to neither side are dropped instead of being called outgoing', () => {
  const stranger = exchange({ id: 'ex_stranger', fromDog: 'dog_a', toDog: 'dog_b' })
  assert.deepEqual(mergeExchanges([stranger], [], DOG), [])
})

test('undelivered incoming keeps title and body out of reach even if timestamps lie', () => {
  for (const item of [
    exchange({ deliveredAt: null }),
    exchange({ deliveredAt: null, readAt: '2026-11-16T12:00:00Z', repliedAt: '2026-11-16T12:00:00Z' }),
  ]) {
    const entry = { exchange: item, direction: 'in' }
    assert.equal(isSealed(entry), true)
    assert.equal(entryBody(entry), null)
    assert.equal(sourceNote(entry), null)
    assert(!letterTitle(item, DOG).includes('PRIVATE'))
  }
})

test('delivered incoming may be opened and marked read; outgoing never writes read state', () => {
  const inbound = { exchange: exchange(), direction: 'in' }
  assert.equal(isSealed(inbound), false)
  assert.equal(entryBody(inbound), 'PRIVATE_BODY')
  assert.equal(shouldMarkRead(inbound), true)
  assert.equal(shouldMarkRead({ exchange: exchange({ readAt: '2026-11-16T12:00:00Z' }), direction: 'in' }), false)

  const outbound = { exchange: exchange({ fromDog: DOG, toDog: 'dog_seed_07' }), direction: 'out' }
  assert.equal(isSealed(outbound), false)
  assert.equal(entryBody(outbound), 'PRIVATE_BODY')
  assert.equal(shouldMarkRead(outbound), false)

  const pendingOutbound = { exchange: exchange({ fromDog: DOG, toDog: 'dog_seed_07', deliveredAt: null }), direction: 'out' }
  assert.equal(isSealed(pendingOutbound), false)
  assert.equal(entryBody(pendingOutbound), 'PRIVATE_BODY')
})

test('gift without a note stays null so the view can say so instead of inventing text', () => {
  const entry = { exchange: exchange({ kind: 'gift', payload: { kind: 'gift', giftName: '毛线', note: null, imagePath: null, sourceMode: null } }), direction: 'in' }
  assert.equal(entryBody(entry), null)
})

test('received gifts exclude pending, outgoing and non-gift rows', () => {
  const rows = [
    exchange({ id: 'gift_ok', kind: 'gift', payload: { kind: 'gift', giftName: 'A', note: null, imagePath: null, sourceMode: null } }),
    exchange({ id: 'gift_pending', kind: 'gift', deliveredAt: null, payload: { kind: 'gift', giftName: 'B', note: null, imagePath: null, sourceMode: null } }),
    exchange({ id: 'gift_out', kind: 'gift', fromDog: DOG, toDog: 'dog_seed_07', payload: { kind: 'gift', giftName: 'C', note: null, imagePath: null, sourceMode: null } }),
    exchange({ id: 'find_ok' }),
  ]
  assert.deepEqual(receivedGifts(rows, DOG).map(item => item.id), ['gift_ok'])
})

test('failed and timeout trips are never reported as a normal return', () => {
  assert.equal(tripOutcome({ status: 'done' }).label, '回来了')
  for (const status of ['failed', 'timeout', 'running', 'pending']) {
    assert.notEqual(tripOutcome({ status }).label, '回来了')
  }
  const timeout = tripOutcome({ status: 'timeout' })
  assert.equal(timeout.label, '这次超时了')
  assert.equal(timeout.note.includes('超时'), true)
  // 「回来得晚」暗示成功归来，不再使用
  assert.equal(timeout.note.includes('回来得晚'), false)
})

test('place comes only from this trip scene find and is never invented', () => {
  assert.equal(tripPlace([]), null)
  assert.equal(tripPlace([{ kind: 'zhihu', title: '一个知乎问题' }]), null)
  assert.equal(tripPlace([{ kind: 'scene', title: '  喀纳斯 ' }]), '喀纳斯')
})

test('empty return line is treated as absent, not as a placeholder', () => {
  assert.equal(tripMessageText(null), null)
  assert.equal(tripMessageText({ text: '   ' }), null)
  assert.equal(tripMessageText({ text: '湖面很静。' }), '湖面很静。')
})

test('reveal sample only runs for a first unread opening, never for sealed or outgoing', () => {
  const on = { revealOn: true, reducedMotion: false }
  const fresh = { exchange: exchange(), direction: 'in' }
  assert.equal(shouldRevealOnOpen(fresh, on), true)
  // 已读回看直接显示
  assert.equal(shouldRevealOnOpen({ exchange: exchange({ readAt: '2026-11-16T12:00:00Z' }), direction: 'in' }, on), false)
  // 用户关掉、系统减少动效都直接显示
  assert.equal(shouldRevealOnOpen(fresh, { revealOn: false, reducedMotion: false }), false)
  assert.equal(shouldRevealOnOpen(fresh, { revealOn: true, reducedMotion: true }), false)
  // 发件与未送达都不渐显（未送达连正文都拿不到）
  assert.equal(shouldRevealOnOpen({ exchange: exchange({ fromDog: DOG, toDog: 'dog_seed_07' }), direction: 'out' }, on), false)
  const sealed = { exchange: exchange({ deliveredAt: null }), direction: 'in' }
  assert.equal(shouldRevealOnOpen(sealed, on), false)
  assert.equal(entryBody(sealed), null)
})

test('reveal head only covers a short first line and never invents text', () => {
  assert.equal(revealHead('湖面很静，我站了一会儿。'), '湖面很静，我站了一会儿。')
  assert.equal(revealHead('第一行\n第二行'), '第一行')
  assert.equal(revealHead('字'.repeat(61)), '')
  assert.equal(revealHead(''), '')
})

test('reads are authenticated, no-store, and failures reject instead of returning empty arrays', async () => {
  const original = globalThis.fetch
  const calls = []
  try {
    globalThis.fetch = async (url, options) => { calls.push({ url, options }); return Response.json({ trips: [] }) }
    const signal = new AbortController().signal
    assert.deepEqual(await journalClient.trips('a/b', signal), { trips: [] })
    assert.equal(calls[0].url, '/api/dogs/a%2Fb/trips?limit=50')
    assert.equal(calls[0].options.credentials, 'same-origin')
    assert.equal(calls[0].options.cache, 'no-store')
    assert.equal(calls[0].options.signal, signal)

    await journalClient.message('trip_1', signal)
    assert.equal(calls[1].url, '/api/trips/trip_1/message')

    globalThis.fetch = async () => new Response('', { status: 404 })
    await assert.rejects(() => journalClient.finds('trip_1', signal), /不可访问/)
    globalThis.fetch = async () => new Response('', { status: 503 })
    await assert.rejects(() => journalClient.trips('dog', signal), /没读到/)
  } finally {
    globalThis.fetch = original
  }
})

test('outgoing state describes the recipient; undelivered wins over inconsistent read timestamps', async () => {
  const { journalLetterState } = await import('../components/e7/journal-model.ts')
  const entry = overrides => ({ direction: 'out', exchange: exchange(overrides) })
  assert.equal(journalLetterState(entry({ deliveredAt: null, readAt: 't', repliedAt: 't' })), '在路上')
  assert.equal(journalLetterState(entry({})), '已寄出')
  assert.equal(journalLetterState(entry({ readAt: 't' })), '对方已读')
  assert.equal(journalLetterState(entry({ repliedAt: 't' })), '对方已回应')
  assert.equal(journalLetterState({ direction: 'in', exchange: exchange() }), '新到')
})

test('find and gift provenance covers all four modes without guessing from content', async () => {
  const { provenanceNote } = await import('../components/e7/journal-model.ts')
  for (const [mode, text] of [['fixture', '示例内容'], ['cache', '来自先前保存的发现'], ['live', '来自一次知乎发现'], [null, '来源信息未提供'], [undefined, '来源信息未提供']]) {
    assert.equal(provenanceNote(mode), text)
    for (const kind of ['gift', 'find']) {
      const item = exchange({ kind, payload: { ...exchange().payload, kind, sourceMode: mode } })
      assert.equal(sourceNote({ direction: 'in', exchange: item }), text)
      assert.equal(sourceNote({ direction: 'in', exchange: { ...item, deliveredAt: null } }), null)
    }
  }
})

test('return-message failure and retry preserve successful finds, without a false empty state', async () => {
  const { settleTripDetail } = await import('../components/e7/journal-model.ts')
  const ok = value => ({ status: 'fulfilled', value })
  const failed = { status: 'rejected', reason: new Error('offline') }
  const finds = [{ id: 'find_1', title: '白桦林' }]
  const partial = settleTripDetail('trip_1', ok({ finds }), failed, null)
  assert.equal(partial.phase, 'ready')
  assert.equal(partial.message, null)
  assert.notEqual(partial.messageError, '')
  assert.deepEqual(partial.finds, finds)
  const retryFailure = settleTripDetail('trip_1', failed, failed, { ...partial, retrying: true })
  assert.equal(retryFailure.phase, 'ready')
  assert.deepEqual(retryFailure.finds, finds)
  const recovered = settleTripDetail('trip_1', ok({ finds }), ok({ message: { text: '我回来了。' } }), retryFailure)
  assert.equal(recovered.messageError, '')
  assert.equal(recovered.message.text, '我回来了。')
  assert.deepEqual(recovered.finds, finds)
  const anotherTrip = settleTripDetail('trip_2', failed, failed, recovered)
  assert.equal(anotherTrip.phase, 'error')
  assert.deepEqual(anotherTrip.finds, [])
  assert.equal(anotherTrip.message, null)
})

test('new mail count excludes pending, outgoing, read and replied entries', async () => {
  const { isNewIncoming } = await import('../components/e7/journal-model.ts')
  assert.equal(isNewIncoming({ direction: 'in', exchange: exchange() }), true)
  for (const entry of [
    { direction: 'out', exchange: exchange() },
    { direction: 'in', exchange: exchange({ deliveredAt: null }) },
    { direction: 'in', exchange: exchange({ readAt: 't' }) },
    { direction: 'in', exchange: exchange({ repliedAt: 't' }) },
  ]) assert.equal(isNewIncoming(entry), false)
})

test('correspondence separates direction and pins undelivered without revealing contents', async () => {
  const { correspondence } = await import('../components/e7/journal-model.ts')
  const rows = [
    { direction: 'in', exchange: exchange({ id: 'arrived', createdAt: '2026-11-25T10:00:00Z' }) },
    { direction: 'out', exchange: exchange({ id: 'out' }) },
    { direction: 'in', exchange: exchange({ id: 'pending', deliveredAt: null, createdAt: '2026-11-15T10:00:00Z' }) },
  ]
  const inbox = correspondence(rows, 'in')
  assert.deepEqual(inbox.map(row => row.exchange.id), ['pending', 'arrived'])
  assert.equal(entryBody(inbox[0]), null)
  assert.equal(rows[0].exchange.id, 'arrived')
})

test('gift thumbnails only use existing public assets, not guessed private endpoints', async () => {
  const { giftThumbnail } = await import('../components/e7/journal-model.ts')
  assert.equal(giftThumbnail('/assets/gift.png'), '/assets/gift.png')
  for (const path of [null, '/api/assets/private', '//evil.test/a', '/assets/../secret', '/assets/%2e%2e/a', '/assets/a?token=x']) assert.equal(giftThumbnail(path), null)
})

test('glyph stagger is 64ms and a single glyph fades in 280ms, opacity only', async () => {
  const { GLYPH_STAGGER_MS, GLYPH_FADE_MS, glyphDelayMs } = await import('../components/e7/journal-model.ts')
  assert.equal(GLYPH_STAGGER_MS, 64)
  assert.equal(GLYPH_FADE_MS, 280)
  assert.deepEqual([0, 1, 2, 3].map(glyphDelayMs), [0, 64, 128, 192])
  assert.equal(glyphDelayMs(-3), 0)
})

test('reading settings stay collapsed unless explicitly opened, and reveal defaults on', async () => {
  const { settingsOpenFrom, revealOnFrom } = await import('../components/e7/journal-model.ts')
  for (const stored of [null, undefined, '', 'closed', 'anything']) assert.equal(settingsOpenFrom(stored), false)
  assert.equal(settingsOpenFrom('open'), true)
  for (const stored of [null, undefined, '', 'on']) assert.equal(revealOnFrom(stored), true)
  assert.equal(revealOnFrom('off'), false)
})
