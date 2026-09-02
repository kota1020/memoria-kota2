// 覚えたこと（facts）— 人・締切・決定・案件の抽出結果を正規化し、生きている記憶として持つ。
// なぜタスクと別に持つか: タスクは「何をしていたか」、factsは「次にAIへ渡す価値がある具体名」。
// サイトの約束（プロジェクトA／締切7/31／田中さん）はこの層で実体化する。
// 抽出はinterpret.mjsの同じ1回のLLM呼び出しに相乗り（追加コスト0）、根拠グラウンディングも共通。
import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(dir, '..')
export const LIVE = path.join(root, 'state/facts.json')      // 生きている記憶（重複統合済み）
export const HISTORY = path.join(root, 'tasks/facts.jsonl')  // 抽出履歴（追記のみ）

export const FACT_TYPES = ['person', 'deadline', 'decision', 'project']
const LIVE_MAX = 400
const DEADLINE_KEEP_PAST_DAYS = 30

const norm = (s) => String(s ?? '').trim().replace(/[\s　]+/g, ' ')
const keyNorm = (s) => norm(s).toLowerCase().replace(/[\s　「」『』"'`・、。,.]/g, '')

// 「7/31」「7月31日」「2026-07-31」「31日」→ ISO日付。年月が無ければ基準日に最も近い方へ補う。
export function parseDeadline(text, baseISO) {
  const s = norm(text)
  const base = new Date(Date.parse(baseISO || new Date().toISOString()))
  if (Number.isNaN(base.getTime())) return null
  let y, m, d
  let mt
  if ((mt = s.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/))) { y = +mt[1]; m = +mt[2]; d = +mt[3] }
  else if ((mt = s.match(/(\d{1,2})[/月](\d{1,2})日?/))) { m = +mt[1]; d = +mt[2] }
  else if ((mt = s.match(/(?:^|[^\d])(\d{1,2})日(?!\d)/))) { d = +mt[1] }
  else return null
  if (d < 1 || d > 31 || (m != null && (m < 1 || m > 12))) return null
  const jstBase = new Date(base.getTime() + 9 * 3600e3)
  const by = jstBase.getUTCFullYear(), bm = jstBase.getUTCMonth() + 1
  if (m == null) m = bm
  if (y == null) {
    // 基準日から半年以内に収まる年を選ぶ（12月に「1/15」と言えば来年）
    const cands = [by - 1, by, by + 1].map(yy => ({ yy, diff: Math.abs(Date.UTC(yy, m - 1, d) - Date.UTC(by, bm - 1, jstBase.getUTCDate())) }))
    y = cands.sort((a, b) => a.diff - b.diff)[0].yy
  }
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return Number.isNaN(Date.parse(iso)) ? null : iso
}

// LLM出力のfactsを検証・正規化。型外・空値は落とす。deadlineはwhenをISOに揃える。
export function normalizeFacts(facts, { baseISO } = {}) {
  const out = []
  const seen = new Set()
  for (const f of Array.isArray(facts) ? facts : []) {
    if (!f || !FACT_TYPES.includes(f.type)) continue
    const value = norm(f.value).slice(0, 120)
    if (!value) continue
    const fact = { type: f.type, value, detail: norm(f.detail).slice(0, 200), task_id: f.task_id ? String(f.task_id) : null, evidence: norm(f.evidence).slice(0, 400) }
    if (f.type === 'deadline') {
      const when = parseDeadline(f.when || '', baseISO) || parseDeadline(value, baseISO)
      if (!when) continue  // 日付に落ちない締切は覚えない（曖昧な期日を渡すと害）
      fact.when = when
    }
    fact.key = `${fact.type}:${fact.type === 'deadline' ? fact.when + ':' + keyNorm(fact.detail || fact.value) : keyNorm(value)}`
    if (seen.has(fact.key)) continue
    seen.add(fact.key)
    out.push(fact)
  }
  return out
}

export function loadLive() {
  try { const j = JSON.parse(readFileSync(LIVE, 'utf8')); return { facts: Array.isArray(j.facts) ? j.facts : [], updated: j.updated } } catch { return { facts: [] } }
}

// 生きている記憶へ統合。同keyは回数と最終確認を更新（人は何度も出るほど重要）。
export function mergeFacts(live, incoming, nowISO = new Date().toISOString()) {
  const facts = [...(live.facts ?? [])]
  for (const f of incoming) {
    const hit = facts.find(x => x.key === f.key)
    if (hit) {
      hit.count = (hit.count || 1) + 1
      hit.last_seen = nowISO
      if (f.detail && f.detail.length > (hit.detail || '').length) hit.detail = f.detail
      if (f.task_id && !(hit.task_ids || []).includes(f.task_id)) hit.task_ids = [...(hit.task_ids || []), f.task_id].slice(-8)
      hit.evidence = f.evidence || hit.evidence
    } else {
      facts.push({ ...f, task_ids: f.task_id ? [f.task_id] : [], first_seen: nowISO, last_seen: nowISO, count: 1 })
    }
  }
  // 忘却: 過ぎて久しい締切は落とす。全体は最終確認の新しい順で上限
  const cutoff = Date.parse(nowISO) - DEADLINE_KEEP_PAST_DAYS * 86400e3
  const kept = facts.filter(f => !(f.type === 'deadline' && Date.parse(f.when + 'T23:59:59+09:00') < cutoff))
  kept.sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen))
  return { facts: kept.slice(0, LIVE_MAX), updated: nowISO }
}

