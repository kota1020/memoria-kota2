// 過去の任意区間をオンデマンド翻訳（後知恵モード・品質最優先）
// 使い方:
//   node ondemand.mjs "2026-08-28 15:00" "2026-08-28 17:00"   (JSTで指定)
//   node ondemand.mjs --hours 3        (直近3時間)
//   node ondemand.mjs --yesterday
// 結果は表示し、tasks/tasks-index.jsonl にも追記（source:"ondemand"）。facts も state/facts.json へ統合。
import { appendFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { loadEvents, renderEvents } from './parser/render.mjs'
import { interpret } from './parser/interpret.mjs'
import { ingestFacts } from './parser/facts.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const INDEX = path.join(dir, 'tasks/tasks-index.jsonl')
mkdirSync(path.join(dir, 'tasks'), { recursive: true })

const args = process.argv.slice(2)
let from, to
if (args[0] === '--hours') { to = Date.now(); from = to - Number(args[1] ?? 3) * 3600e3 }
else if (args[0] === '--yesterday') {
  const d = new Date(Date.now() + 9 * 3600e3); d.setUTCHours(0, 0, 0, 0)
  to = d.getTime() - 9 * 3600e3; from = to - 24 * 3600e3
} else if (args.length >= 2) {
  from = Date.parse(args[0].replace(' ', 'T') + '+09:00')
  to = Date.parse(args[1].replace(' ', 'T') + '+09:00')
} else { console.error('usage: ondemand.mjs <JST from> <JST to> | --hours N | --yesterday'); process.exit(1) }

const CHUNK = 45 * 60e3  // ラボと同じ45分単位で刻む
const all = []
const allFacts = []
for (let s = from; s < to; s += CHUNK) {
  const e = Math.min(s + CHUNK, to)
  const events = loadEvents(s, e)
  if (events.length < 5) continue
  const windowLabel = `${new Date(s).toISOString()} 〜 ${new Date(e).toISOString()}`
  process.stderr.write(`interpreting ${windowLabel} (${events.length} events)...\n`)
  const r = await interpret({ eventsText: renderEvents(events), mode: 'hindsight', windowLabel })
  all.push(...r.closed_tasks)
  const got = ingestFacts(r.facts ?? [], { baseISO: new Date(e).toISOString(), source: 'ondemand' }).facts
  allFacts.push(...got)
}
for (const t of all) appendFileSync(INDEX, JSON.stringify({ ...t, source: 'ondemand', closed_at: new Date().toISOString() }) + '\n')
console.log(JSON.stringify({ tasks: all, facts: allFacts }, null, 1))
