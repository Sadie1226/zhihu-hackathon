import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyPhotoName, canReadByCapability, PHOTO_NAME_RE, PHOTO_READ_CACHE_CONTROL,
} from '../app/(b)/b4-photo-visibility.ts'

const OWNER = 'a'.repeat(64)
const NONCE = 'b'.repeat(16)

test('capability 文件名被分类为可读，并解出完整 64 位 owner / 16 位 nonce', () => {
  const d = classifyPhotoName(`s_${OWNER}_${NONCE}.webp`)
  assert.deepEqual(d, { ok: true, owner: OWNER, nonce: NONCE, ext: 'webp' })
  assert.equal(canReadByCapability(d), true)
})

test('三种白名单扩展名都可读', () => {
  for (const ext of ['jpg', 'png', 'webp']) {
    const d = classifyPhotoName(`s_${OWNER}_${NONCE}.${ext}`)
    assert.equal(d.ok, true)
    assert.equal(canReadByCapability(d), true)
  }
})

test('合法收件人与上传者一视同仁：可见性只看链接形状，不看请求者身份', () => {
  // 依据 1121-a-给B与C:13「不能只限上传本人而使合法收件人看不到图」。
  // 同一个 capability 链接，不传入任何身份也能判定为可读 —— 契约层不设「仅上传本人」门槛。
  const d = classifyPhotoName(`s_${OWNER}_${NONCE}.jpg`)
  assert.equal(canReadByCapability(d), true)
  assert.equal(canReadByCapability(classifyPhotoName(`s_${'c'.repeat(64)}_${NONCE}.jpg`)), true)
})

test('路径穿越与任意路径读取被拒（traversal）', () => {
  for (const bad of [
    `../s_${OWNER}_${NONCE}.jpg`,
    `s_${OWNER}_${NONCE}.jpg/../../secret`,
    `..\\s_${OWNER}_${NONCE}.jpg`,
    `subdir/s_${OWNER}_${NONCE}.jpg`,
  ]) {
    const d = classifyPhotoName(bad)
    assert.equal(d.ok, false)
    assert.equal(canReadByCapability(d), false)
  }
})

test('形状不符 / 非字符串 / 短 owner / 非白名单扩展名被拒（shape）', () => {
  const bad = [
    undefined, null, 42, '',
    `s_${'a'.repeat(8)}_${NONCE}.jpg`,      // 旧 8 位前缀不再接受
    `s_${OWNER}_${NONCE}.gif`,               // 非白名单扩展名
    `s_${OWNER}_b${'b'.repeat(14)}.jpg`,     // nonce 不足 16 位
    `x_${OWNER}_${NONCE}.jpg`,               // 错误前缀
  ]
  for (const name of bad) {
    const d = classifyPhotoName(name)
    assert.equal(d.ok, false, `should reject: ${String(name)}`)
    if (!d.ok) assert.equal(d.reason, 'shape')
    assert.equal(canReadByCapability(d), false)
  }
})

test('缓存边界保持 private，B 不单方放宽为 public 或加长', () => {
  assert.match(PHOTO_READ_CACHE_CONTROL, /^private/)
  assert.doesNotMatch(PHOTO_READ_CACHE_CONTROL, /public/)
})

test('读取正则与写入端 makePhotoUrl / 回应端口径一致：同一 URL 写入即能读出分类', () => {
  // 与 b6-photo.ts 的 PHOTO_URL_RE 形状保持一致（去 /uploads/ 前缀后）
  const url = `/uploads/s_${OWNER}_${NONCE}.png`
  assert.equal(PHOTO_NAME_RE.test(url.slice('/uploads/'.length)), true)
  assert.equal(classifyPhotoName(url.slice('/uploads/'.length)).ok, true)
})
