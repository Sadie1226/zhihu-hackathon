import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { createZhihuSearchClient } from '../../lib/zhihu/client.ts'
import { reviewSemantics } from '../../lib/adoption/a6-semantics.ts'
import { selectForPersonality } from '../../lib/adoption/a6-selection.ts'

// Opt-in standalone verification only. No .env or credentials are copied into reports.
if (process.env.A6_ENV_FILE) loadEnvFile(process.env.A6_ENV_FILE)
const root = resolve('.local/a6-semantics')
mkdirSync(root, { recursive: true })
const save = (name, value) => writeFileSync(resolve(root, name), JSON.stringify(value, null, 2) + '\n')
let groups
if (process.env.A6_SAMPLES_FILE) groups = JSON.parse(readFileSync(process.env.A6_SAMPLES_FILE, 'utf8'))
else {
  const search = createZhihuSearchClient({ accessSecret: process.env.ZHIHU_ACCESS_SECRET, timeoutMs: 20000 })
  groups = []
  const queries = process.env.A6_QUERIES ? JSON.parse(process.env.A6_QUERIES) : ['陶瓷 烧制 原理 匠人 采访', '蜜蜂 分工 蜂农 养蜂 经历']
  if (!Array.isArray(queries) || queries.length > 4 || queries.some(q => typeof q !== 'string' || !q.trim())) throw new Error('Invalid review queries')
  for (const query of queries) {
    const result = await search(query, 6)
    if (!result.ok) throw new Error(`Search failed: ${result.error.code}`)
    groups.push({ query, fetchedAt: result.fetchedAt, items: result.items.map(item => ({
      id: item.sourceUrl, title: item.title, excerpt: item.excerpt,
    })) })
    save('new-samples.json', groups)
    console.log(JSON.stringify({ phase: 'search', query, count: result.items.length }))
    await new Promise(done => setTimeout(done, 1100))
  }
}
if (!process.env.A6_MODEL_BASE_URL || !process.env.A6_MODEL_API_KEY || !process.env.A6_MODEL) {
  throw new Error('Set A6_MODEL_BASE_URL, A6_MODEL_API_KEY and A6_MODEL explicitly')
}
const results = []
let calls = 0
for (const group of groups) {
  const items = group.items.filter((x, i, all) => all.findIndex(y => y.id === x.id) === i)
  const reviews = []
  for (const candidate of items) {
    let returned = null, failure = null, usage = null
    const review = await reviewSemantics([candidate], async ({ instruction, candidates }) => {
      try {
        calls++
        const response = await fetch(process.env.A6_MODEL_BASE_URL.replace(/\/?$/, '/') + 'chat/completions', {
          method: 'POST', headers: { Authorization: `Bearer ${process.env.A6_MODEL_API_KEY}`, 'Content-Type': 'application/json' },
          signal: globalThis.AbortSignal.timeout(25000), body: JSON.stringify({ model: process.env.A6_MODEL,
            temperature: 0, max_tokens: 1000, thinking: { type: 'disabled' }, response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: instruction }, { role: 'user',
              content: JSON.stringify({ candidates: candidates.map(c => ({ ...c, excerpt: c.excerpt?.slice(0, 1400) ?? null })) }) }] }),
        })
        if (!response.ok) throw new Error(`HTTP_${response.status}`)
        const body = await response.json()
        usage = body.usage
        const content = body.choices?.[0]?.message?.content
        if (typeof content !== 'string') throw new Error('EMPTY_OUTPUT')
        returned = JSON.parse(content.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, ''))
        return returned
      } catch (error) { failure = error.name === 'TimeoutError' ? 'TIMEOUT' : 'INVALID_MODEL_OUTPUT'; return null }
    })
    reviews.push({ candidate, review: review.decisions[0], returned, failure, usage })
    // A fresh capability remains bound to the same full input; no client labels or source-mode override.
    console.log(JSON.stringify({ phase: 'review', title: candidate.title, ...review.decisions[0] }))
    save('progress.json', { results, current: reviews, model: process.env.A6_MODEL, calls })
  }
  // Revalidate saved structured output through the same API; never deserialize a capability.
  const merged = await reviewSemantics(items, async () => ({ items: reviews.map((entry, index) => {
    const d = entry.review
    return { index, focus: d.focus, time: d.time, nature: d.nature,
      focusQuote: d.focusQuote, timeQuote: d.timeQuote, natureQuote: d.natureQuote }
  }) }))
  const comparisons = ['看物', '看人'].map(tag => ({ tag, selection: selectForPersonality(items,
    { dogId: 'simulated-semantic-review', tags: ['好奇', tag, '直给'], blockedTopics: [], semanticReview: merged }) }))
  results.push({ query: group.query, fetchedAt: group.fetchedAt, reviews, comparisons })
  save('results.json', { mode: 'cached-real-search-review', model: process.env.A6_MODEL, calls, results })
}
console.log(JSON.stringify({ phase: 'done', groups: results.length, calls }))
