import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { openDatabase } from '../lib/db/bootstrap.ts'
import compatibility from '../lib/events/scene-compat.json' with { type: 'json' }
import { resolveSceneContext } from '../lib/events/scene-context.ts'
import { createTripEventSelector } from '../lib/events/select.ts'
import { createTripService } from '../lib/trips/service.ts'

const scenes = JSON.parse(readFileSync('team/2026-11-22/e/e2c/scene-map.json', 'utf8')).scenes
const poolSql = readFileSync('team/2026-11-18/d/1118-d2c-事件池三十条-v1.sql', 'utf8')
const startAt = '2026-11-23T03:00:00.000Z'
const date = at => () => new Date(at)
const scene = (name, season = 'spring', weather = 'clear', timeOfDay = 'morning') =>
  ({ sceneFile: `scenes/${name}.png`, season, weather, timeOfDay })
const history = db => db.prepare('SELECT * FROM trip_event ORDER BY trip_id, event_id').all()
const pool = db => db.prepare('SELECT * FROM event ORDER BY code').all()
const only = (db, ...codes) => {
  db.exec('UPDATE event SET enabled = 0')
  const enable = db.prepare('UPDATE event SET enabled = 1 WHERE code = ?')
  for (const code of codes) assert.equal(enable.run(code).changes, 1)
}

function setup(t) {
  const root = resolve('.local', 'event-selector-tests')
  mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(join(root, 'db-'))
  const path = join(directory, 'app.sqlite')
  const db = openDatabase(path)
  t.after(() => {
    if (db.isOpen) db.close()
    assert.ok(directory.startsWith(root + sep))
    rmSync(directory, { recursive: true })
  })
  db.exec(poolSql)

  function trip(name = 'one', at = startAt, start = true) {
    const dogId = `dog-${name}`
    const sessionId = `owner-${name}`
    db.prepare('INSERT OR IGNORE INTO owner VALUES(?,?,?,?,?)').run(sessionId, 'zhihu', 'zhihu', name, at)
    db.prepare(`INSERT OR IGNORE INTO dog(id,session_id,owner_id,personality_tags,assembly,created_at)
      VALUES(?,?,?, '["好奇","看物","直给"]', '{"cloth":"hoodie","hat":null,"glasses":null,"face":"hopeful"}', ?)`)
      .run(dogId, sessionId, sessionId, at)
    const trips = createTripService(db, { now: date(at) })
    const tripId = trips.create(dogId, sessionId, 'auto').id
    if (start) trips.start(tripId, sessionId)
    return { dogId, tripId, sessionId, conditions: scene('nantou') }
  }
  return { db, path, trip }
}

test('the approved source projection covers exactly the 12 E2c file keys', () => {
  assert.equal(compatibility.source.blob, 'addef0059cc2e2bfc791b477d2f9b12747a5abc5')
  assert.equal(createHash('sha256').update(JSON.stringify(compatibility.scenes)).digest('hex'),
    'da1d4047e776e50f39b1ab50122d8687b397d6e0ebba9bf39712c2d302bc5386')
  assert.deepEqual(Object.keys(compatibility.scenes).sort(), scenes.map(row => row.file).sort())
  for (const { file } of scenes) {
    assert.deepEqual(resolveSceneContext(file), { sceneFile: file, availablePlaces: compatibility.scenes[file] })
  }
  assert.deepEqual(resolveSceneContext('scenes/nantou.png').availablePlaces, ['street', 'stall'])
  for (const unknown of ['深圳南头古城', 'scenes/bookstore.png', 'toString', '../scenes/nantou.png', ['scenes/nantou.png']]) {
    assert.equal(resolveSceneContext(unknown), null)
  }
})

const city = ['nantou', 'late-night-corner', 'beijing-road']
const cityAndPark = [...city, 'city-community-park']
const allowed = {
  any_lost_dog_poster: [],
  any_market_scale: [],
  any_moon_ring: [],
  any_shop_cat: city,
  any_slow_walker: cityAndPark,
  any_street_music: cityAndPark,
  autumn_birds: [],
  autumn_book_box: [],
  autumn_chestnut: city,
  autumn_ginkgo: cityAndPark,
  autumn_radio: city,
  autumn_river_fog: [],
  spring_cat_undercar: ['late-night-corner'],
  spring_first_green: city,
  spring_kite: ['changbai', 'kanas', 'sanya', 'panjin-red-beach', 'guilin-li-river'],
  spring_laundry: [],
  spring_plum_rain: ['nantou', 'beijing-road'],
  spring_seed_stall: city,
  summer_bookstore_ac: [],
  summer_cicada: cityAndPark,
  summer_icecream: city,
  summer_night_stall: [],
  summer_river_fish: ['guilin-li-river'],
  summer_shower: cityAndPark,
  winter_bookstore_chair: [],
  winter_first_snow: cityAndPark,
  winter_one_glove: ['city-community-park'],
  winter_river_ice: [],
  winter_sweet_potato: ['late-night-corner', 'beijing-road'],
  winter_window_steam: [],
}

