import { randomUUID } from 'node:crypto'
import { issueOwnerSession } from '../../lib/auth/session.ts'

export function fixtureSession(db, subject = randomUUID(), production = false) {
  const env = process.env.NODE_ENV
  if (production) process.env.NODE_ENV = 'production'
  try {
    const { ownerId, setCookie } = issueOwnerSession(db, { provider: 'zhihu', subject })
    return { sessionId: ownerId, setCookie }
  } finally {
    if (env === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = env
  }
}
