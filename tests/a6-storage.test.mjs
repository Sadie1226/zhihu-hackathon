import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runA6FixtureReview } from './helpers/a6-review.mjs'

test('A6 fixture selection -> current Find store -> C4 finish -> B Message -> reopened owner GET', async () => {
  const report = await runA6FixtureReview()
  assert.equal(report.mode, 'fixture')
  assert.ok(Object.values(report.checks).every(value => value === true))
  assert.notEqual(report.results[0].selectedCandidateId, report.results[1].selectedCandidateId)
  for (const entry of report.results) {
    assert.equal(entry.find.sourceMode, 'fixture')
    assert.equal(entry.find.sourceUrl, entry.selectedCandidateId)
    assert.equal(entry.message.mentionsFindId, entry.find.id)
  }
})