test('all 30 D events are checked against all 12 scenes with matching candidate time and weather', t => {
  const { db, trip } = setup(t)
  const events = pool(db)
  assert.deepEqual(events.map(row => row.code), Object.keys(allowed).sort())
  const pick = createTripEventSelector(db, { now: date(startAt), random: () => 0 })
  for (const event of events) {
    only(db, event.code)
    const before = pool(db)
    for (const { file } of scenes) {
      const input = trip(`${event.code}:${file}`)
      const result = pick({ ...input, conditions: {
        sceneFile: file,
        season: event.season === 'any' ? 'spring' : event.season,
        weather: event.weather === 'any' ? 'clear' : event.weather,
        timeOfDay: event.time_of_day === 'any' ? 'morning' : event.time_of_day,
      } })
      const expected = allowed[event.code].includes(file.slice('scenes/'.length, -'.png'.length))
      assert.equal(result?.eventId ?? null, expected ? event.id : null, `${event.code} × ${file}`)
    }
    assert.deepEqual(pool(db), before)
  }
  assert.equal(history(db).length, Object.values(allowed).flat().length)
})

test('unknown scene, missing conditions, time and weather mismatch, coarse tags and disabled rows yield null', t => {
  const { db, trip } = setup(t)
  const input = trip()
  const pick = createTripEventSelector(db, { now: date(startAt), random: () => 0 })
  only(db, 'spring_first_green')
  for (const conditions of [null, {}, scene('unknown'), scene('nantou', 'winter'), scene('nantou', 'spring', 'rain'),
    scene('nantou', 'spring', 'clear', 'dusk'), scene('nantou', 'any')]) {
    assert.equal(pick({ ...input, conditions }), null)
  }
  only(db, 'summer_cicada')
  assert.equal(pick({ ...input, conditions: scene('city-community-park', 'summer') }), null)
  only(db)
  assert.equal(pick(input), null)
  only(db, 'spring_first_green')
  db.exec(`UPDATE event SET place_tags = '["riverside"]' WHERE code = 'spring_first_green'`)
  assert.equal(pick(input), null)
  assert.deepEqual(history(db), [])
})

test('interests, empty match tags, blocked topics and reviewed event text gate selection', t => {
  const { db, trip } = setup(t)
  const input = trip()
  const pick = createTripEventSelector(db, { now: date(startAt), random: () => 0 })
  const profile = db.prepare('UPDATE dog SET interest_categories = ?, blocked_topics = ? WHERE id = ?')
  const event = (fields, ...values) =>
    db.prepare(`UPDATE event SET ${fields} WHERE code = 'spring_first_green'`).run(...values)
  only(db, 'spring_first_green')
  profile.run('["冷知识","城市角落"]', '[]', input.dogId)
  assert.equal(pick(input), null)
  profile.run('["自然风景","城市角落"]', '["墙根"]', input.dogId)
  assert.equal(pick(input), null)
  profile.run(null, '["动物与植物"]', input.dogId)
  assert.equal(pick(input), null)
  profile.run(null, '[]', input.dogId)
  const original = db.prepare("SELECT text FROM event WHERE code = 'spring_first_green'").get().text
  event('text = ?', '未经审核的新文本')
  assert.equal(pick(input), null)
  event('text = ?, code = ?', original, 'new_unreviewed_event')
  assert.equal(pick(input), null)
  db.exec("UPDATE event SET code = 'spring_first_green' WHERE code = 'new_unreviewed_event'")
  assert.equal(pick(input)?.eventId, 'ev_spring_first_green')
  assert.equal(db.prepare('SELECT interest_categories FROM dog WHERE id = ?').get(input.dogId).interest_categories, null)

  const other = trip('other')
  profile.run('["冷知识","城市角落"]', '[]', other.dogId)
  event('match_tags = ?', '[]')
  assert.equal(pick(other)?.eventId, 'ev_spring_first_green')
})

test('injected draw follows stable order and weight boundaries, including event any conditions', t => {
  const { db, trip } = setup(t)
  only(db, 'spring_first_green', 'any_slow_walker')
  db.exec("UPDATE event SET weight = 1 WHERE code = 'any_slow_walker'; UPDATE event SET weight = 3 WHERE code = 'spring_first_green'")
  for (const [i, fraction, id] of [[0, 0, 'ev_any_slow_walker'], [1, 0.2499, 'ev_any_slow_walker'],
    [2, 0.25, 'ev_spring_first_green'], [3, 0.9999, 'ev_spring_first_green']]) {
    const pick = createTripEventSelector(db, { now: date(startAt), random: () => fraction })
    assert.equal(pick(trip(String(i)))?.eventId, id)
  }
})

