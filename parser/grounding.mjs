// 根拠グラウンディング・ガード（翻訳層の出口・第一級ルール）
// なぜ: LLMは根拠が薄いと周囲の文脈から尤もらしく発明する（例: EC作業の合間に見た
//       looksmax動画のチャンネルを「EC系YouTuber」と誤ラベル）。これは属性語の問題では
//       なく「薄い時に発明する」という一般病。単語フィルタ（◯◯系を消す等）は対症療法で、
//       次の別の捏造を止められない。根本対策＝各タスクのevidenceが入力ログに実在する断片か
//       を機械照合し、実在しないタスクは発明とみなして落とす。単語でなく「紐付けの有無」で判定。

// 正規化: 小文字化・空白/記号を除去（表記ゆれと引用時の体裁差を吸収）
function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[\s　]+/g, '').replace(/["'`「」『』【】…\-–—・,，、。.:：;；()（）\[\]]/g, '')
}

// 被覆率: evidence全体のうち、ログに実在する連続断片で覆える文字の割合。
// 貪欲に「現在位置から始まる、ログ内に存在する最長の連続断片(≥MIN_CHUNK)」を取って進む。
// 実在断片で埋まらない文字（＝捏造で足した部分）は uncovered として残る。
// 一字一句コピーのevidenceなら被覆≈1.0、捏造を混ぜるほど下がる。
const MIN_CHUNK = 4
function coverage(e, logNorm) {
  if (!e.length) return 0
  let covered = 0, i = 0
  while (i < e.length) {
    let best = 0
    for (let len = e.length - i; len >= MIN_CHUNK; len--) {
      if (logNorm.includes(e.slice(i, i + len))) { best = len; break }
    }
    if (best) { covered += best; i += best } else { i += 1 }
  }
  return covered / e.length
}

const MIN_COVER = 0.6  // evidenceの6割以上がログの実断片で覆えれば「接地」とみなす

// task単体の接地判定。evidenceが空／ログとの被覆が薄い＝発明とみなす。
// 注意: 実在断片に短い捏造属性（"EC系"等）を接着する攻撃は文字列だけでは完全に切れない。
// それはプロンプト側の「evidenceは一字一句コピー」制約で断つ。ここは総崩れの捏造を落とす網。
export function isGrounded(task, logNorm) {
  const e = norm(task?.evidence)
  if (e.length < 4) return { grounded: false, cover: 0, reason: 'no-evidence' }
  const c = coverage(e, logNorm)
  if (c >= MIN_COVER) return { grounded: true, cover: c }
  return { grounded: false, cover: c, reason: 'evidence-not-in-log' }
}

// {open_tasks, closed_tasks} を接地フィルタ。無根拠タスクは落とし、droppedに理由付きで返す。
// MEMORIA2_GROUNDING=off で無効化（実験用）。
export function enforceGrounding(result, eventsText) {
  if (process.env.MEMORIA2_GROUNDING === 'off') return { ...result, dropped: [] }
  const logNorm = norm(eventsText)
  const dropped = []
  const keep = (arr, bucket) => (arr ?? []).filter(t => {
    const g = isGrounded(t, logNorm)
    if (!g.grounded) { dropped.push({ bucket, name: t?.name, reason: g.reason, cover: g.cover }); return false }
    return true
  })
  return {
    open_tasks: keep(result.open_tasks, 'open'),
    closed_tasks: keep(result.closed_tasks, 'closed'),
    dropped,
  }
}
