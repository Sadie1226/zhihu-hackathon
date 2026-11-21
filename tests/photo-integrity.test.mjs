import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectPhoto, validatePhotoIntegrity } from '../app/(b)/b6-photo.ts'

// Chrome canvas.toDataURL('image/webp', .8), 20 x 20 solid fixture; no user image.
const encoded = 'UklGRiQCAABXRUJQVlA4WAoAAAAgAAAAEwAAEwAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggNgAAAPACAJ0BKhQAFAA+bTKVR6QioiEoCACADYllAABN7FAAAP5vH+9y0Uiv//mCf+/3/f7yXAAAAA=='
const image = () => Buffer.from(encoded, 'base64')

test('real browser WebP accepts little-endian RIFF and frame lengths, including a sliced buffer', () => {
  const bytes = image()
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8)
  assert.deepEqual(inspectPhoto(bytes), { mime: 'image/webp', width: 20, height: 20 })
  assert.equal(validatePhotoIntegrity(bytes, 'image/webp'), true)
  const container = Buffer.concat([Buffer.alloc(7), bytes, Buffer.alloc(3)])
  assert.equal(validatePhotoIntegrity(container.subarray(7, 7 + bytes.length), 'image/webp'), true)
})

test('WebP rejects truncated files, trailing bytes and a mismatched RIFF size', () => {
  const bytes = image()
  for (const candidate of [bytes.subarray(0, 24), bytes.subarray(0, -1), Buffer.concat([bytes, Buffer.from([0])])])
    assert.equal(validatePhotoIntegrity(candidate, 'image/webp'), false)
  const changed = image()
  changed.writeUInt32BE(changed.length - 8, 4)
  assert.equal(validatePhotoIntegrity(changed, 'image/webp'), false)
})

test('WebP checks later chunk bounds and requires encoded image data after VP8X metadata', () => {
  const bytes = image()
  let offset = 12
  while (bytes.toString('ascii', offset, offset + 4) !== 'VP8 ') offset += 8 + bytes.readUInt32LE(offset + 4) + (bytes.readUInt32LE(offset + 4) % 2)
  const oversized = image()
  oversized.writeUInt32LE(0x7fffffff, offset + 4)
  assert.equal(validatePhotoIntegrity(oversized, 'image/webp'), false)
  const headerOnly = Buffer.from(bytes.subarray(0, 30))
  headerOnly.writeUInt32LE(headerOnly.length - 8, 4)
  assert.equal(validatePhotoIntegrity(headerOnly, 'image/webp'), false)
  const badFrame = image()
  badFrame[offset + 11] = 0
  assert.equal(validatePhotoIntegrity(badFrame, 'image/webp'), false)
})
