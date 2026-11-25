// B7 面板状态守卫：把两条易错规则做成纯函数，供组件与测试共用。
//  1) PATCH 是整列覆盖：读取没成功时用空 topics 写入会把服务端已存的旧词清掉。
//     因此只有读取成功（phase='ready'）且面板可见时才允许写。
//  2) 面板取消会打断在途读/写；被打断的请求结果不再回填，phase 必须复位到稳定态，
//     否则重开后 add/remove 被 saving/loading 永久禁用。
export type PreferencesPhase = 'loading' | 'ready' | 'saving' | 'error'

/** 只有读取成功且面板可见才允许整列写入；读失败/在读/在存一律拒绝。 */
export function canWriteTopics(phase: PreferencesPhase, active: boolean): boolean {
  return active && phase === 'ready'
}

/** 面板取消：在途读/写被打断，复位到稳定态；错误态保留提示，重开时统一重读。 */
export function phaseAfterDeactivate(phase: PreferencesPhase): PreferencesPhase {
  return phase === 'loading' || phase === 'saving' ? 'ready' : phase
}
