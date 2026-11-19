import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  EXCLUSIVE_PAIRS,
  INTEREST_CATEGORIES,
  checkPersonalityTags,
} from '../../contracts/types.ts'
import type { Assembly } from '../../contracts/types.ts'
import type {
  AdoptionDraft,
  CreateDogInput,
  DogView,
  GenerationView,
  ProfileView,
} from './view.ts'

export class AdoptionError extends Error {
  code: 'CONFLICT' | 'NOT_FOUND'
  constructor(code: 'CONFLICT' | 'NOT_FOUND', message: string) {
    super(message)
    this.code = code
  }
}
const invalid = (message: string): never => {
  throw new AdoptionError('CONFLICT', message)
}
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Development identity is opt-in, non-production, and must use a separate SQLite file. */
export function developmentEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.NODE_ENV !== 'production' &&
    env.APP_IDENTITY_PROVIDER === 'development' &&
    !!env.DATABASE_PATH &&
    /(?:^|[\\/])a5-development(?:-[a-z0-9-]+)?\.sqlite$/i.test(
      env.DATABASE_PATH,
    )
  )
}

export const mockProfile: ProfileView = {
  source: 'mock',
  version: 'a5-mock-v1',
  sections: {
    basic: { status: 'ok', count: 1 },
    collections: { status: 'ok', count: 2 },
    followees: { status: 'empty', count: 0 },
    contents: { status: 'ok', count: 1 },
  },
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('输入格式不正确')
  return value as Record<string, unknown>
}
export function parseDraft(value: unknown): AdoptionDraft {
  const input = record(value)
  if (typeof input.name !== 'string') invalid('给它写一个名字吧')
  const name = (input.name as string).trim()
  if (
    Array.from(name).length < 1 ||
    Array.from(name).length > 6 ||
    Array.from(name).some(
      (c) => c.codePointAt(0)! < 32 || c.codePointAt(0) === 127,
    )
  )
    invalid('名字请写 1–6 个字')
  const categories = input.interestCategories
  if (
    categories !== null &&
    (!Array.isArray(categories) ||
      categories.length < 2 ||
      categories.length > 3 ||
      new Set(categories).size !== categories.length ||
      categories.some((c) => !INTEREST_CATEGORIES.includes(c)))
  )
    invalid('兴趣可跳过，选择时选 2–3 类')
  if (
    !Array.isArray(input.tendencies) ||
    input.tendencies.length !== 6 ||
    input.tendencies.some(
      (t) =>
        typeof t !== 'number' ||
        !Number.isFinite(t) ||
        t < -2 ||
        t > 2 ||
        Math.abs(t * 5 - Math.round(t * 5)) > 1e-8,
    )
  )
    invalid('请核对六组性格倾向')
  return {
    name,
    interestCategories: categories as AdoptionDraft['interestCategories'],
    tendencies: input.tendencies as number[],
  }
}

/** Explicit mock generator: manual magnitude first; mock profile fills tied/neutral dimensions. */
export function generateDevelopment(draft: AdoptionDraft): GenerationView {
  const profilePriority = [0, 3, 5, 1, 2, 4]
  const dimensions = profilePriority
    .toSorted(
      (a, b) => Math.abs(draft.tendencies[b]) - Math.abs(draft.tendencies[a]),
    )
    .slice(0, 3)
  const tags = dimensions.map(
    (i) => EXCLUSIVE_PAIRS[i][draft.tendencies[i] > 0 ? 1 : 0],
  ) as GenerationView['tags']
  if (!checkPersonalityTags(tags).ok) invalid('性格词暂时没整理好')
  return {
    tags,
    fingerprint: digest([draft, mockProfile.version]),
    source: 'mock',
  }
}

