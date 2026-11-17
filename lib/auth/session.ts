import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export function sessionCookieName(production = process.env.NODE_ENV === 'production'): string {
  return production ? '__Host-zhihu_session' : 'zhihu_session'
}

/** Only the hash is stored in dog.session_id; never return the bearer cookie in a DTO. */
export function readSessionId(request: Request, production = process.env.NODE_ENV === 'production'): string | null {
  const name = sessionCookieName(production)
  const matches = (request.headers.get('cookie') ?? '').split(';')
    .map(part => part.trim()).filter(part => part.startsWith(`${name}=`))
  if (matches.length !== 1) return null
  const token = matches[0].slice(name.length + 1)
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
  return hash(token)
}

function hash(token: string): string {
  return `anon_${createHash('sha256').update(token).digest('hex')}`
}

/** A's adoption route calls this, writes sessionId, and attaches setCookie if present. */
export function ensureAnonymousSession(request: Request, db: DatabaseSync,
  production = process.env.NODE_ENV === 'production'): { sessionId: string; setCookie: string | null } {
  const existing = readSessionId(request, production)
  if (existing && db.prepare('SELECT 1 FROM dog WHERE session_id = ? LIMIT 1').get(existing)) {
    return { sessionId: existing, setCookie: null }
  }
  // Rotate unknown cookies: an attacker cannot choose the session created at adoption.
  const token = randomBytes(32).toString('base64url')
  return {
    sessionId: hash(token),
    setCookie: `${sessionCookieName(production)}=${token}; Path=/; HttpOnly; SameSite=Lax${production ? '; Secure' : ''}`,
  }
}
