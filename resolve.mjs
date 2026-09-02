// 【実験・いつでも削除可】こそあど解決器（deixis resolver）
//   「これ／それ／あれ」を memoria の3層にルーティングして指示先を当てる。
//   コ系=今見てる画面 / ソ系=さっきのタスク / ア系=前の記憶(意味検索)。
//   削除方法: このファイルを rm するだけ。server.mjs の /resolve と deixis.sh を使っていれば
//            そのhook行も外す。他コードはこれに依存していない（完全に独立）。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const SCREEN = process.env.MEMORIA_SCREEN_MEMO || path.join(dir, 'kota/current-activity.md')

// こそあど検出（距離体系）: コ=近い/今, ソ=少し前/さっき, ア=遠い/前のあれ
const MARKERS = [
  { type: 'コ', re: /(これら|これ|この|ここ|こいつ|こっち)/g, layer: 'screen', label: '今見てるもの' },
  { type: 'ソ', re: /(それら|それ|その(?!まま)|そこ|そいつ|そっち)/g, layer: 'task', label: 'さっきの作業' },
  { type: 'ア', re: /(あれら|あれ|あの|あそこ|あいつ|あっち)/g, layer: 'memory', label: '前のあれ（記憶）' },
]

// 画面メモから「最前面の非ターミナル窓（＝見てる対象）」と直近の別窓を拾う
function readScreen() {
  let raw = ''
  try { raw = readFileSync(SCREEN, 'utf8') } catch { return { front: null, recent: [], urlOrOcr: '' } }
  // タイムライン行 "- HH:MM モニタ=App(title)" から新しい順に非ターミナルを集める
  const tl = [...raw.matchAll(/モニタ=([^\n(]+)\(([^\n]*?)\)/g)].map(m => `${m[1].trim()}(${m[2].trim()})`)
  const isTerminal = (s) => /Ghostty|herdr|ターミナル|iTerm|Terminal/i.test(s)
  const seen = new Set(), recent = []
  for (let i = tl.length - 1; i >= 0; i--) { const w = tl[i]; if (isTerminal(w) || seen.has(w)) continue; seen.add(w); recent.push(w) }
  // 最前面ブロックのURL/OCRの断片（あれば添える）
  const urlm = raw.match(/URL:\s*([^\n]+)/)
  return { front: recent[0] || null, recent: recent.slice(0, 4), urlOrOcr: urlm ? urlm[1].trim() : '' }
}

function readTasks() {
  try { return JSON.parse(readFileSync(path.join(dir, 'state/open-tasks.json'), 'utf8')).open_tasks ?? [] } catch { return [] }
}

// 今日の完了/中断タスク（新しい順・監視巡回は除く）＝「さっきやってたあれ」の第一候補
const isMonitoring = (s) => /監視|巡回|監督|検品|見張|watch|monitor|ウォッチ/i.test(s)
function readRecentClosed() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
  let lines = []
  try { lines = readFileSync(path.join(dir, 'tasks/tasks-index.jsonl'), 'utf8').trim().split('\n').slice(-120) } catch { return [] }
  const rows = []
  for (const l of lines) { try { const t = JSON.parse(l); const end = t.spans?.at(-1)?.[1] || t.closed_at || ''; if (String(end).slice(0, 10) === today && !isMonitoring(t.name)) rows.push({ name: t.name, end: Date.parse(end) }) } catch {} }
  return rows.sort((a, b) => b.end - a.end)
}

// クエリからこそあどを検出（重複typeは1つに集約）
function detect(query) {
  const hits = new Map()
  for (const m of MARKERS) { const mm = query.match(m.re); if (mm) hits.set(m.type, { ...m, word: mm[0] }) }
  return [...hits.values()]
}

// メイン。recallは重い(埋め込み)ので ア系がある時だけ遅延ロード
export async function resolveDeixis(query) {
  const found = detect(query)
  if (!found.length) return { markers: [], note: '指示語なし' }
  const screen = readScreen(), tasks = readTasks()
  const out = []
  for (const f of found) {
    if (f.type === 'コ') {
      out.push({ word: f.word, type: 'コ', label: f.label,
        referent: screen.front || '（今見てる非ターミナル窓が特定できない）',
        detail: screen.urlOrOcr, alternatives: screen.recent.slice(1),
        confidence: screen.front ? (screen.recent.length > 1 ? 'mid' : 'high') : 'low' })
    } else if (f.type === 'ソ') {
      const t = tasks[0]
      out.push({ word: f.word, type: 'ソ', label: f.label,
        referent: t ? t.name : '（直近タスクなし）', detail: t?.goal || '',
        alternatives: tasks.slice(1, 3).map(x => x.name),
        confidence: tasks.length === 1 ? 'high' : tasks.length ? 'mid' : 'low' })
    } else if (f.type === 'ア') {
      // まず「今日の直近の完了タスク＝さっきやってたあれ」を見る。無ければ長期記憶へ降りる。
      const recent = readRecentClosed()
      let hits = []
      try { const { recall } = await import('./recall.mjs'); hits = recall(query, 3) } catch {}
      // 会話クエリと語が被る長期記憶が強ければそれ、そうでなければ直近タスクを優先
      const strongMemory = (hits[0]?.score ?? 0) > 0.6
      if (recent.length && !strongMemory) {
        out.push({ word: f.word, type: 'ア', label: '直近やってたあれ',
          referent: recent[0].name, detail: '今日の直近タスク',
          alternatives: recent.slice(1, 3).map(r => r.name),
          confidence: 'mid' })
      } else {
        out.push({ word: f.word, type: 'ア', label: f.label,
          referent: hits[0]?.text?.slice(0, 80) || '（記憶から特定できない）',
          detail: hits[0] ? `[${hits[0].tag}] score ${hits[0].score.toFixed(2)}` : '',
          alternatives: hits.slice(1).map(h => h.text.slice(0, 60)),
          confidence: strongMemory ? 'mid' : 'low' })
      }
    }
  }
  return { markers: out }
}

// --- CLI / hook ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const query = process.argv.slice(2).join(' ')
  const hookMode = process.env.DEIXIS_HOOK === '1'
  if (!query) { console.error('usage: resolve.mjs "…これ／それ／あれを含む文…"'); process.exit(1) }
  const r = await resolveDeixis(query)
  if (!r.markers?.length) { if (!hookMode) console.log('指示語（これ／それ／あれ）は見つからなかった'); process.exit(0) }
  if (hookMode) {
    // 確度lowは注入しない（沈黙＞誤爆）。自信のある推定だけ出す。
    const conf = r.markers.filter(m => m.confidence !== 'low')
    if (!conf.length) process.exit(0)
    const lines = conf.map(m => `- 「${m.word}」≈ ${m.referent}${m.detail ? `（${m.detail}）` : ''} [${m.label}・確度${m.confidence}]`)
    console.log(`<memoria-deixis 指示語の推定先>\n_推定です。違ったら無視して。合ってそうなら確認不要でそのまま進めて。_\n${lines.join('\n')}\n</memoria-deixis>`)
  } else {
    for (const m of r.markers) {
      console.log(`「${m.word}」(${m.type}系=${m.label}) ≈ ${m.referent}  [確度${m.confidence}]`)
      if (m.detail) console.log(`      詳細: ${m.detail}`)
      if (m.alternatives?.length) console.log(`      他候補: ${m.alternatives.join(' / ')}`)
    }
  }
}
