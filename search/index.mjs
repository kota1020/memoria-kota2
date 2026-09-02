// 意味索引の構築（mem0/Memory Bank方式のローカル版）
// 対象: 翻訳済みタスク（index+open） + knowledge/LEARNED.md のclaim
//       + knowledge/all.jsonl の明示メモ/判断記録
// 出力: search/index.json {items:[{kind,text,ref,vec}]}（gitignore対象）
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(dir, '..')
const read = (p) => { try { return readFileSync(path.join(root, p), 'utf8') } catch { return '' } }

export function collectItems() {
  const items = []
  for (const l of read('tasks/tasks-index.jsonl').trim().split('\n')) {
    if (!l) continue
    try { const t = JSON.parse(l); items.push({ kind: 'task', text: `${t.name} ${t.goal ?? ''}`, ref: { name: t.name, status: t.status, spans: t.spans } }) } catch {}
  }
  try { for (const t of JSON.parse(read('state/open-tasks.json')).open_tasks ?? []) items.push({ kind: 'open', text: `${t.name} ${t.goal ?? ''}`, ref: { name: t.name, status: t.status, last_active: t.last_active } }) } catch {}
  for (const l of read('knowledge/LEARNED.md').split('\n')) {
    const m = l.match(/^- \[(事実|決定|好み|手法|失敗)\] (.+)/)
    if (m) items.push({ kind: 'claim', text: m[2].slice(0, 300), ref: { type: m[1] } })
  }
  // 同じ judgment id は open → closed の順で複数行になる。最後の状態だけを採る。
  const durable = new Map()
  for (const l of read('knowledge/all.jsonl').trim().split('\n')) {
    if (!l) continue
    try {
      const row = JSON.parse(l)
      const durableType = String(row.type || '')
      if (!durableType.startsWith('explicit-') && !durableType.startsWith('judgment')) continue
      const meta = typeof row.meta === 'string' ? JSON.parse(row.meta) : (row.meta ?? {})
      const key = meta.id || `${row.ts ?? ''}:${row.title ?? ''}:${durable.size}`
      durable.set(key, { kind: 'memory', text: `${row.title ?? ''} ${row.text ?? ''}`.trim().slice(0, 4000), ref: { id: meta.id, type: row.type, source: row.source, ts: row.ts } })
    } catch {}
  }
  items.push(...durable.values())
  return items
}

export function embed(texts) {
  // Apple NLContextualEmbedding（ローカル）。失敗時はnull＝呼び出し側がTF-IDFへ
  try {
    const out = execFileSync(path.join(dir, 'bin/embed'), { input: texts.map(t => t.replace(/\n/g, ' ')).join('\n'), maxBuffer: 64e6, timeout: 120e3 })
    const v = JSON.parse(out)
    return v.length === texts.length ? v : null
  } catch { return null }
}

// フォールバック: 文字バイグラムTF-IDF（依存ゼロ・日本語に有効）
export function bigrams(s) { const g = {}; const t = s.toLowerCase(); for (let i = 0; i < t.length - 1; i++) { const b = t.slice(i, i + 2); if (/\s/.test(b)) continue; g[b] = (g[b] || 0) + 1 } return g }
export function cosBigram(a, b) { let dot = 0, na = 0, nb = 0; for (const k in a) { na += a[k] ** 2; if (b[k]) dot += a[k] * b[k] } for (const k in b) nb += b[k] ** 2; return dot / (Math.sqrt(na * nb) || 1) }
export const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2 } return d / (Math.sqrt(na * nb) || 1) }

export function buildIndex() {
  const items = collectItems()
  const vecs = embed(items.map(i => i.text))
  const index = { built: new Date().toISOString(), engine: vecs ? 'apple-nl' : 'bigram', items: items.map((it, i) => ({ ...it, vec: vecs ? vecs[i] : null })) }
  const indexPath = path.join(dir, 'index.json')
  const tmp = `${indexPath}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(index), { mode: 0o600 })
  renameSync(tmp, indexPath)
  return index
}

export function loadIndex() {
  const p = path.join(dir, 'index.json')
  if (!existsSync(p)) return buildIndex()
  return JSON.parse(readFileSync(p, 'utf8'))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ix = buildIndex()
  console.log(`indexed ${ix.items.length} items (engine=${ix.engine})`)
}
