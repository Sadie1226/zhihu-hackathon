// 目标位置：app/(b)/b4-chat-fixture.ts
// b3/b4 口径：POST /api/chat 形状未定，先用夹具跑通交互；接口定了只换这里的发送函数。
// 这里不是接口契约，不要把它当 /api/chat 的说明发出去。

const LINES = [
  '嗯，我在这边。',
  '慢慢说，我听着。',
  '窗外的光刚好。',
  '你说吧，我不走。',
] as const

/** 夹具回复：只在本机产生，不写库、不进快照、不生成任务。 */
export async function sendChatFixture(text: string): Promise<string> {
  await new Promise<void>((resolve) => setTimeout(resolve, 320))
  let hash = 0
  for (const char of text) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  }
  return LINES[hash % LINES.length]
}
