// 根拠グラウンディングの実演（APIキー不要・完全ローカル・データフリー）
//   node demo/grounding-demo.mjs
//
// 翻訳層がやりがちな失敗＝「根拠が薄い時に、周囲の文脈から尤もらしい属性を発明する」を
// 出口のグラウンディング・ガードが機械的に落とす様子を見せる。ここではLLMを呼ばず、
// パーサ出力を模した固定JSONをガードに通すだけ（=判定は決定論的で誰が回しても同じ）。

import { enforceGrounding } from '../parser/grounding.mjs'

// --- サンプル生ログ（1行=1イベントを人間可読に畳んだもの）。汎用の架空ユーザー ---
const sampleLog = [
  '10:02 Browser(GitHub · fix flaky test · pull request #482)',
  '10:05 Terminal(project ▸ npm test)',
  '10:11 Browser(YouTube · One-Pan Garlic Butter Chicken · 12 min recipe)',
  '10:14 Browser(YouTube · 15-Minute Full Body Stretch)',
  '10:20 Editor(app.js — refactor auth middleware)',
].join('\n')

// --- パーサ(LLM)出力を模したタスク群。わざと1件だけ捏造を混ぜる ---
const parserOutput = {
  open_tasks: [
    {
      name: 'GitHub PR #482 のflakyテスト修正',
      goal: 'flakyなテストを直してPRを通す',
      evidence: 'GitHub · fix flaky test · pull request #482 :: project ▸ npm test',
    },
    {
      // ← 捏造: ログにあるのは料理/ストレッチ動画。「プログラミング学習用」は周囲の文脈(コーディング)からの発明
      name: 'プログラミング学習用YouTube動画の視聴',
      goal: 'コーディングスキル向上のため技術動画を見る',
      evidence: 'プログラミング学習チャンネルの技術解説動画',
    },
  ],
  closed_tasks: [
    {
      name: '認証ミドルウェアのリファクタ',
      goal: 'auth middlewareを整理する',
      spans: [['2026-01-01T10:20:00', '2026-01-01T10:30:00']],
      status: 'ongoing',
      evidence: 'app.js — refactor auth middleware',
    },
  ],
}

const r = enforceGrounding(parserOutput, sampleLog)

console.log('── 生ログ ──\n' + sampleLog + '\n')
console.log('── 採用されたタスク（evidenceがログに実在）──')
for (const t of [...r.open_tasks, ...r.closed_tasks]) console.log(`  ✓ ${t.name}`)
console.log('\n── 落とされた無根拠タスク（発明とみなして除去）──')
for (const d of r.dropped) console.log(`  ✗ ${d.name}  [${d.reason}, cover=${(d.cover ?? 0).toFixed(2)}]`)
console.log('\nポイント: 「プログラミング学習用〜」はコーディング作業の文脈から発明されたラベル。')
console.log('料理/ストレッチ動画という実際のログに紐づかないため、出口で自動的に落ちる。')
