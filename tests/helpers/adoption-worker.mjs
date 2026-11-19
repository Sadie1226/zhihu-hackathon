import { DatabaseSync } from 'node:sqlite'
import { createDevelopmentDog } from '../../lib/adoption/development.ts'
const db = new DatabaseSync(process.argv[2], { timeout: 5000 })
try {
  const dog = createDevelopmentDog(
    db,
    'parallel-owner',
    JSON.parse(process.argv[3]),
  )
  process.stdout.write(JSON.stringify({ ok: true, id: dog.id }))
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }))
} finally {
  db.close()
}
