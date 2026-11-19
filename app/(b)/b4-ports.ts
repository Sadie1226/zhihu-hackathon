// 目标位置：app/(b)/b4-ports.ts
// 与 A 分支 a5-a5b-react-1119@4138f8c 的 components/app-shell/ports.ts 结构一致。
// A 的分支未合 main，B 在本文件放同形类型，避免让 main 的 typecheck 依赖未合分支；
// A 接 wiring 后可直接把自己的 PanelContext / Invitations props 传进来，组件签名不变。
export type PanelContext = {
  dogId: string
  reducedMotion: boolean
  onClose: () => void
  onCommitted: () => void
}

export type InvitationPanelProps = {
  dogId: string
  tripId: string
  origin: 'trip'
  returnTo: string
}
