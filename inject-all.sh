#!/bin/bash
# memoria kota2 — 全注入まとめ（Claude以外のLLM CLI用: Codex等のフックから呼ぶ）
DIR="$(cd "$(dirname "$0")" && pwd)"
"$DIR/kota/inject.sh"
"$DIR/inject.sh"
"$DIR/faucet/faucet.sh"
