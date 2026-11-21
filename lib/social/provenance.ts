/**
 * provenance.ts —— K v4 的「交换来源」核查（d，2026-11-20）
 *
 * 为什么单独一个文件而不是塞进 rules.ts 或复制到两个文件：
 *
 *   1. **rules.ts 是纯函数**，不碰 store。来源核查必须查库（归属在 `trip` 上，
 *      档位在 `find.source_mode` 上），放进去就得给 validate 传 store，破坏它「纯」的性质。
 *   2. **gift 和 meet 都会写 find/gift payload**。两份实现必然漂移 ——
 *      11-19 的教训：`meet.ts` 的幂等漏洞和 `recordExchange` 的重放漏洞是同一个坑，
 *      当时因为写在两个函数里，改了一处差点漏掉另一处。
 *
 * 所以：核查逻辑一份，两个写入路径都调它，各自把 `ok:false` 转成自己的错误类型
 * （gift 抛 `GiftError`，meet 抛 `SocialWriteError`）。
 *
 * 契约出处（`contracts/api.md`「K v4：交换来源」）：
 *   「可信写入方在其事务中先验证当前 session 对 fromDog 的写入权，再用以下查询解析
 *     sourceFindId…… sourceMode 必须从查询结果取，客户端/模型不得自行指定。」
 *   「只读允许交换的内容摘要和来源元数据。」
 */

import type { RuleCode } from './rules.ts'
import type { SocialStore, SourceMode } from './store.ts'

export type ProvenanceOk = {
  ok: true
  /** 落进 payload 的值。没有来源时两者都是 null。 */
  sourceFindId: string | null
  sourceMode: SourceMode | null
}

export type ProvenanceFail = {
  ok: false
  code: RuleCode
  reason: string
  path: string
}

export type ProvenanceResult = ProvenanceOk | ProvenanceFail

/**
 * 把调用方的来源声明，换成库证明过的来源。
 *
 * @param store   只用来查 `find ⋈ trip`，不写任何状态
 * @param fromDog 寄件狗。来源的归属必须等于它
 * @param sourceFindId 调用方声明的 find.id。`undefined` / `null` 都表示「无来源」
 * @param claimedMode  调用方声称的档位。**只用于一致性核对，永不直接落库**
 *
 * `claimedMode` 的三态（c 11-20 晚定的边界）：
 *   `undefined` = 未声明 → 由库派生（推荐，调用方不需要知道档位）
 *   `null`      = 明确声明「没有档位」→ 库里必须也是 null，否则拒
 *   `'live'` 等 = 明确声明档位 → 必须与库里相等，否则拒
 *   三者都不许「不一致但放行」。
 *
 * 四条判定，顺序有意义（先便宜的后查库）：
 *   1. 无来源却声称档位 → 拒（凭空造出处）
 *   2. id 形状不对 → 拒（别拿垃圾去查库）
 *   3. 查不到 → 拒
 *   4. 归属不是寄件狗 → 拒；声称档位与库里不符 → 拒
 */
export function resolveProvenance(
  store: SocialStore,
  fromDog: string,
  sourceFindId: string | null | undefined,
  claimedMode: SourceMode | null | undefined,
): ProvenanceResult {
  if (sourceFindId === undefined || sourceFindId === null) {
    if (claimedMode !== undefined && claimedMode !== null) {
      return {
        ok: false,
        code: 'PROVENANCE_MISMATCH',
        path: '/payload/sourceMode',
        reason: `没有 sourceFindId 却声明 sourceMode=${claimedMode} —— 档位只能由真实发现提供`,
      }
    }
    return { ok: true, sourceFindId: null, sourceMode: null }
  }

  if (typeof sourceFindId !== 'string' || sourceFindId.trim() === '') {
    return {
      ok: false,
      code: 'WRONG_TYPE',
      path: '/payload/sourceFindId',
      reason: 'sourceFindId 必须是非空字符串或 null，没有来源请写 null',
    }
  }

  const src = store.getFindSource(sourceFindId)
  if (!src) {
    return {
      ok: false,
      code: 'PROVENANCE_MISMATCH',
      path: '/payload/sourceFindId',
      reason: `来源 Find 不存在：${sourceFindId} —— 出处必须是真实发生过的发现`,
    }
  }
  if (src.dogId !== fromDog) {
    // 「借别人的发现当自己的出处」：不是自己的经历，不算经历（不变量四）。
    return {
      ok: false,
      code: 'PROVENANCE_MISMATCH',
      path: '/payload/sourceFindId',
      reason: `来源 Find ${sourceFindId} 属于 ${src.dogId}，不是寄件狗 ${fromDog}`,
    }
  }
  // 11-20 晚，c 的边界：**只有 `undefined` 算「未声明」**，`null` 是明确声明。
  // 原来这里 `null` 被当成「没说」放行了 —— 传 `sourceMode: null` 配一条 live 的 find
  // 会静默成功，等于调用方可以靠「说不清」绕过档位核对。现在 null 也要对得上。
  if (claimedMode !== undefined && claimedMode !== src.sourceMode) {
    // 拒而不是「以库为准、静默改掉」：静默纠正会让调用方以为自己传的值生效了。
    return {
      ok: false,
      code: 'PROVENANCE_MISMATCH',
      path: '/payload/sourceMode',
      reason:
        `sourceMode 与库里不一致：传入 ${claimedMode === null ? 'null（明确声明无档位）' : claimedMode}，` +
        `实际 ${src.sourceMode === null ? 'null（scene/moment 没有档位）' : src.sourceMode}`,
    }
  }

  return { ok: true, sourceFindId: src.id, sourceMode: src.sourceMode }
}

// ===========================================================================
// 读侧：已经落库的 payload，怎么取出它的来源
// ===========================================================================

/**
 * 一条**已落库** payload 的来源。
 *
 * 为什么不复用 `rules.validate`：validate 是写入闸门，要求两个来源键**必须在**。
 * 历史行（K v4 之前写的）根本没有这两个键，拿写入闸门去卡历史数据，会把所有旧记录
 * 判成不合规 —— a 的请求里「历史缺键只做读取兼容」说的就是这件事。
 *
 * 为什么把 `legacy` 单独标出来：`{null, null}` 有两种含义 ——
 *   - 新记录，确实没有来源（gift 在路边捡的东西送给朋友）
 *   - 旧记录，当时还没有来源这个概念
 * 混成一种，以后做数据回填或统计「有多少礼物有出处」时，会把旧数据算成「明确无出处」。
 */
export type StoredProvenance = {
  sourceFindId: string | null
  sourceMode: SourceMode | null
  /** true = 至少缺一个来源键，即写下时还没有 K v4 契约。读取照常，不要回写成 null。 */
  legacy: boolean
}

const MODES: readonly SourceMode[] = ['live', 'cache', 'fixture']

export function readProvenance(payload: unknown): StoredProvenance {
  const p =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}

  const hasId = Object.hasOwn(p, 'sourceFindId')
  const hasMode = Object.hasOwn(p, 'sourceMode')

  // 只缺一个也算历史行：半个来源不是一个可用的出处，按「没有」对待更安全。
  const legacy = !hasId || !hasMode

  const rawId = p.sourceFindId
  const sourceFindId = typeof rawId === 'string' && rawId.trim() !== '' ? rawId : null

  const rawMode = p.sourceMode
  const sourceMode = MODES.includes(rawMode as SourceMode) ? (rawMode as SourceMode) : null

  return { sourceFindId, sourceMode, legacy }
}
