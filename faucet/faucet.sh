#!/bin/bash
# 蛇口の注ぎ口 — feeds/ 内の鮮度のあるフィードを全部まとめてプロンプトに注入
# 鮮度: 既定120分。ファイル名別の上書きは下のcase。空/古いフィードは黙って出さない。
FEEDS="$(cd "$(dirname "$0")" && pwd)/feeds"
[ -d "$FEEDS" ] || exit 0
for f in "$FEEDS"/*.md; do
  [ -e "$f" ] || continue
  name="$(basename "$f" .md)"
  case "$name" in
    looksmax) maxmin=15 ;;        # miniが毎分更新
    company-brain) maxmin=60 ;;
    *) maxmin=120 ;;
  esac
  # symlink先の実体で鮮度判定
  real="$(readlink -f "$f" 2>/dev/null || echo "$f")"
  [ -s "$real" ] || continue
  [ -n "$(find "$real" -mmin +$maxmin 2>/dev/null)" ] && continue
  echo "<memoria-faucet agent=\"$name\">"
  cat "$real"
  echo "</memoria-faucet>"
done
