// memoria-kota の activity-log.jsonl（読み取り専用）から時間窓を切り出し、
// LLMが読みやすい1行=1イベント形式に描画する。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const LOG = process.env.MEMORIA_SRC_LOG || path.join(homedir(), 'memoria-kota/kota/activity-log.jsonl')

export function loadEvents(fromMs, toMs) {
  let raw
  try { raw = readFileSync(LOG, 'utf8') } catch { return [] }
  const out = []
  for (const l of raw.split('\n')) {
    if (!l) continue
    // 行頭の日時で粗くフィルタしてからparse（ログが大きくても軽い）
    try {
      const o = JSON.parse(l)
      const t = Date.parse(o.at)
      if (t >= fromMs && t <= toMs && Array.isArray(o.rows) && o.rows.length) out.push({ t, at: o.at, rows: o.rows })
    } catch {}
  }
  return out
}

const jst = (t) => new Date(t + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 19)

export function renderEvents(events) {
  const lines = []
  for (const e of events) {
    const parts = e.rows.map(r => {
      let s = `${r.mon || 'mon'}=${r.app}`
      if (r.title) s += `「${r.title}」`
      if (r.url) s += ` url=${r.url}`
      if (r.idle >= 120) s += ' [IDLE]'
      if (r.ctx) s += ` :: ${String(r.ctx).slice(0, 220).replace(/\n/g, ' ')}`
      return s
    })
    lines.push(`${jst(e.t)} ${parts.join(' ‖ ')}`)
  }
  return lines.join('\n')
}
