#!/bin/bash
# memoria kota v2 — 翻訳済みタスクをLLMプロンプトに注入（30分以上古ければ出さない）
MEMO="$(cd "$(dirname "$0")" && pwd)/tasks/current-tasks.md"
if [ -f "$MEMO" ] && [ -z "$(find "$MEMO" -mmin +30 2>/dev/null)" ]; then
  echo "<memoria-kota2-tasks>"
  cat "$MEMO"
  echo "</memoria-kota2-tasks>"
fi
