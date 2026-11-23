import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { AdoptionReceiptConflict, recordAdoption } from '../auth/adoption.ts'
export { developmentEnabled } from '../auth/session.ts'
import {
  EXCLUSIVE_PAIRS,
  INTEREST_CATEGORIES,
  checkPersonalityTags,
} from '../../contracts/types.ts'
import { isTspfAssembly, isLegacyAssembly, parseStoredAssembly } from '../../contracts/assembly.ts'
import type { TspfAssembly } from '../../contracts/assembly.ts'
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

function parseAssembly(value: unknown): TspfAssembly {
  if (!isTspfAssembly(value)) invalid('请按新版套装、衣服、饰品和表情重新选择穿搭')
  return value as TspfAssembly
}

export function ownedDog(
  db: DatabaseSync,
  ownerId: string,
  id?: string,
): DogView | null {
  const row = db
    .prepare(
      `SELECT id,name,personality_tags,interest_categories,assembly,is_sample
    FROM dog WHERE owner_id = ? ${id ? 'AND id = ?' : ''}`,
    )
    .get(...(id ? [ownerId, id] : [ownerId]))
  return row
    ? {
        id: String(row.id),
        name: row.name === null ? null : String(row.name),
        personalityTags: JSON.parse(String(row.personality_tags)),
        interestCategories:
          row.interest_categories === null
            ? null
            : JSON.parse(String(row.interest_categories)),
        assembly: parseStoredAssembly(String(row.assembly)),
        isSample: row.is_sample === 1,
      }
    : null
}

export function createDevelopmentDog(
  db: DatabaseSync,
  ownerId: string,
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
  const requestId = input.requestId
  if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId)) {
    return invalid('请保留本次创建标识后重试')
  }
  const legacy = isLegacyAssembly(input.assembly) ? input.assembly : null
  // Old receipts remain replayable with their original normalized hash; new legacy writes stay rejected.
  const assembly = legacy ? { cloth: legacy.cloth, hat: legacy.hat, glasses: legacy.glasses, face: legacy.face }
    : parseAssembly(input.assembly)
  const receipt = { id: requestId, hash: digest([draft, assembly, mockProfile.version]) }
  try {
    const id = recordAdoption(db, ownerId, receipt, (dogId, timestamp) => {
      if (legacy) invalid('请按新版套装、衣服、饰品和表情重新选择穿搭')
      db.prepare(
        `INSERT INTO dog(id,name,session_id,owner_id,personality_tags,interest_categories,assembly,created_at)
      VALUES(?,?,?,?,?,?,?,?)`,
      ).run(
        dogId,
        draft.name,
        ownerId,
        ownerId,
        JSON.stringify(generated.tags),
        draft.interestCategories === null
          ? null
          : JSON.stringify(draft.interestCategories),
        JSON.stringify(assembly),
        timestamp,
      )
    })
    return ownedDog(db, ownerId, id)!
  } catch (error) {
    if (error instanceof AdoptionReceiptConflict)
      invalid(error.reason === 'changed' ? '同一创建标识的内容已改变' : '你已经领养过了，可以回小屋看看')
    throw error
  }
}

export function renameDevelopmentDog(
  db: DatabaseSync,
  ownerId: string,
  id: string,
  name: unknown,
): DogView {
  const draft = parseDraft({
    name,
    interestCategories: null,
    tendencies: [0, 0, 0, 0, 0, 0],
  })
  const result = db
    .prepare('UPDATE dog SET name = ? WHERE id = ? AND owner_id = ?')
    .run(draft.name, id, ownerId)
  if (!result.changes) throw new AdoptionError('NOT_FOUND', '这只伙伴不在这里')
  return ownedDog(db, ownerId, id)!
}

// Kept as a type boundary for the future real provider; no client-authored owner/token is accepted.
export type DevelopmentCreateInput = CreateDogInput
