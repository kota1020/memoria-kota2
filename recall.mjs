// 引き出し（意味検索版）— Apple埋め込みで「言い方が違っても意味で当たる」
// 使い方: node recall.mjs <質問や語> | node recall.mjs --at "2026-08-28 16:30" | node recall.mjs --rebuild
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { loadIndex, buildIndex, embed, cos, bigrams, cosBigram } from './search/index.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)

if (args[0] === '--rebuild') { const ix = buildIndex(); console.log(`indexed ${ix.items.length} (engine=${ix.engine})`); process.exit(0) }

if (args[0] === '--at' && args[1]) {
  const at = Date.parse(args[1].replace(' ', 'T') + '+09:00')
  const lines = readFileSync(path.join(dir, 'tasks/tasks-index.jsonl'), 'utf8').trim().split('\n')
  for (const l of lines) {
    try { const t = JSON.parse(l); if ((t.spans ?? []).some(([s, e]) => Date.parse(s) <= at && at <= Date.parse(e))) console.log(`[${t.status}] ${t.name}`) } catch {}
  }
  process.exit(0)
}

const q = args.join(' ')
if (!q) { console.error('usage: recall.mjs <query> | --at "JST" | --rebuild'); process.exit(1) }
const ix = loadIndex()
const qv = embed([q])?.[0]
const qb = bigrams(q)
const scored = ix.items.map(it => {
  const sem = (qv && it.vec && it.vec.length) ? cos(qv, it.vec) : cosBigram(qb, bigrams(it.text))
  const lex = it.text.toLowerCase().includes(q.toLowerCase()) ? 0.15 : 0  // 完全一致ボーナス
  const kindBoost = it.kind === 'open' ? 0.06 : it.kind === 'task' ? 0.04 : 0  // 実行中/実タスクを優先
  return { it, score: sem + lex + kindBoost }
}).sort((a, b) => b.score - a.score).slice(0, 8)
for (const { it, score } of scored) {
  const tag = it.kind === 'open' ? 'open' : it.kind === 'task' ? it.ref.status : `claim:${it.ref.type}`
  console.log(`${score.toFixed(3)} [${tag}] ${it.text.slice(0, 110)}`)
}
