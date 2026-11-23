import { test } from 'node:test'
import { replaySemanticHoldout } from '../scripts/a5/a6-semantic-replay.mjs'

test('frozen real unseen-theme responses retain measured abstention and two-dog semantic distinction', async () => {
  await replaySemanticHoldout()
})
