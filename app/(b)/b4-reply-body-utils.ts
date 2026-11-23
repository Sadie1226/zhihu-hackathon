// 可复用回应正文的纯逻辑：target 二选一映射与错误文案。
// 单独成文件以便 node:test 直接覆盖；组件与测试共用同一份，不产生两套口径。
import type { ReplyBodyProps } from './b4-ports'

/** 由 target 决定唯一业务来源字段；不传多余字段，后端要求恰好一个。 */
export function targetField(target: ReplyBodyProps['target']): { invitationId?: string; exchangeId?: string } {
  return target.invitationId
    ? { invitationId: target.invitationId }
    : { exchangeId: target.exchangeId }
}

/** 实例的 key：带来源前缀，避免 invitation/exchange 同 id 时误判为同一目标。 */
export function targetKey(target: ReplyBodyProps['target']): string {
  return target.invitationId ? `i:${target.invitationId}` : `e:${target.exchangeId}`
}

export function readableUploadError(status: number): string {
  if (status === 413) return '图没传上去：图片太大或边长超过 1600，换张小一点的。'
  if (status === 415) return '图没传上去：这张图打不开或不是支持的格式。'
  if (status === 401 || status === 403) return '图没传上去：会话失效了，请返回后重试。'
  return '图没传上去：这次没连上，可以再试一次。'
}

export function readableReplyError(status: number): string {
  if (status === 401 || status === 403 || status === 404) return '回应没成功：这条内容不在当前会话里了。'
  if (status === 409) return '这条内容还没到可以回应的时候，稍后再试。'
  return '这次没回应成功，文字和图都还在，可以再试一次。'
}