export function saveLive(live) {
  mkdirSync(path.dirname(LIVE), { recursive: true })
  writeFileSync(LIVE + '.tmp', JSON.stringify(live, null, 1)); renameSync(LIVE + '.tmp', LIVE)
}
export function appendHistory(facts, extra = {}) {
  if (!facts.length) return
  mkdirSync(path.dirname(HISTORY), { recursive: true })
  appendFileSync(HISTORY, facts.map(f => JSON.stringify({ ...f, ...extra, at: new Date().toISOString() })).join('\n') + '\n')
}

// 1回分の取り込み（daemon / ondemand 共通）: 正規化→履歴追記→生きている記憶へ統合→保存
export function ingestFacts(rawFacts, { baseISO, source } = {}) {
  const facts = normalizeFacts(rawFacts, { baseISO })
  if (!facts.length) return { facts, live: loadLive() }
  appendHistory(facts, source ? { source } : {})
  const live = mergeFacts(loadLive(), facts)
  saveLive(live)
  return { facts, live }
}

const jstDate = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10)
const TYPE_LABEL = { person: '人', deadline: '締切', decision: '決定', project: '案件' }
export function factLine(f) {
  if (f.type === 'deadline') return `締切 ${f.when}${f.detail ? `：${f.detail}` : f.value && !f.value.includes(f.when) ? `：${f.value}` : ''}`
  return `${TYPE_LABEL[f.type] || f.type} ${f.value}${f.detail ? `：${f.detail}` : ''}`
}

// 注入用: 近い締切 → 直近の決定 → 直近の人・案件。古いものは出さない（注入は短く）
export function renderFactsSection(live, { limit = 8, nowMs = Date.now(), recentHours = 48 } = {}) {
  const facts = live?.facts ?? []
  if (!facts.length) return ''
  const today = jstDate(nowMs)
  const recent = (f) => nowMs - Date.parse(f.last_seen) < recentHours * 3600e3
  const deadlines = facts.filter(f => f.type === 'deadline' && f.when >= today).sort((a, b) => a.when.localeCompare(b.when))
  const decisions = facts.filter(f => f.type === 'decision' && recent(f))
  const others = facts.filter(f => (f.type === 'person' || f.type === 'project') && recent(f)).sort((a, b) => (b.count || 1) - (a.count || 1))
  const rows = [...deadlines.slice(0, 4), ...decisions.slice(0, 3), ...others].slice(0, limit)
  if (!rows.length) return ''
  return `\n## 覚えたこと（人・締切・決定・自動抽出、根拠つきのみ）\n${rows.map(f => `- ${factLine(f)}`).join('\n')}`
}

// 引き渡し用: 質問語に当たるfactsを返す（値・詳細への部分一致＋近い締切は常に候補）
export function factsFor(query, live, { limit = 5, nowMs = Date.now() } = {}) {
  const facts = live?.facts ?? []
  const q = keyNorm(query)
  const terms = norm(query).split(/[\s、。,.!?！？「」]+/).map(keyNorm).filter(t => t.length >= 2)
  const today = jstDate(nowMs)
  const scored = facts.map(f => {
    const hay = keyNorm(`${f.value} ${f.detail || ''}`)
    let score = 0
    if (q && hay.includes(q)) score += 1
    for (const t of terms) if (hay.includes(t) || (t.length >= 3 && keyNorm(f.value).length >= 3 && t.includes(keyNorm(f.value)))) score += 0.5
    if (f.type === 'deadline' && f.when >= today) score += 0.3  // 未来の締切はいつでも渡す価値がある
    score += Math.min((f.count || 1), 5) * 0.02
    const ageH = (nowMs - Date.parse(f.last_seen)) / 3600e3
    score += ageH < 24 ? 0.2 : ageH < 72 ? 0.1 : 0
    return { f, score }
  }).filter(x => x.score >= 0.3).sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(x => ({ ...x.f, score: Number(x.score.toFixed(2)) }))
}
