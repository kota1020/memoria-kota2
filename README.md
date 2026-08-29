# memoria kota ver 2 — タスク翻訳層

memoria-kota（v1・観測層）の生ログを、**エージェントに渡せる「タスク」へLLMで翻訳する**層。
v1は一切変更しない（activity-log.jsonl を読み取り専用で参照）。

設計はmemoria-labの7ラウンド検証で確定したレシピ:
**因果ストリーミング（10分チャンク・持ち越し状態）× 規範プロンプト × Fable級モデル ＝ 精度0.888（タスク名同定0.97）**。
LLM呼び出しは `claude` ヘッドレス＝サブスク内でAPI課金なし。コスト戦略は「直近だけ常時・過去はオンデマンド」。

## 構成
- `daemon.mjs` — 常駐。10分ごとに新イベントを翻訳（新イベント無し/離席中はLLMを呼ばない）
  - 出力: `tasks/current-tasks.md`（注入用メモ）/ `tasks/tasks-index.jsonl`（索引）/ `state/open-tasks.json`（持ち越し）
- `ondemand.mjs` — 過去区間を後知恵モードで翻訳（`--hours 3` / `--yesterday` / JST範囲指定）
- `recall.mjs` — 索引の機械検索（キーワード / `--at "2026-08-28 16:30"`）
- `inject.sh` — current-tasks.md をプロンプト注入（UserPromptSubmitフック用・30分鮮度ゲート）
- `parser/` — rubric.md（タスク定義の正典）/ render.mjs / interpret.mjs

## 運用
```bash
# 常駐（インストール済み: ~/Library/LaunchAgents/com.memoria.kota2.plist）
launchctl kickstart -k gui/501/com.memoria.kota2   # 再起動
tail -f state/daemon.log                            # 動作確認
node recall.mjs CS                                  # 引き出し
node ondemand.mjs --yesterday                       # 過去の翻訳
```

環境変数: `MEMORIA2_MODEL`（モデル上書き。既定=セッション既定のfable級）/ `MEMORIA2_INTERVAL_MS` / `MEMORIA_SRC_LOG`
