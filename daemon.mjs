// memoria kota v2 — 常駐デーモン（直近だけ常時翻訳・因果ストリーミング）
// 10分ごと: 新イベントがあれば「前回以降＋持ち越し状態」を翻訳し、
//   tasks/current-tasks.md（注入用メモ）/ tasks/tasks-index.jsonl（完了タスクの索引）/ state/open-tasks.json を更新。
// 新イベントゼロ or ユーザー不在なら claude を呼ばない（コスト最小の芯）。
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { loadEvents, renderEvents } from './parser/render.mjs'
import { interpret } from './parser/interpret.mjs'

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

function writeMemo(state, recentClosed) {
  const open = state.open_tasks.map(t => `- [${t.status}] ${t.name} — ${t.goal || ''}（最終活動 ${jstHM(t.last_active)}）`).join('\n')
  const closed = recentClosed.map(t => `- [${t.status} ${jstHM(t.spans?.at(-1)?.[1])}] ${t.name}`).join('\n')
  writeFileSync(MEMO, `# いまのタスク（memoria kota v2・LLM翻訳・自動更新）
_行動ログをタスク単位に翻訳したもの（実測精度: 同定0.97/全体0.89）。「今何のタスク？」「さっきの続き」はこれで即答する。生ログは観測層側。_

## 走行中・注視中のタスク
${open || '- （なし）'}

## 直近に完了/中断したタスク
${closed || '- （なし）'}
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
    const next = { open_tasks: r.open_tasks, last_processed: events.at(-1).t, updated: new Date().toISOString() }
    writeFileSync(STATE + '.tmp', JSON.stringify(next, null, 1)); renameSync(STATE + '.tmp', STATE)
    writeMemo(next, r.closed_tasks)
    log(`ok: open=${r.open_tasks.length} closed=${r.closed_tasks.length}`)
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
