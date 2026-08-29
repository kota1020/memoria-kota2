// 蛇口（faucet）— どのエージェントも1行でユーザーの理解をmemoriaに注げる共通の口
// 使い方:
//   echo "内容" | node pour.mjs <agent名>            … feeds/<agent名>.md を上書き
//   node pour.mjs <agent名> --file path.md           … ファイルから
//   （リモートから）ssh <user>@<mac> "node ~/memoria-kota2/faucet/pour.mjs <agent名>" < 内容
// ルール: 内容はそのエージェントが要約済みの「ユーザーについての今の理解」。
//         生ログを流し込まない。更新のたび全置換（追記じゃない）。
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const agent = (process.argv[2] || '').replace(/[^a-zA-Z0-9_-]/g, '')
if (!agent) { console.error('usage: pour.mjs <agent-name> [--file path]'); process.exit(1) }

let content
const fi = process.argv.indexOf('--file')
if (fi > 0 && process.argv[fi + 1]) content = readFileSync(process.argv[fi + 1], 'utf8')
else content = readFileSync(0, 'utf8')
if (!content.trim()) { console.error('empty content — not written'); process.exit(1) }

mkdirSync(path.join(dir, 'feeds'), { recursive: true })
writeFileSync(path.join(dir, 'feeds', `${agent}.md`), content)
console.log(`poured: feeds/${agent}.md (${content.length} chars)`)
