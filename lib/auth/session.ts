import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { getDatabase } from '../db/connection.ts'

type Namespace = 'development' | 'zhihu'
export type AuthContext = Readonly<{ ownerId: string; namespace: Namespace; tokenHash: string }>
const ttlSeconds = 7 * 24 * 60 * 60
const developmentFile = /(?:^|[\\/])a5-development(?:-[a-z0-9-]+)?\.sqlite$/i

export function developmentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production' && env.APP_IDENTITY_PROVIDER === 'development' &&
    !!env.DATABASE_PATH && developmentFile.test(env.DATABASE_PATH)
}

function activeNamespace(db: DatabaseSync): Namespace | null {
  const location = db.location()
  if (!location) return null
  const actual = realpathSync(location)
  if (process.env.APP_IDENTITY_PROVIDER === 'development') {
    return developmentEnabled() && developmentFile.test(actual) &&
      realpathSync(process.env.DATABASE_PATH!) === actual ? 'development' : null
  }
  return developmentFile.test(actual) ? null : 'zhihu'
}

export function sessionCookieName(): string {
  return process.env.NODE_ENV === 'production' ? '__Host-zhihu_session' : 'zhihu_session'
}

function cookie(value: string, maxAge: number) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${sessionCookieName()}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

export function clearSessionCookie(): string {
  return cookie('', 0)
}

function hashFromCookie(request: Request): string | null {
  const prefix = `${sessionCookieName()}=`
  const matches = (request.headers.get('cookie') ?? '').split(';')
    .map(part => part.trim()).filter(part => part.startsWith(prefix))
  if (matches.length !== 1) return null
  const token = matches[0].slice(prefix.length)
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? hashToken(token) : null
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** The only request-to-owner boundary. Cookie values never serve as ownership keys. */
export function resolveAuthContext(request: Request, database: DatabaseSync | (() => DatabaseSync)): AuthContext | null {
  const tokenHash = hashFromCookie(request)
  if (!tokenHash) return null
  const db = typeof database === 'function' ? database() : database
  const namespace = activeNamespace(db)
  if (!namespace) return null
  const row = db.prepare(`SELECT o.id FROM owner_session s JOIN owner o ON o.id = s.owner_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND o.namespace = ?`)
    .get(tokenHash, Date.now(), namespace)
  return row ? { ownerId: String(row.id), namespace, tokenHash } : null
}

/** Compatibility for existing B HTTP consumers using dog.session_id and photo ownership. */
export function readSessionId(request: Request): string | null {
  return resolveAuthContext(request, getDatabase)?.ownerId ?? null
}

/** Call only after server-side provider verification. The exact subject string is opaque. */
export function issueOwnerSession(db: DatabaseSync, identity: { provider: Namespace; subject: string }) {
  if (activeNamespace(db) !== identity.provider) throw new Error('Identity namespace unavailable')
  if (typeof identity.subject !== 'string' || !identity.subject.length || identity.subject.length > 512 ||
      identity.subject !== identity.subject.trim() ||
      [...identity.subject].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error('Invalid provider subject')
  }
  const now = Date.now()
  const token = randomBytes(32).toString('base64url')
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare(`SELECT id FROM owner WHERE namespace = ? AND provider = ? AND provider_subject = ?`)
      .get(identity.provider, identity.provider, identity.subject)
    const ownerId = row ? String(row.id) : `owner_${randomUUID()}`
    if (!row) {
      db.prepare('INSERT INTO owner (id, namespace, provider, provider_subject, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(ownerId, identity.provider, identity.provider, identity.subject, new Date(now).toISOString())
    }
    db.prepare('INSERT INTO owner_session (token_hash, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(token), ownerId, now, now + ttlSeconds * 1000)
    db.exec('COMMIT')
    return { ownerId, setCookie: cookie(token, ttlSeconds) }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function startDevelopmentSession(request: Request, db: DatabaseSync): string | null {
  if (resolveAuthContext(request, db)?.namespace === 'development') return null
  return issueOwnerSession(db, { provider: 'development', subject: randomUUID() }).setCookie
}

export function revokeSession(request: Request, db: DatabaseSync): void {
  const auth = resolveAuthContext(request, db)
  if (!auth) return
  db.prepare(`UPDATE owner_session SET revoked_at = MAX(created_at, ?)
    WHERE token_hash = ? AND owner_id = ? AND revoked_at IS NULL`).run(Date.now(), auth.tokenHash, auth.ownerId)
}

export class OwnershipError extends Error {
  readonly code = 'NOT_FOUND'
}

export function assertOwnedDog(db: DatabaseSync, dogId: string, auth: AuthContext): void {
  if (!db.prepare('SELECT 1 FROM dog WHERE id = ? AND owner_id = ?').get(dogId, auth.ownerId)) {
    throw new OwnershipError('这条记录不在这里')
  }
}

export function assertOwnedTrip(db: DatabaseSync, tripId: string, auth: AuthContext): void {
  if (!db.prepare(`SELECT 1 FROM trip t JOIN dog d ON d.id = t.dog_id WHERE t.id = ? AND d.owner_id = ?`)
    .get(tripId, auth.ownerId)) throw new OwnershipError('这条记录不在这里')
}
