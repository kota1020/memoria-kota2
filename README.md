# memoria kota ver 2

**画面から「本人が実際にやったこと」を覚えて、AIエージェントに「今なんのタスクか」を翻訳して渡すローカルのメモリ層。**
会話メモリ（本人が話したことしか覚えられない）と違い、行動そのものから記憶を作る。

<p align="center">
  <img src="media/workflow.svg" width="900" alt="memoria kota2 workflow: 2秒ごとの機械キャプチャ→生ログ→10分ごとにLLMがタスクへ翻訳→毎会話に自動注入。過去は45分刻みでオンデマンド翻訳。蛇口から他エージェントの理解が流れ込み、毎朝4時に記憶を統合。">
</p>

## 仕組みを5行で

1. **見る（0円・LLMなし）** — Mac内蔵API（CoreGraphics/アクセシビリティ/Vision OCR）が**2秒ごと**に画面を観察して生ログに記録
2. **理解する（10分ごと）** — 新しい動きがあった時だけLLMが生ログを読み、「Diaを見てた」ではなく**「広告記事のレビュー[作業中]」**というタスクに翻訳（実測精度0.888・タスク名同定0.97）
3. **思い出させる** — 翻訳済みタスク＋生の画面メモが**毎会話の頭に自動注入**される。過去は聞かれた時だけ**45分刻み**で翻訳（=LLMが一度に読み切れて、タスクが3〜10個入る自然な塊）
4. **注がれる（蛇口）** — 他のエージェントが1行（`echo 理解 | node faucet/pour.mjs <名前>`）で本人の理解を注げる
5. **忘れる** — 毎朝4時に重複をマージし、古い/矛盾する記憶をLLMが検出して会話にフラグを流す

コスト: キャプチャ0円 / 翻訳はClaudeサブスク内（API課金なし）/ データは全部ローカル・クラウド送信なし。
意味検索はApple内蔵の埋め込みモデル（512次元・完全ローカル）: `node recall.mjs <質問>`。

## 構成

- `daemon.mjs` — 常駐。10分ごとに新イベントを翻訳（動きなし/離席中はLLMを呼ばない）＋毎朝4時に統合パス
- `ondemand.mjs` — 過去区間を45分刻みで翻訳（`--hours 3` / `--yesterday` / JST範囲指定）
- `recall.mjs` — 意味検索（`--rebuild`で索引再構築 / `--at "JST"`で時刻検索）
- `consolidate.mjs` — 統合・忘却パス（重複マージ＋矛盾検出→蛇口注入）
- `faucet/` — 蛇口。pour.mjs（注ぎ口）と faucet.sh（会話への注入）
- `inject.sh` — 翻訳済みタスクのプロンプト注入（30分鮮度ゲート）
- `parser/` — rubric.md（タスク定義の正典・実験7ラウンドで検証）/ render.mjs / interpret.mjs
- `search/` — Apple埋め込み（embed.swift）＋意味索引

`kota/ knowledge/ connect/ company-share/` 等は個人データ層のため**リポには含まれない**（.gitignore）。
このリポはプロダクトコードのみ。

## 運用メモ

```bash
launchctl kickstart -k gui/501/com.memoria.kota2   # デーモン再起動
tail -f state/daemon.log                            # 動作確認
node recall.mjs "返金のルール"                        # 意味で引く
node ondemand.mjs --yesterday                       # 昨日を丸ごと翻訳
```

環境変数: `MEMORIA2_MODEL`（モデル上書き。既定=Fable級）/ `MEMORIA2_INTERVAL_MS` / `MEMORIA_SRC_LOG`

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — 個人利用・学習・改変は自由。商用利用は要許可。by kota1020
