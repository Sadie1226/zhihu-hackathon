import type { ExchangePayload, Snapshot } from '../contracts/types.ts'

// Compile-time regressions complement runtime/SQLite tests; no production data.
const snapshot: Snapshot = { dogId: 'fixture', version: 1, personalityTags: [], interestCategories: null,
  recentTrips: [], waitingFor: null, createdAt: '2026-11-19T00:00:00Z' }
const historical: ExchangePayload = { kind: 'find', findTitle: 'fixture', findExcerpt: null, sourceUrl: null }
const current: ExchangePayload = { kind: 'gift', giftName: 'fixture', note: null, imagePath: null,
  sourceFindId: null, sourceMode: null }
// @ts-expect-error Provenance belongs only to find/gift.
const badGreeting: ExchangePayload = { kind: 'greeting', line: 'fixture', weather: null, sourceFindId: null }
// @ts-expect-error Invalid provenance mode must not compile.
const badMode: ExchangePayload = { kind: 'find', findTitle: 'fixture', findExcerpt: null, sourceUrl: null, sourceMode: 'unknown' }
void [snapshot, historical, current, badGreeting, badMode]