function parseAssembly(value: unknown): Assembly {
  const input = record(value)
  if (Object.keys(input).sort().join(',') !== 'cloth,face,glasses,hat')
    invalid('外观需要四项选择')
  const allowed = {
    cloth: ['hoodie', 'jacket', 'sweater', 'raincoat', 'apron', 'scarf-coat'],
    hat: ['beanie', 'cap', 'straw', 'none', null],
    glasses: ['round', 'square', 'sun', 'none', null],
    face: ['happy', 'tired', 'hopeful', 'waiting'],
  }
  for (const key of Object.keys(allowed) as (keyof Assembly)[]) {
    if (!(allowed[key] as unknown[]).includes(input[key]))
      invalid('外观选项不符合四键装配单')
  }
  return {
    cloth: input.cloth,
    hat: input.hat,
    glasses: input.glasses,
    face: input.face,
  } as Assembly
}

export function ownedDog(
  db: DatabaseSync,
  sessionId: string,
  id?: string,
): DogView | null {
  const rows = db
    .prepare(
      `SELECT id,name,personality_tags,interest_categories,assembly,is_sample
    FROM dog WHERE session_id = ? ${id ? 'AND id = ?' : ''} ORDER BY created_at,id LIMIT 2`,
    )
    .all(...(id ? [sessionId, id] : [sessionId]))
  if (rows.length > 1) invalid('发现多份旧伙伴记录，需要先核对归属')
  const row = rows[0]
  return row
    ? {
        id: String(row.id),
        name: row.name === null ? null : String(row.name),
        personalityTags: JSON.parse(String(row.personality_tags)),
        interestCategories:
          row.interest_categories === null
            ? null
            : JSON.parse(String(row.interest_categories)),
        assembly: JSON.parse(String(row.assembly)),
        isSample: row.is_sample === 1,
      }
    : null
}

export function createDevelopmentDog(
  db: DatabaseSync,
  sessionId: string,
  value: unknown,
): DogView {
  const input = record(value)
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'name',
          'interestCategories',
          'tendencies',
          'assembly',
          'fingerprint',
          'requestId',
        ].includes(key),
    )
  )
    invalid('输入包含未定义字段')
  const draft = parseDraft(input)
  const generated = generateDevelopment(draft)
  if (generated.fingerprint !== input.fingerprint)
    invalid('资料或偏好已改变，请重新整理性格词')
  if (
    typeof input.requestId !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(input.requestId)
  )
    invalid('请保留本次创建标识后重试')
  const assembly = parseAssembly(input.assembly)
  // Temporary development-only receipt in A-owned id. No new table or migration; C will define
  // durable owner/idempotency storage for real accounts. Both hashes hide the session and inputs.
  const requestKey = `dev_${digest([sessionId, input.requestId]).slice(0, 32)}`
  const id = `${requestKey}_${digest([draft, assembly, mockProfile.version])}`
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = ownedDog(db, sessionId)
    if (existing && existing.id !== id)
      invalid(
        existing.id.startsWith(`${requestKey}_`)
          ? '同一创建标识的内容已改变'
          : '你已经领养过了，可以回小屋看看',
      )
    if (!existing)
      db.prepare(
        `INSERT INTO dog(id,name,session_id,personality_tags,interest_categories,assembly,created_at)
      VALUES(?,?,?,?,?,?,?)`,
      ).run(
        id,
        draft.name,
        sessionId,
        JSON.stringify(generated.tags),
        draft.interestCategories === null
          ? null
          : JSON.stringify(draft.interestCategories),
        JSON.stringify(assembly),
        new Date().toISOString(),
      )
    const dog = existing ?? ownedDog(db, sessionId)!
    db.exec('COMMIT')
    return dog
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function renameDevelopmentDog(
  db: DatabaseSync,
  sessionId: string,
  id: string,
  name: unknown,
): DogView {
  const draft = parseDraft({
    name,
    interestCategories: null,
    tendencies: [0, 0, 0, 0, 0, 0],
  })
  const result = db
    .prepare('UPDATE dog SET name = ? WHERE id = ? AND session_id = ?')
    .run(draft.name, id, sessionId)
  if (!result.changes) throw new AdoptionError('NOT_FOUND', '这只伙伴不在这里')
  return ownedDog(db, sessionId, id)!
}

// Kept as a type boundary for the future real provider; no client-authored owner/token is accepted.
export type DevelopmentCreateInput = CreateDogInput
