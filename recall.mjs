// タスク索引の引き出し（機械経路・0.1ms級）
// 使い方: node recall.mjs <キーワード…> | node recall.mjs --at "2026-08-28 16:30"
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const read = (p) => { try { return readFileSync(path.join(dir, p), 'utf8') } catch { return '' } }
const tasks = read('tasks/tasks-index.jsonl').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
let open = []
try { open = JSON.parse(read('state/open-tasks.json')).open_tasks ?? [] } catch {}

const args = process.argv.slice(2)
const show = (t, tag) => console.log(`[${tag}${t.status}] ${t.name}${t.goal ? ' — ' + t.goal : ''}`)
if (args[0] === '--at' && args[1]) {
  const at = Date.parse(args[1].replace(' ', 'T') + '+09:00')
  for (const t of tasks) if ((t.spans ?? []).some(([s, e]) => Date.parse(s) <= at && at <= Date.parse(e))) show(t, '')
} else if (args.length) {
  const q = args.join(' ').toLowerCase()
  const hit = (t) => (t.name + ' ' + (t.goal ?? '') + ' ' + (t.apps ?? []).join(' ')).toLowerCase().includes(q)
  for (const t of open) if (hit(t)) show(t, 'open:')
  for (const t of tasks.slice(-200)) if (hit(t)) show(t, '')
} else {
  console.log('--- open ---'); for (const t of open) show(t, '')
  console.log('--- recent closed ---'); for (const t of tasks.slice(-15)) show(t, '')
}
