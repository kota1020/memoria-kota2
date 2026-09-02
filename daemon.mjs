// memoria kota v2 — 常駐デーモン（直近だけ常時翻訳・因果ストリーミング）
// 10分ごと: 新イベントがあれば「前回以降＋持ち越し状態」を翻訳し、
//   tasks/current-tasks.md（注入用メモ）/ tasks/tasks-index.jsonl（完了タスクの索引）/ state/open-tasks.json を更新。
//   同じ呼び出しから facts（人・締切・決定・案件）も取り、state/facts.json（生きている記憶）へ統合。
// 新イベントゼロ or ユーザー不在なら claude を呼ばない（コスト最小の芯）。
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { loadEvents, renderEvents } from './parser/render.mjs'
import { interpret } from './parser/interpret.mjs'
import { daySummary } from './recall.mjs'
import { ingestFacts, loadLive, renderFactsSection } from './parser/facts.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const STATE = path.join(dir, 'state/open-tasks.json')
const MEMO = path.join(dir, 'tasks/current-tasks.md')
const INDEX = path.join(dir, 'tasks/tasks-index.jsonl')
const LOGF = path.join(dir, 'state/daemon.log')
mkdirSync(path.join(dir, 'state'), { recursive: true })
mkdirSync(path.join(dir, 'tasks'), { recursive: true })

const INTERVAL = Number(process.env.MEMORIA2_INTERVAL_MS ?? 10 * 60e3)
const MAX_WINDOW = 60 * 60e3  // 一度に翻訳する上限1時間（起動直後の積み残し対策）
const log = (m) => { const line = `${new Date().toISOString()} ${m}` ; console.log(line); try { appendFileSync(LOGF, line + '\n') } catch {} }