test('cooldown covers earlier trips for the same dog and ends at exactly seven UTC days', t => {
  const { db, trip } = setup(t)
  only(db, 'spring_first_green')
  const beforeEnd = '2026-11-30T02:59:59.999Z'
  const end = '2026-11-30T03:00:00.000Z'
  const first = trip()
  assert.equal(createTripEventSelector(db, { now: date(startAt) })(first)?.happenedAt, startAt)
  createTripService(db, { now: date(startAt) }).finish(first.tripId, first.sessionId, 'done')
  const next = trip('one', beforeEnd)
  assert.equal(createTripEventSelector(db, { now: date(beforeEnd) })(next), null)
  const other = trip('other', beforeEnd)
  assert.equal(createTripEventSelector(db, { now: date(beforeEnd) })(other)?.happenedAt, beforeEnd)
  assert.equal(createTripEventSelector(db, { now: date(end) })(next)?.happenedAt, end)
  assert.equal(history(db).length, 3)
})

test('ownership, running state and controlled clock are checked without inserting or revealing history', t => {
  const { db, trip } = setup(t)
  only(db, 'spring_first_green')
  const pending = trip('pending', startAt, false)
  const input = trip()
  const other = trip('other')
  const pick = createTripEventSelector(db, { now: date(startAt) })
  assert.throws(() => pick(pending), { code: 'CONFLICT' })
  assert.throws(() => pick({ ...input, sessionId: other.sessionId }), { code: 'NOT_FOUND' })
  assert.throws(() => pick({ ...input, dogId: other.dogId }), { code: 'NOT_FOUND' })
  assert.throws(() => pick({ ...input, tripId: 'missing' }), { code: 'NOT_FOUND' })
  const early = createTripEventSelector(db, { now: date('2026-11-23T02:59:59.999Z') })
  assert.throws(() => early(input), { code: 'CONFLICT' })
  createTripService(db, { now: date(startAt) }).finish(input.tripId, input.sessionId, 'done')
  assert.throws(() => pick(input), { code: 'CONFLICT' })
  assert.deepEqual(history(db), [])
})

test('retry reuses the stored occurrence after reopening, with no redraw or new timestamp', t => {
  const { db, path, trip } = setup(t)
  const input = trip()
  only(db, 'spring_first_green')
  const first = createTripEventSelector(db, { now: date(startAt) })(input)
  assert.deepEqual(first, { tripId: input.tripId, dogId: input.dogId, eventId: 'ev_spring_first_green', happenedAt: startAt })
  only(db)
  db.close()
  const reopened = openDatabase(path)
  try {
    const pick = createTripEventSelector(reopened, {
      now: () => assert.fail('retry must not read the clock'),
      random: () => assert.fail('retry must not redraw'),
    })
    assert.deepEqual(pick({ ...input, conditions: null }), first)
    assert.throws(() => pick({ ...input, sessionId: 'owner-other' }), { code: 'NOT_FOUND' })
    assert.equal(history(reopened).length, 1)
  } finally {
    reopened.close()
  }
})

test('write fault, ambiguous historical facts and invalid randomness propagate and roll back', t => {
  const { db, trip } = setup(t)
  const input = trip()
  only(db, 'spring_first_green')
  const badDraw = createTripEventSelector(db, { now: date(startAt), random: () => 1 })
  assert.throws(() => badDraw(input), /Invalid event random draw/)
  const before = pool(db)
  const pick = createTripEventSelector(db, { now: date(startAt) })
  db.exec(`CREATE TRIGGER test_event_fault AFTER INSERT ON trip_event BEGIN
    UPDATE event SET enabled = 0;
    SELECT RAISE(FAIL, 'test write failure');
  END`)
  assert.throws(() => pick(input), /test write failure/)
  assert.equal(db.isTransaction, false)
  assert.deepEqual(history(db), [])
  assert.deepEqual(pool(db), before)
  db.exec('DROP TRIGGER test_event_fault')
  assert.equal(pick(input)?.eventId, 'ev_spring_first_green')
  db.prepare('INSERT INTO trip_event VALUES(?,?,?,?)')
    .run(input.tripId, 'ev_any_slow_walker', input.dogId, startAt)
  const ambiguous = history(db)
  assert.throws(() => pick(input), /Inconsistent trip event history/)
  assert.deepEqual(history(db), ambiguous)
})

test('two SQLite connections racing with different draws commit one occurrence and return the same row', async t => {
  const { db, path, trip } = setup(t)
  const input = trip()
  only(db, 'spring_first_green', 'any_slow_walker')
  const workers = [0, 0.99].map(random => new Worker(new URL('./helpers/event-selector-worker.mjs', import.meta.url), {
    workerData: { path, input, random, startAt },
  }))
  t.after(() => Promise.all(workers.map(worker => worker.terminate())))
  for (const [ready] of await Promise.all(workers.map(worker => once(worker, 'message')))) assert.equal(ready, 'ready')
  const results = workers.map(worker => once(worker, 'message'))
  workers.forEach(worker => worker.postMessage('start'))
  const [[first], [second]] = await Promise.all(results)
  assert.ok(first)
  assert.deepEqual(first, second)
  assert.equal(history(db).length, 1)
})
