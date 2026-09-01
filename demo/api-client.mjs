// read APIのクライアント例 — 外部アプリ/エージェントが memoria の理解を読む最小コード。
// 先に server.mjs（またはinstall.shの常駐）が動いていること。
//   node demo/api-client.mjs
const BASE = process.env.MEMORIA_API || 'http://127.0.0.1:4319'
const TOKEN = process.env.MEMORIA2_API_TOKEN || ''
const headers = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}

async function get(path) {
  const r = await fetch(BASE + path, { headers })
  if (!r.ok) throw new Error(`${path} → ${r.status}`)
  return r.json()
}

// 例: 会話を始める前に「ユーザーが今なにをしているか」を1回叩いて文脈を得る
const ctx = await get('/context?disclosure=context')
console.log('いまのタスク:')
for (const t of ctx.tasks) console.log(`  - [${t.status}] ${t.name}`)

// 例: 過去を意味検索して関連作業を引く（言い換えでも当たる）
const q = encodeURIComponent('先週やっていたリサーチ')
const hits = await get(`/recall?q=${q}&limit=3`)
console.log(`\n「先週やっていたリサーチ」に近い記憶:`)
for (const h of hits.hits) console.log(`  ${h.score} [${h.tag}] ${h.text}`)
