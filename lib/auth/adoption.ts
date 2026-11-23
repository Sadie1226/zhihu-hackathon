import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export class AdoptionReceiptConflict extends Error {
  readonly reason: 'changed' | 'already-owned'
  constructor(reason: 'changed' | 'already-owned') {
    super(reason)
    this.reason = reason
  }
}

/** Atomically claim the first dog and record the normalized request. Inputs are server-validated. */
export function recordAdoption(
  db: DatabaseSync,
  ownerId: string,
  request: { id: string; hash: string },
  create: (dogId: string, timestamp: string) => void,
): string {
  db.exec('BEGIN IMMEDIATE')
  try {
    const receipt = db.prepare(`SELECT request_hash, dog_id FROM adoption_receipt
      WHERE owner_id = ? AND request_id = ?`).get(ownerId, request.id)
    let dogId: string
    if (receipt) {
      if (receipt.request_hash !== request.hash) throw new AdoptionReceiptConflict('changed')
      dogId = String(receipt.dog_id)
    } else {
      if (db.prepare('SELECT 1 FROM dog WHERE owner_id = ?').get(ownerId)) {
        throw new AdoptionReceiptConflict('already-owned')
      }
      dogId = `dog_${randomUUID()}`
      const timestamp = new Date().toISOString()
      create(dogId, timestamp)
      db.prepare(`INSERT INTO adoption_receipt (owner_id, request_id, request_hash, dog_id, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(ownerId, request.id, request.hash, dogId, timestamp)
    }
    db.exec('COMMIT')
    return dogId
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
