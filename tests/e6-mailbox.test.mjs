import test from 'node:test'
import assert from 'node:assert/strict'
import { letterState, canOpen, letterTitle, safeSource } from '../components/e6/mailbox-model.ts'
import { mailboxClient } from '../components/e6/mailbox-client.ts'
const pending = {id:'e1',fromDog:'peer',toDog:'mine',kind:'find',payload:{kind:'find',findTitle:'PRIVATE_TITLE',findExcerpt:'PRIVATE_BODY',sourceUrl:null},deliveredAt:null,repliedAt:null,readAt:null}
test('undelivered incoming content stays sealed, including inconsistent timestamps', () => {
 for (const item of [pending,{...pending,readAt:'past',repliedAt:'past'}]) {
  assert.equal(letterState(item),'在路上')
  assert.equal(canOpen(item,'mine'),false)
  assert(!letterTitle(item,'mine').includes('PRIVATE'))
 }
})
test('only recipient can open delivered mail; read is distinct from replied', () => {
 const arrived={...pending,deliveredAt:'today'}
 assert.equal(canOpen(arrived,'mine'),true)
 assert.equal(canOpen(arrived,'peer'),false)
 assert.equal(letterState(arrived),'新到')
 assert.equal(letterState({...arrived,readAt:'today'}),'安静地留着')
 assert.equal(letterState({...arrived,repliedAt:'today'}),'已回应')
})
test('outgoing author may see own words while delivery remains pending', () => {
 assert.equal(letterTitle({...pending,fromDog:'mine',toDog:'peer'},'mine'),'PRIVATE_TITLE')
 assert.equal(letterState(pending),'在路上')
})
test('source links reject active protocols, malformed links, and embedded credentials', () => {
 for (const value of ['javascript:alert(1)','data:text/html,secret','file:///etc/passwd','/relative','https://me:secret@example.com',null]) assert.equal(safeSource(value),undefined)
 assert.equal(safeSource('https://www.zhihu.com/question/123'),'https://www.zhihu.com/question/123')
})
test('mailbox reads use authenticated no-store requests; failed reads never become empty arrays', async () => {
 const original=globalThis.fetch
 const calls=[]
 try {
  globalThis.fetch=async (url,options)=>{calls.push({url,options});return Response.json({exchanges:[]})}
  const signal=new AbortController().signal
  assert.deepEqual(await mailboxClient.inbox('a/b',signal),{exchanges:[]})
  assert.equal(calls[0].url,'/api/dogs/a%2Fb/inbox?filter=all')
  assert.equal(calls[0].options.credentials,'same-origin')
  assert.equal(calls[0].options.cache,'no-store')
  assert.equal(calls[0].options.signal,signal)
  await mailboxClient.read('e/1',signal)
  assert.equal(calls[1].options.method,'PATCH')
  assert.equal(calls[1].options.body,'{}')
  globalThis.fetch=async()=>new Response('',{status:404})
  await assert.rejects(()=>mailboxClient.outbox('mine',signal),/不可访问/)
 } finally {globalThis.fetch=original}
})