function loadState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')) } catch { return { open_tasks: [], last_processed: Date.now() - 45 * 60e3 } }
}
const jstHM = (iso) => { try { return new Date(Date.parse(iso)).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' }) } catch { return '' } }

// 先回り（詰まり検知）: 長く続いてるオープンタスク／今日何度も再開したタスクを nudge として出す。
// 断定でなく「まだ続いてる？まとめる？」の柔らかい合図。外しても脱線しないよう控えめに。
const STUCK_MIN = Number(process.env.MEMORIA2_STUCK_MIN ?? 45)   // 連続滞在がこれを超えたら長時間フラグ
// 監視・巡回系は長時間・頻繁な再開が「正常」なので詰まり判定から除外（誤爆防止）。
// 判定は実タスク名/目的の語に基づく＝捏造でなく、書いてある事実からの分類。
const isMonitoring = (t) => /監視|巡回|監督|検品|見張|watch|monitor|ウォッチ/i.test(`${t.name} ${t.goal || ''}`)
function detectNudges(state) {
  const out = []
  const now = Date.now()
  for (const t of state.open_tasks ?? []) {
    if (isMonitoring(t)) continue
    const started = Date.parse(t.started ?? t.last_active ?? '')
    const last = Date.parse(t.last_active ?? '')
    if (!started || !last) continue
    const mins = Math.round((last - started) / 60000)
    if (t.status === 'ongoing' && mins >= STUCK_MIN && (now - last) < 20 * 60e3) {
      out.push(`- 「${t.name}」を${mins >= 120 ? `${Math.floor(mins / 60)}時間${mins % 60}分` : `${mins}分`}続けています。区切る／まとめる／次へ、で助けられるかも`)
    }
  }
  // 今日すでに何度も中断→再開しているタスク（再燃＝詰まりの兆候・監視系は除く）
  const today = new Date(now + 9 * 3600e3).toISOString().slice(0, 10)
  const reopen = {}
  for (const l of readIndexTail(400)) {
    if (isMonitoring(l)) continue
    const d = (l.spans?.at(-1)?.[1] || l.closed_at || '')
    if (String(d).slice(0, 10) !== today) continue
    reopen[l.name] = (reopen[l.name] || 0) + 1
  }
  for (const [name, n] of Object.entries(reopen)) {
    if (n >= 3 && !out.some(o => o.includes(name))) out.push(`- 「${name}」に今日${n}回戻っています。行ったり来たりで止まっていないか`)
  }
  return out.slice(0, 3)
}

// #4 今日の時間の使い方を注入に自動で差し込む（監視系・放置spanは除外済み・上位のみ）
function todayLine() {
  const jst = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
  const rows = daySummary(jst).filter(r => !isMonitoring(r))
  if (!rows.length) return ''
  const fmt = (m) => m >= 60 ? `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ''}` : `${m}分`
  const top = rows.slice(0, 4).map(r => `${r.name.slice(0, 22)}（${fmt(r.mins)}）`).join(' / ')
  return `\n## 今日の時間の使い方（自動・実作業のみ）\n- ${top}`
}
function readIndexTail(n) {
  try { return readFileSync(INDEX, 'utf8').trim().split('\n').slice(-n).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return [] }
}

function writeMemo(state, recentClosed) {
  const open = state.open_tasks.map(t => `- [${t.status}] ${t.name} — ${t.goal || ''}（最終活動 ${jstHM(t.last_active)}）`).join('\n')
  const closed = recentClosed.map(t => `- [${t.status} ${jstHM(t.spans?.at(-1)?.[1])}] ${t.name}`).join('\n')
  const nudges = detectNudges(state)
  writeFileSync(MEMO, `# いまのタスク（memoria kota v2・LLM翻訳・自動更新）
_行動ログをタスク単位に翻訳したもの（実測精度: 同定0.97/全体0.89）。「今/さっき何してた」系はこれで即答する。生ログは観測層側。_
_ただし走行中タスクは**推定**。ユーザーの新規発話が別件なら、続き前提で塗らずそちらを優先する（外した推定で会話を脱線させない）。_

## 走行中・注視中のタスク
${open || '- （なし）'}

## 直近に完了/中断したタスク
${closed || '- （なし）'}
${nudges.length ? `\n## 先回り（そっと差し出す・押し付けない）\n${nudges.join('\n')}` : ''}${todayLine()}${renderFactsSection(loadLive())}
`)
}

async function tick() {
  const state = loadState()
  const now = Date.now()
  const from = Math.max(state.last_processed, now - MAX_WINDOW)
  const events = loadEvents(from + 1, now)
  if (!events.length) { log('no new events — skip'); return }
  if (now - events.at(-1).t > 15 * 60e3) { log('user idle — skip'); return }

  const windowLabel = `${new Date(from).toISOString()} 〜 ${new Date(now).toISOString()}`
  log(`interpreting ${events.length} events (${windowLabel})`)
  try {
    const r = await interpret({ eventsText: renderEvents(events), openTasks: state.open_tasks, mode: 'stream', windowLabel })
    for (const t of r.closed_tasks) appendFileSync(INDEX, JSON.stringify({ ...t, closed_at: new Date().toISOString() }) + '\n')
    const facts = ingestFacts(r.facts ?? [], { baseISO: new Date(events.at(-1).t).toISOString() }).facts
    const next = { open_tasks: r.open_tasks, last_processed: events.at(-1).t, updated: new Date().toISOString() }
    writeFileSync(STATE + '.tmp', JSON.stringify(next, null, 1)); renameSync(STATE + '.tmp', STATE)
    writeMemo(next, r.closed_tasks)
    log(`ok: open=${r.open_tasks.length} closed=${r.closed_tasks.length} facts=${facts.length}${r.dropped?.length ? ` grounding-dropped=${r.dropped.length}` : ''}`)
  } catch (e) {
    log(`ERROR: ${e.message}`)  // 失敗時はlast_processedを進めない＝次回リトライ
  }
}

// 統合・忘却パス（1日1回・朝4時台の最初のtickで実行）
let lastConsolidated = ''
async function maybeConsolidate() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
  const hourJST = new Date(Date.now() + 9 * 3600e3).getUTCHours()
  if (hourJST !== 4 || lastConsolidated === today) return
  lastConsolidated = today
  log('consolidation start')
  try {
    const { execFile } = await import('node:child_process')
    await new Promise((res, rej) => execFile(process.execPath, [path.join(dir, 'consolidate.mjs')], { timeout: 10 * 60e3 }, (e, o) => e ? rej(e) : (log(`consolidation: ${String(o).trim()}`), res())))
  } catch (e) { log(`consolidation ERROR: ${e.message}`) }
}

log(`daemon start (interval ${INTERVAL / 60000}min, model=${process.env.MEMORIA2_MODEL || 'default'})`)
await tick()
setInterval(() => { tick(); maybeConsolidate() }, INTERVAL)
