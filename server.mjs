// read API（読）— 外部アプリ/エージェントが memoria の「理解」を問い合わせて読む口。
// Screenpipe型のAPIに相当するが、生フレーム/生OCRは出さない。返すのは翻訳済みの理解
// （タスク・文脈・意味検索）だけ。開示ダイヤルで粒度を絞る＝A2Aの思想に一致。
//
// 起動: node server.mjs            （既定 127.0.0.1:39_snip → 実際は下記PORT）
// 環境変数:
//   MEMORIA2_API_PORT   既定 4319
//   MEMORIA2_API_TOKEN  設定すると Authorization: Bearer <token> 必須（既定は無認証・localhostのみ）
//   MEMORIA2_API_HOST   既定 127.0.0.1（localhost束縛。外部公開は明示的に 0.0.0.0 を指定した時だけ）
//
// エンドポイント（全てGET・JSON）:
//   GET /health                       稼働確認
//   GET /tasks?status=open            いま走行/注視中のタスク（state/open-tasks.json）
//   GET /recall?q=...&limit=8         意味検索（言い換えでも当たる）
//   GET /at?t=2026-09-01T19:16:00     指定時刻に走っていたタスク（JST）
//   GET /context                      今の注入コンテキスト（画面メモ＋タスク）をまとめて
//   GET /facts?type=&q=&limit=        覚えたこと（人・締切・決定・案件。根拠つきで抽出済み）
//   GET /handoff?q=&limit=&ai=        AIへ渡す記憶カード（質問に関係するfacts＋タスク）。拡張の「渡す前の確認」が使う
//   全エンドポイント共通クエリ: ?disclosure=intent|context|full （既定 context）
//
// 開示ダイヤル（disclosure）:
//   intent  … 名前と状態だけ（何をしていたか、の最小）
//   context … +goal/apps/期間（既定）
//   full    … +evidence（根拠断片。URLやタイトルを含みうる＝身内向け）
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { recall, tasksAt, daySummary } from './recall.mjs'
import { loadLive, factsFor, factLine } from './parser/facts.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.MEMORIA2_API_PORT || 4319)
const HOST = process.env.MEMORIA2_API_HOST || '127.0.0.1'
const TOKEN = process.env.MEMORIA2_API_TOKEN || ''

const LEVELS = { intent: 0, context: 1, full: 2 }

// 開示ダイヤルでタスク1件を絞る。level未満のフィールドは落とす。
function shapeTask(t, level) {
  const o = { name: t.name, status: t.status }
  if (level >= 1) {
    o.goal = t.goal
    o.apps = t.apps
    if (t.spans) o.spans = t.spans
    if (t.last_active) o.last_active = t.last_active
    if (t.started) o.started = t.started
  }
  if (level >= 2 && t.evidence) o.evidence = t.evidence
  return o
}

function openTasks() {
  try { return JSON.parse(readFileSync(path.join(dir, 'state/open-tasks.json'), 'utf8')).open_tasks ?? [] }
  catch { return [] }
}

// 画面メモ（現在の生メモ）から、生OCR本文を除いた見出しだけを返す（開示制御）。
function screenSummary(level) {
  if (level < 1) return undefined
  let raw = ''
  try { raw = readFileSync(process.env.MEMORIA_SCREEN_MEMO || path.join(dir, 'kota/current-activity.md'), 'utf8') } catch { return undefined }
  // 「## いま画面に映ってるもの」以降のタイトル行だけ拾い、OCR本文(画面[OCR]:)は落とす
  const lines = raw.split('\n').filter(l => l.startsWith('### ') || l.startsWith('ターミナル['))
  return lines.slice(0, 8)
}

const EXT_ORIGIN = /^(chrome-extension|moz-extension|safari-web-extension):\/\//
function corsHeaders(req) {
  const o = req.headers.origin || ''
  return EXT_ORIGIN.test(o) ? { 'access-control-allow-origin': o, 'access-control-allow-headers': 'authorization', 'vary': 'origin' } : {}
}
let CORS = {}
function send(res, code, body) {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s), 'cache-control': 'no-store', ...CORS })
  res.end(s)
}

// 記憶カード: 拡張が「この3件を渡します」と見せ、OKされた分だけAIの入力欄へ足す。
// 優先: 質問語に当たるfacts → 未来の締切 → いま走行中のタスク → 意味検索で当たったタスク。合計limit件。
function handoffCards(q, limit, level) {
  const live = loadLive()
  const cards = []
  const seen = new Set()
  const push = (c) => { if (!seen.has(c.id) && cards.length < limit) { seen.add(c.id); cards.push(c) } }
  for (const f of factsFor(q, live, { limit })) push({ id: `fact:${f.key}`, kind: 'fact', type: f.type, title: factLine(f), text: f.detail || '', when: f.when, last_seen: f.last_seen, score: f.score })
  const qn = q.trim().toLowerCase()
  const open = openTasks()
  for (const t of open) {
    if (!qn || `${t.name} ${t.goal || ''}`.toLowerCase().includes(qn) || cards.length < 2) push({ id: `open:${t.name}`, kind: 'task', status: t.status, title: `いま：${t.name.slice(0, 80)}`, text: level >= 1 ? (t.goal || '').slice(0, 120) : '', last_active: t.last_active })
  }
  if (qn) {
    for (const h of recall(q, 8)) {
      if (h.score < 0.4) break
      if (h.kind === 'fact') continue  // factsFor で拾い済み
      push({ id: `${h.kind}:${h.text.slice(0, 60)}`, kind: h.kind === 'claim' || h.kind === 'memory' ? 'memory' : 'task', status: h.ref?.status, title: h.text.slice(0, 90), text: '', score: Number(h.score.toFixed(3)) })
    }
  }
  return cards
}

