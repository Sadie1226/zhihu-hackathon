import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runA6FixtureReview } from '../../tests/helpers/a6-review.mjs'

const report = await runA6FixtureReview()
const destination = resolve('.local/a6')
mkdirSync(destination, { recursive: true })
writeFileSync(resolve(destination, 'review.json'), `${JSON.stringify(report, null, 2)}\n`)
const rows = report.results.map(entry => `| ${entry.tags.join('／')} | ${entry.find.title} | ${entry.reasons.map(r => r.cues.join('、')).join('；')} | ${entry.message.text} |`)
const markdown = [
  '# A6 两狗结果对照（实际运行的示例数据）', '',
  '同一心愿“想看看秋天”，相同兴趣、同一批候选，只改变看物／看人标签。', '',
  '**全程fixture：候选和归来话是人工测试输入，未联网搜索、未调用模型，不能作为真实生成验收。**', '',
  '| 性格 | 实际选中并保存的内容 | 选择依据 | 手工输入B存储的归来话 |',
  '|---|---|---|---|', ...rows, '',
  '已走通现有Find写入、C4结束、B Message引用，关闭并重开数据库后由现有GET处理器读回；两主人隔离、外部Find引用拒绝、重复Find写入一份、伪造live/proof拒绝均通过。', '',
  '这是进程内处理器验证，尚未接自动C6入口、真实搜索/生成、邀请或浏览器。临时库已清理；完整ID、输入和检查见review.json。', '',
  '复跑：`node scripts/a5/a6-review.mjs`。', '',
].join('\n')
writeFileSync(resolve(destination, 'review.md'), markdown)
console.log(markdown)
