# memoria kota ver 2 — 運用本体

memoriaの唯一の運用系（2026-08-29に旧memoria-kotaを全吸収）。二層構成:
- **観測層**（`kota/` ほか・旧v1から移設・LLMなしゼロ円）: 画面2秒キャプチャ→生ログ→メモ注入
- **翻訳層**（このリポのコード）: 生ログを**エージェントに渡せる「タスク」へLLM翻訳**

旧パス `~/memoria-kota` はこのディレクトリへのシンボリックリンク（launchd/外部書き込みの互換用）。
`kota/ knowledge/ connect/ company-share/` 等は個人データ層のため **gitignoreでリポ外**（このリポはプロダクトコードのみ）。

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
