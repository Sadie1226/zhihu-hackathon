import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { fixtureSession } from './helpers/owner-session.mjs'
import { createMessageStore, handleContentRequest, handleMessageReadAdapter } from '../app/(b)/b5-share.ts'
import { createInvitationStore, invitationText, MAX_WAITING_INVITATIONS } from '../app/(b)/b6-invitations.ts'

const root = resolve('.local/b5b6-tests')
mkdirSync(root, { recursive: true })
const at = '2026-11-20T01:00:00.000Z'

function setup(t) {
  const directory = mkdtempSync(join(root, 'database-'))
  const path = join(directory, 'app.sqlite')
  const db = openDatabase(path)
  t.after(() => {
    if (db.isOpen) db.close()
    assert.ok(directory.startsWith(root + sep))
    rmSync(directory, { recursive: true, force: true })
  })
  const session = fixtureSession(db)
  const cookie = session.setCookie.split(';')[0]
  const insertDog = (id, sessionId) => db.prepare(`INSERT INTO dog(id,session_id,owner_id,personality_tags,assembly,created_at)
    VALUES(?,?,?,'["好奇","看物","直给"]','{"cloth":"hoodie","hat":null,"glasses":null,"face":"hopeful"}',?)`)
    .run(id, sessionId, db.prepare('SELECT id FROM owner WHERE id = ?').get(sessionId) ? sessionId : null, '2026-11-20T00:00:00Z')
  insertDog('dog-owner', session.sessionId)
  insertDog('dog-other', 'anon_other_dog_session')

  const trip = (id, status = 'done', dogId = 'dog-owner', startedAt = '2026-11-20T00:10:00Z') => {
    const seq = Number(db.prepare('SELECT COALESCE(MAX(seq),0)+1 n FROM trip WHERE dog_id=?').get(dogId).n)
    db.prepare(`INSERT INTO trip(id,dog_id,seq,status,trigger,created_at,started_at,ended_at)
      VALUES(?,?,?,?,'auto',?,?,?)`).run(id, dogId, seq, status, '2026-11-20T00:00:00Z', startedAt,
      ['done', 'failed', 'timeout'].includes(status) ? at : null)
  }
  const find = (id, tripId, title = '巷口那面红墙', kind = 'scene') => db.prepare(
    `INSERT INTO find(id,trip_id,kind,title,excerpt,source_url,source_mode,authority_level,vote_up_count,asset_path,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, tripId, kind, title, 'fixture excerpt', kind === 'zhihu' ? 'https://www.zhihu.com/question/123/answer/456' : null,
    kind === 'zhihu' ? 'fixture' : null, null, null, null, '2026-11-20T00:30:00Z')

  trip('trip-done')
  find('find-1', 'trip-done')
  const getDatabase = () => db
  return { db, path, session: session.sessionId, cookie, insertDog, trip, find, getDatabase }
}

function request(url, cookie, init = {}) {
  return new Request(url, { ...init, headers: { cookie, ...(init.headers ?? {}) } })
}

test('B5 writes multiple messages per trip and get returns the newest by created_at then id', t => {
  const { db, session } = setup(t)
  let writes = 0
  const times = [at, '2026-11-20T02:00:00.000Z']
  const store = createMessageStore(db, {
    now: () => new Date(times[writes - 1]),
    newId: () => `msg_test_${++writes}`,
  })
  const first = store.write('trip-done', { text: '巷口那面墙红透了，只有靠窗那块还是绿的。', mentionsFindId: 'find-1' }, session)
  assert.match(first.id, /^msg_/)
  assert.equal(first.tripId, 'trip-done')
  assert.equal(first.createdAt, at)
  const second = store.write('trip-done', { text: '今天回来得晚，没顾上带什么。' }, session)
  assert.notEqual(second.id, first.id)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM message').get().n, 2)
  // 最新一条按 julianday(created_at) DESC, id DESC 取出。
  assert.equal(store.get('trip-done', session).id, second.id)
  assert.equal(store.get('trip-done', session).text, '今天回来得晚，没顾上带什么。')
})

test('B5 get breaks same-timestamp ties by id descending', t => {
  const { db, session } = setup(t)
  const store = createMessageStore(db, { now: () => new Date(at) })
  const a = store.write('trip-done', { text: '巷口那面墙红透了。' }, session)
  const b = store.write('trip-done', { text: '河边那排树也红了。' }, session)
  // 随机 ID 下这两条的先后顺序不稳定，断言 get 选中的就是 id 最大的那条。
  const newest = db.prepare('SELECT id FROM message ORDER BY julianday(created_at) DESC, id DESC LIMIT 1').get()
  assert.ok(newest.id === a.id || newest.id === b.id)
  assert.equal(store.get('trip-done', session).id, newest.id)
})

test('B5 rejects running trips, foreign sessions, foreign findings and oversized text', t => {
  const { db, session, trip } = setup(t)
  trip('trip-running', 'running')
  const store = createMessageStore(db, { now: () => new Date(at) })
  assert.throws(() => store.write('trip-running', { text: '还没回来就先不写。' }, session), { code: 'CONFLICT' })
  assert.throws(() => store.get('trip-done', 'anon_other'), { code: 'NOT_FOUND' })
  assert.throws(() => store.write('trip-done', { text: '讲一条不属于这趟的发现。', mentionsFindId: 'find-other' }, session), { code: 'CONFLICT' })
  assert.throws(() => store.write('trip-done', { text: '很'.repeat(121) }, session), { code: 'CONFLICT' })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM message').get().n, 0)
})

test('B5 get hides a message whose referenced find no longer belongs to the trip', t => {
  const { db, session, trip } = setup(t)
  const store = createMessageStore(db, { now: () => new Date(at) })
  store.write('trip-done', { text: '巷口那面墙红透了，只有靠窗那块还是绿的。', mentionsFindId: 'find-1' }, session)
  // 把被引用的 find 迁到另一趟真实存在的 trip（同主人、跨 trip），模拟读取时引用越界。
  trip('trip-elsewhere', 'done', 'dog-owner')
  db.prepare('UPDATE find SET trip_id = ? WHERE id = ?').run('trip-elsewhere', 'find-1')
  assert.throws(() => store.get('trip-done', session), /Invalid Message reference/)
})

test('B5 content route combines real C finds with the latest B message and uses no-store', async t => {
  const { session, cookie, getDatabase, db } = setup(t)
  const store = createMessageStore(db, { now: () => new Date(at) })
  store.write('trip-done', { text: '巷口那面墙红透了，只有靠窗那块还是绿的。', mentionsFindId: 'find-1' }, session)
  const response = await handleContentRequest(request('http://localhost/api/trips/trip-done/content', cookie), 'trip-done', getDatabase)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.finds.length, 1)
  assert.equal(body.message.mentionsFindId, 'find-1')
  const denied = await handleContentRequest(request('http://localhost/api/trips/trip-done/content', ''), 'trip-done', getDatabase)
  assert.equal(denied.status, 404)
})

test('B5 read adapter is GET-only, reads the latest and rejects query overrides', async t => {
  const { cookie, session, getDatabase } = setup(t)
  let step = 0
  const store = createMessageStore(getDatabase(), { now: () => new Date(step++ === 0 ? at : '2026-11-20T03:00:00.000Z') })
  store.write('trip-done', { text: '巷口那面墙红透了，只有靠窗那块还是绿的。' }, session)
  store.write('trip-done', { text: '今天回来得晚，没顾上带什么。' }, session)
  const good = await handleMessageReadAdapter(request('http://localhost/api/trips/trip-done/message', cookie), 'trip-done', getDatabase)
  assert.equal(good.status, 200)
  assert.equal((await good.json()).message.text, '今天回来得晚，没顾上带什么。')
  const bad = await handleMessageReadAdapter(request('http://localhost/api/trips/trip-done/message?tripId=other', cookie), 'trip-done', getDatabase)
  assert.equal(bad.status, 404)
  const post = await handleMessageReadAdapter(request('http://localhost/api/trips/trip-done/message', cookie, { method: 'POST' }), 'trip-done', getDatabase)
  assert.equal(post.status, 404)
})

test('B6 invitation text carries action, reason and room not to', () => {
  for (const source of [null, { id: 'f', kind: 'zhihu', title: '巷口那面墙' },
    { id: 'f', kind: 'scene', title: '河边的旧长椅' }, { id: 'f', kind: 'moment', title: '楼下在修路' }]) {
    const text = invitationText(source)
    assert.ok(/拍一张|说一句/.test(text))
    assert.ok(/我想/.test(text))
    assert.ok(text.includes('不方便就算了'))
    assert.ok([...text].length >= 8 && [...text].length <= 200)
  }
})

test('B6 creates an invitation from one owned finding and reads it back as waiting', t => {
  const { db, session } = setup(t)
  const result = createInvitationStore(db, { now: () => new Date(at) }).create('dog-owner', session, { basedOnFindId: 'find-1' })
  assert.ok('invitation' in result)
  assert.match(result.invitation.id, /^inv_/)
  assert.equal(result.invitation.basedOnFindId, 'find-1')
  assert.equal(result.invitation.createdAt, at)
  const state = db.prepare("SELECT state FROM v_invitation_state WHERE invitation_id = ?").get(result.invitation.id)
  assert.equal(state.state, 'waiting')
  assert.throws(() => createInvitationStore(db).create('dog-owner', session, { basedOnFindId: 'foreign' }), { code: 'CONFLICT' })
})

test('B6 stops at three waiting invitations and never invents a tripId', t => {
  const { db, session } = setup(t)
  const store = createInvitationStore(db, { now: () => new Date(at) })
  for (let i = 0; i < MAX_WAITING_INVITATIONS; i += 1) {
    assert.ok('invitation' in store.create('dog-owner', session, {}))
  }
  const before = db.prepare('SELECT COUNT(*) n FROM invitation').get().n
  const fourth = store.create('dog-owner', session, {})
  assert.ok('wentAlone' in fourth)
  assert.equal(fourth.tripId, 'trip-done')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invitation').get().n, before)

  const empty = setup(t)
  const emptyStore = createInvitationStore(empty.db, { now: () => new Date(at) })
  for (let i = 0; i < MAX_WAITING_INVITATIONS; i += 1) {
    assert.ok('invitation' in emptyStore.create('dog-owner', empty.session, {}))
  }
  empty.db.prepare('DELETE FROM find').run()
  empty.db.prepare('DELETE FROM trip').run()
  assert.throws(() => emptyStore.create('dog-owner', empty.session, {}), { code: 'CONFLICT' })
})

test('B6 duplicate basedOnFindId reuses the waiting invitation', t => {
  const { db, session } = setup(t)
  const store = createInvitationStore(db, { now: () => new Date(at) })
  const first = store.create('dog-owner', session, { basedOnFindId: 'find-1' })
  const second = store.create('dog-owner', session, { basedOnFindId: 'find-1' })
  assert.deepEqual(second, first)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invitation').get().n, 1)
})
