// 統合・忘却パス（Google Memory Bank方式のローカル版）— 1日1回
// ①機械: タスク索引の重複統合（同名・区間重なりをマージ）
// ②LLM: 直近の実行動 vs 意味記憶(LEARNED claims)を突き合わせ、古くなった/矛盾する記憶を検出
//     → 蛇口 feeds/consolidator.md に注入（次の会話でClaudeが見て、記憶の更新を提案/実行できる）
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildIndex } from './search/index.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const INDEX = path.join(dir, 'tasks/tasks-index.jsonl')
const FEED = path.join(dir, 'faucet/feeds/consolidator.md')
const CLAUDE = process.env.MEMORIA2_CLAUDE_BIN || 'claude'

// ① タスク重複統合（同名 かつ 区間が重なる/近接90秒 → spanを合併して1件に）
function dedupeTasks() {
  let lines
  try { lines = readFileSync(INDEX, 'utf8').trim().split('\n').filter(Boolean) } catch { return { before: 0, after: 0 } }
  const tasks = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const merged = []
  const near = (a, b) => Math.max(Date.parse(a[0]), Date.parse(b[0])) <= Math.min(Date.parse(a[1]), Date.parse(b[1])) + 90e3
  for (const t of tasks) {
    const hit = merged.find(m => m.name === t.name && (m.spans ?? []).some(ms => (t.spans ?? []).some(ts => near(ms, ts))))
    if (hit) {
      hit.spans = [...(hit.spans ?? []), ...(t.spans ?? [])].sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]))
      if (t.status === 'done') hit.status = 'done'
    } else merged.push({ ...t })
  }
  writeFileSync(INDEX + '.tmp', merged.map(t => JSON.stringify(t)).join('\n') + '\n')
  renameSync(INDEX + '.tmp', INDEX)
  return { before: tasks.length, after: merged.length }
}

// ② 意味記憶の鮮度チェック（LLM・後知恵）
function reviewMemories() {
  return new Promise((resolve) => {
    const claims = (() => { try { return readFileSync(path.join(dir, 'knowledge/LEARNED.md'), 'utf8').split('\n').filter(l => /^- \[/.test(l)).slice(0, 120).join('\n') } catch { return '' } })()
    const recent = (() => { try { return readFileSync(INDEX, 'utf8').trim().split('\n').slice(-40).map(l => { try { const t = JSON.parse(l); return `- ${t.name} [${t.status}]` } catch { return '' } }).join('\n') } catch { return '' } })()
    if (!claims || !recent) return resolve('（材料不足でスキップ）')
    const prompt = `あなたはmemoriaの記憶統合係（Memory Bank方式）。「確定記憶」と「直近の実行動」を突き合わせ、古くなった・矛盾している可能性が高い記憶だけを挙げよ。確信が持てないものは挙げない。出力は箇条書きのみ、最大5件、各行「⚠ <記憶の要旨> → <何と矛盾/何が変わったか>」。1件も無ければ「（矛盾なし）」とだけ。

## 確定記憶（claims抜粋）
${claims}

## 直近の実行動（翻訳済みタスク）
${recent}`
    const child = execFile(CLAUDE, ['-p'], { timeout: 6 * 60e3, maxBuffer: 4e6 }, (err, stdout) => {
      resolve(err ? `（レビュー失敗: ${err.message.slice(0, 80)}）` : String(stdout).trim().slice(0, 1500))
    })
    child.stdin.write(prompt); child.stdin.end()
  })
}

const d = dedupeTasks()
const review = await reviewMemories()
buildIndex()  // 統合後に意味索引を再構築
writeFileSync(FEED, `# 記憶の統合レポート（consolidator・毎日自動）
_更新: ${new Date().toISOString()} / タスク索引: ${d.before}→${d.after}件に統合済み_

## 古い/矛盾の疑いがある記憶（Claudeへ: 会話の文脈で正しいと確認できたら該当メモリを更新・削除して）
${review}
`)
console.log(`dedupe ${d.before}->${d.after}, review done`)
