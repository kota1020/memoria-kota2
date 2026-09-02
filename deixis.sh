#!/bin/bash
# 【実験・いつでも削除可】こそあど解決 hook。
# プロンプトに これ/それ/あれ 等があれば resolve.mjs で指示先を推定して注入する。
# 失敗・該当なしは空出力＝プロンプトに一切影響しない（fail-safe）。
# 無効化: ~/.claude/settings.json の UserPromptSubmit からこの行を消す（or resolve.mjs を rm）。
NODE=/opt/homebrew/bin/node
input=$(cat)
prompt=$(printf '%s' "$input" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).prompt||""))}catch{}})' 2>/dev/null)
[ -z "$prompt" ] && exit 0
case "$prompt" in
  *これ*|*それ*|*あれ*|*この*|*その*|*あの*|*ここ*|*そこ*|*あそこ*|*こいつ*|*そいつ*|*あいつ*)
    DEIXIS_HOOK=1 "$NODE" /Users/kota2m/memoria-kota2/resolve.mjs "$prompt" 2>/dev/null ;;
esac
exit 0
