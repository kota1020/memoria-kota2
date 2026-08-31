// タスク翻訳の核。行動イベント（＋持ち越し状態）を claude ヘッドレスに渡し、
// タスクJSON {open_tasks, closed_tasks} を得る。API課金なし（サブスク内のclaude CLI）。
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { enforceGrounding } from './grounding.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const RUBRIC = readFileSync(path.join(dir, 'rubric.md'), 'utf8')
// 任意: config/profile.md（gitignore対象）にユーザー固有の文脈を書くと翻訳精度が上がる
let PROFILE = ''
try { PROFILE = readFileSync(path.join(dir, '..', 'config', 'profile.md'), 'utf8') } catch {}
const CLAUDE = process.env.MEMORIA2_CLAUDE_BIN || 'claude'
const MODEL = process.env.MEMORIA2_MODEL || ''  // 空=セッション既定（fable級）。品質実測: fable級0.888/sonnet0.827/haiku0.741

function buildPrompt({ eventsText, openTasks, mode, windowLabel }) {
  const causal = mode === 'stream'
  return `あなたはmemoriaのタスクパーサー v2。ユーザーの画面行動ログを「タスク」に翻訳する。出力は**JSONのみ**（前後に文章・コードフェンス禁止）。
${PROFILE ? `\n## ユーザーの文脈（翻訳の精度向上用）\n${PROFILE}\n` : ''}

## 入力ログ（1行=1イベント、時刻はJST）
対象窓: ${windowLabel}
${eventsText}

${causal ? `## 持ち越し状態（前回までのオープンタスク。続きなら同じタスクとして更新する）
${JSON.stringify(openTasks ?? [], null, 1)}

## 因果処理の掟
- 判断材料はこのログと持ち越し状態だけ。持ち越しタスクの続きは新タスクにせず更新（spanを伸ばす/statusを確定）
- 窓の終端時点でまだ活動中のタスクは open_tasks に残す。完了/中断が確定したものだけ closed_tasks へ移す
- 15分以上活動が無いオープンタスクは paused で閉じてよい` : `## 後知恵モード
この窓は過去の完結した区間。全タスクを closed_tasks に入れる（窓の終端時点でongoingだったものはstatus:"ongoing"のままclosedに入れてよい）。open_tasksは空配列。`}

${RUBRIC}

## 根拠グラウンディング（最重要・全タスク必須）
- 全タスクに evidence を必ず付ける。evidence は**入力ログから一字一句コピーした実在の断片**（ウィンドウ名/タブ名/URL/タイトル/検索語）。言い換え・要約・創作は禁止
- name・goal・属性は evidence に書いてある事実だけで構成する。ログに無い分類（「◯◯系」「専門家」等）や続き判定を、周囲の文脈から推測して足さない
- 根拠が薄い時は発明せず、画面表記そのままの素朴な記述に留める（evidenceが出せないタスクは出力しない）

## 出力形式（JSONのみ）
{"open_tasks":[{"id":"t1","name":"具体的な日本語タスク名","goal":"1文","started":"<ISO JST>","last_active":"<ISO JST>","apps":["Ghostty"],"status":"ongoing","evidence":"ログからコピーした実在断片"}],
 "closed_tasks":[{"id":"t2","name":"…","goal":"1文","spans":[["<ISO JST開始>","<ISO JST終了>"]],"apps":["Dia"],"cross_app":false,"status":"done|paused|ongoing","evidence":"ログからコピーした実在断片"}]}`
}

export function interpret(opts) {
  return new Promise((resolve, reject) => {
    const prompt = buildPrompt(opts)
    const args = ['-p']
    if (MODEL) args.push('--model', MODEL)
    const child = execFile(CLAUDE, args, { timeout: 8 * 60e3, maxBuffer: 8e6, env: { ...process.env } },
      (err, stdout) => {
        if (err) return reject(new Error(`claude failed: ${err.message}`))
        const s = String(stdout)
        const a = s.indexOf('{'), b = s.lastIndexOf('}')
        if (a < 0 || b <= a) return reject(new Error(`no JSON in output: ${s.slice(0, 200)}`))
        try {
          const j = JSON.parse(s.slice(a, b + 1))
          const grounded = enforceGrounding({ open_tasks: j.open_tasks ?? [], closed_tasks: j.closed_tasks ?? [] }, opts.eventsText)
          if (grounded.dropped.length) {
            process.stderr.write(`[grounding] dropped ${grounded.dropped.length} 無根拠タスク: ` +
              grounded.dropped.map(d => `${d.name}(${d.reason})`).join(' / ') + '\n')
          }
          resolve({ open_tasks: grounded.open_tasks, closed_tasks: grounded.closed_tasks, dropped: grounded.dropped })
        } catch (e) { reject(new Error(`bad JSON: ${e.message}`)) }
      })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}
