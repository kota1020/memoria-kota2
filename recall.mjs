// 引き出し（意味検索版）— Apple埋め込みで「言い方が違っても意味で当たる」
// CLIとしても、read API(server.mjs)からライブラリとしても使える。
// 使い方: node recall.mjs <質問や語> | node recall.mjs --at "2026-08-28 16:30" | node recall.mjs --rebuild
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { loadIndex, buildIndex, embed, cos, bigrams, cosBigram } from './search/index.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))

// 意味検索本体（サービスからも呼べる純関数）。返り値は {score, kind, tag, text, ref}[]
export function recall(query, limit = 8) {
  const q = String(query || '').trim()
  if (!q) return []
  const ix = loadIndex()
  const qv = embed([q])?.[0]
  const qb = bigrams(q)
  return ix.items.map(it => {
    const sem = (qv && it.vec && it.vec.length) ? cos(qv, it.vec) : cosBigram(qb, bigrams(it.text))
    const lex = it.text.toLowerCase().includes(q.toLowerCase()) ? 0.15 : 0  // 完全一致ボーナス
    const kindBoost = it.kind === 'open' ? 0.06 : it.kind === 'task' ? 0.04 : 0  // 実行中/実タスクを優先
    return { it, score: sem + lex + kindBoost }
  }).sort((a, b) => b.score - a.score).slice(0, limit).map(({ it, score }) => ({
    score,
    kind: it.kind,
    tag: it.kind === 'open' ? 'open' : it.kind === 'task' ? it.ref.status : `claim:${it.ref.type}`,
    text: it.text,
    ref: it.ref,
  }))
}

// 時間の巻き戻し: 指定JST日の「何に時間を使ったか」をタスク別合計で返す（#4）
// spansの各区間がその日に重なった分だけ加算。返りは [{name, mins, status}] 降順。
const MAX_SPAN_MS = Number(process.env.MEMORIA2_MAX_SPAN_H ?? 6) * 3600e3  // これを超える単一spanは「開きっぱなし」とみなし実作業時間に数えない
export function daySummary(jstDate) {
  const dayStart = Date.parse(jstDate + 'T00:00:00+09:00')
  const dayEnd = dayStart + 24 * 3600e3
  const acc = new Map()
  let lines = []
  try { lines = readFileSync(path.join(dir, 'tasks/tasks-index.jsonl'), 'utf8').trim().split('\n') } catch { return [] }
  for (const l of lines) {
    try {
      const t = JSON.parse(l)
      let mins = 0
      for (const [s, e] of t.spans ?? []) {
        if (Date.parse(e) - Date.parse(s) > MAX_SPAN_MS) continue  // 徹夜またぎ等の放置spanは除外
        const a = Math.max(Date.parse(s), dayStart), b = Math.min(Date.parse(e), dayEnd)
        if (b > a) mins += (b - a) / 60000
      }
      if (mins < 1) continue
      const cur = acc.get(t.name) || { name: t.name, mins: 0, status: t.status }
      cur.mins += mins
      acc.set(t.name, cur)
    } catch {}
  }
  return [...acc.values()].map(x => ({ ...x, mins: Math.round(x.mins) })).sort((a, b) => b.mins - a.mins)
}
const fmtMin = (m) => m >= 60 ? `${Math.floor(m / 60)}時間${m % 60}分` : `${m}分`

// 指定JST時刻に走っていたタスク（サービスからも呼べる純関数）
export function tasksAt(atMs) {
  const out = []
  let lines = []
  try { lines = readFileSync(path.join(dir, 'tasks/tasks-index.jsonl'), 'utf8').trim().split('\n') } catch { return out }
  for (const l of lines) {
    try {
      const t = JSON.parse(l)
      if ((t.spans ?? []).some(([s, e]) => Date.parse(s) <= atMs && atMs <= Date.parse(e))) out.push(t)
    } catch {}
  }
  return out
}

// --- 以下CLI（import時は実行しない） ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  if (args[0] === '--rebuild') { const ix = buildIndex(); console.log(`indexed ${ix.items.length} (engine=${ix.engine})`); process.exit(0) }
  if (args[0] === '--at' && args[1]) {
    const at = Date.parse(args[1].replace(' ', 'T') + '+09:00')
    for (const t of tasksAt(at)) console.log(`[${t.status}] ${t.name}`)
    process.exit(0)
  }
  if (args[0] === '--today' || args[0] === '--day') {
    const jst = args[0] === '--day' && args[1] ? args[1] : new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
    const rows = daySummary(jst)
    if (!rows.length) { console.log(`${jst}: 記録なし`); process.exit(0) }
    const total = rows.reduce((s, r) => s + r.mins, 0)
    console.log(`${jst} — 何に時間を使ったか（合計 ${fmtMin(total)}）`)
    for (const r of rows) console.log(`  ${fmtMin(r.mins).padStart(9)}  [${r.status}] ${r.name.slice(0, 64)}`)
    process.exit(0)
  }
  const q = args.join(' ')
  if (!q) { console.error('usage: recall.mjs <query> | --at "JST" | --rebuild'); process.exit(1) }
  for (const r of recall(q)) console.log(`${r.score.toFixed(3)} [${r.tag}] ${r.text.slice(0, 110)}`)
}