const server = createServer((req, res) => {
  try {
    if (TOKEN) {
      const auth = req.headers.authorization || ''
      if (auth !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' })
    }
    CORS = corsHeaders(req)
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...CORS, 'access-control-allow-methods': 'GET, OPTIONS' }); return res.end() }
    const url = new URL(req.url, `http://${req.headers.host}`)
    const level = LEVELS[url.searchParams.get('disclosure')] ?? LEVELS.context
    const p = url.pathname

    if (p === '/health') return send(res, 200, { ok: true, service: 'memoria-read-api', ts: new Date().toISOString() })

    if (p === '/tasks') return send(res, 200, { disclosure: url.searchParams.get('disclosure') || 'context', tasks: openTasks().map(t => shapeTask(t, level)) })

    if (p === '/recall') {
      const q = url.searchParams.get('q') || ''
      if (!q) return send(res, 400, { error: 'q required' })
      const limit = Math.min(Number(url.searchParams.get('limit') || 8), 25)
      const hits = recall(q, limit).map(h => ({ score: Number(h.score.toFixed(3)), tag: h.tag, text: level >= 2 ? h.text : h.text.slice(0, 110) }))
      return send(res, 200, { q, hits })
    }

    if (p === '/at') {
      const t = url.searchParams.get('t')
      if (!t) return send(res, 400, { error: 't required (ISO JST, e.g. 2026-09-01T19:16:00)' })
      const atMs = Date.parse(/[+Z]/.test(t) ? t : t.replace(' ', 'T') + '+09:00')
      if (Number.isNaN(atMs)) return send(res, 400, { error: 'bad time' })
      return send(res, 200, { at: t, tasks: tasksAt(atMs).map(x => shapeTask(x, level)) })
    }

    if (p === '/day') {  // 時間の巻き戻し: 指定JST日に何に時間を使ったか（#4）
      const jst = url.searchParams.get('date') || new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
      const rows = daySummary(jst).map(r => ({ name: level >= 1 ? r.name : r.name.slice(0, 40), mins: r.mins, status: r.status }))
      return send(res, 200, { date: jst, total_min: rows.reduce((s, r) => s + r.mins, 0), tasks: rows })
    }

    if (p === '/facts') {  // 覚えたこと（人・締切・決定・案件）
      const type = url.searchParams.get('type') || ''
      const q = url.searchParams.get('q') || ''
      const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100)
      const live = loadLive()
      let rows = q ? factsFor(q, live, { limit }) : (live.facts ?? []).slice(0, limit)
      if (type) rows = rows.filter(f => f.type === type)
      return send(res, 200, { updated: live.updated, facts: rows.map(f => ({ type: f.type, value: f.value, detail: f.detail, when: f.when, line: factLine(f), last_seen: f.last_seen, count: f.count, ...(level >= 2 ? { evidence: f.evidence, task_ids: f.task_ids } : {}) })) })
    }

    if (p === '/handoff') {  // AIへ渡す記憶カード（拡張の「渡す前の確認」パネルが読む）
      const q = url.searchParams.get('q') || ''
      const limit = Math.min(Number(url.searchParams.get('limit') || 5), 12)
      const cards = handoffCards(q, limit, level)
      return send(res, 200, { q, ai: url.searchParams.get('ai') || null, cards, ts: new Date().toISOString() })
    }

    if (p === '/context') {
      return send(res, 200, {
        disclosure: url.searchParams.get('disclosure') || 'context',
        tasks: openTasks().map(t => shapeTask(t, level)),
        screen: screenSummary(level),
        facts: factsFor('', loadLive(), { limit: 8 }).map(f => factLine(f)),
        ts: new Date().toISOString(),
      })
    }

    return send(res, 404, { error: 'not found', endpoints: ['/health', '/tasks', '/recall?q=', '/at?t=', '/day?date=', '/context', '/facts?type=&q=', '/handoff?q='] })
  } catch (e) {
    send(res, 500, { error: String(e && e.message || e) })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`memoria read API: http://${HOST}:${PORT}  (disclosure=intent|context|full${TOKEN ? ', token required' : ', localhost no-auth'})`)
})
