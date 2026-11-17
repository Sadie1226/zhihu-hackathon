import type { DatabaseSync } from 'node:sqlite'

export function databaseHealth(connect: () => DatabaseSync): Response {
  try {
    const db = connect()
    db.prepare('SELECT 1 FROM dog LIMIT 1').get()
    return Response.json(
      { ok: true, service: 'zhihu-hackathon', database: 'ok' },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch {
    // Never put exception text, paths, environment variables, or credentials here.
    return Response.json(
      { ok: false, service: 'zhihu-hackathon', database: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
