import { countChars } from './types.ts'
import type { ChatRequest } from './types.ts'

export const CHAT_BODY_MAX_BYTES = 16 * 1024
export const CHAT_TEXT_MAX_CHARS = 200
const rawTextMaxUnits = 2048
const idMaxUnits = 128

export function parseChatRequest(value: unknown): ChatRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 3 || !['dogId', 'text', 'clientMessageId'].every(key => keys.includes(key))) return null

  const { dogId, text, clientMessageId } = value as Record<string, unknown>
  if (typeof dogId !== 'string' || dogId.length < 1 || dogId.length > idMaxUnits ||
      dogId !== dogId.trim() || !dogId.isWellFormed() || /\p{Cc}/u.test(dogId)) return null
  if (typeof clientMessageId !== 'string' || clientMessageId.length > idMaxUnits ||
      !/^[A-Za-z0-9]/.test(clientMessageId) || /[^A-Za-z0-9_-]/.test(clientMessageId)) return null
  if (typeof text !== 'string' || text.length > rawTextMaxUnits || !text.isWellFormed() ||
      /[^\P{Cc}\t\n\r]/u.test(text)) return null

  const normalized = text.trim()
  const length = countChars(normalized)
  if (length < 1 || length > CHAT_TEXT_MAX_CHARS) return null
  return { dogId, text: normalized, clientMessageId }
}
