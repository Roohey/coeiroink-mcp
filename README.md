# coeiroink-mcp

COEIROINK / VOICEVOX(日本語音声合成エンジン)のローカルHTTP APIをMCP (Model Context Protocol) サーバーとしてラップし、Claude CodeとCodex CLIの両方から音声合成・読み上げを操作できるようにするプラグインです。

## 前提条件

- Node.js 18以上
- 使用するエンジンをあらかじめ手動で起動しておくこと
  - [COEIROINK](https://coeiroink.com/) デスクトップアプリ(既定では `http://127.0.0.1:50032` で待ち受け)
  - [VOICEVOX](https://voicevox.hiroshiba.jp/) エンジン(既定では `http://127.0.0.1:50021` で待ち受け)
  - 両方使う予定がなければ、使わない方は起動しなくて構いません(`engine` 設定で選んだ側だけ使われます)

## ビルド

```
npm install
npm run build
```

`dist/` にビルド成果物が生成されます。

## テスト

```
npm test
```

`node:test`(Node.js組み込み、追加の依存なし)でユニットテストを実行します。実際のCOEIROINK/VOICEVOXエンジンやPowerShell再生プロセスは起動しません(spawn部分やHTTP通信はテスト内で差し替え/スタブ化されています)。設定ファイルの読み書きも一時ディレクトリに隔離されるため、実際の `~/.coeiroink-mcp/` や手元の `config.json` には影響しません。

## 設定

`speak`/`synthesize` で使われるエンジン・話者・スタイル・話速などは、以下の優先順位で解決されます(上ほど優先)。

1. **呼び出し時の明示引数** — `speak`/`synthesize` に直接 `speakerUuid`/`styleId` 等を渡した場合。
2. **呼び出し時の `profile` 引数** — `save_profile` で保存したプリセットを、その1回の呼び出しだけに適用。
3. **アクティブプロファイル** — `use_profile` でセッションに設定したプリセット。`profile` 引数を省略した以後の呼び出し全てに適用され続ける。
4. **セッション既定値** — `set_default_speaker` を `persist` 未指定/`false` で呼んだ場合。このMCPサーバーのプロセスが生きている間だけ有効。
5. **ユーザー設定ファイル** — `~/.coeiroink-mcp/config.json`。`set_default_speaker` を `persist: true` で呼ぶと書き込まれる。次回起動後も有効。
6. **リポジトリ共有既定値** — プラグインルートの `config.json`。git管理下なので手動編集はここ(チーム/複数マシンで共有したい既定値向け)。
7. **ハードコード既定値** — 上記がすべて無い場合のフォールバック。

### プロファイル(名前付きプリセット)

`save_profile` で「話者+スタイル+話速…」の組み合わせに名前を付けて `~/.coeiroink-mcp/config.json` の `profiles` に保存できます。部分指定も可能です(例: 話速だけを持つプロファイル)。

- `save_profile` — プロファイルを保存/更新(既存の同名プロファイルには指定項目のみマージ)
- `list_profiles` — 保存済みプロファイルの一覧とアクティブなプロファイルを取得
- `use_profile` — このセッションのアクティブプロファイルを設定/解除(`name`省略で解除)
- `delete_profile` — プロファイルを削除(アクティブだった場合は自動的に解除)

```json
{
  "engine": "coeiroink",
  "coeiroinkUrl": "http://127.0.0.1:50032",
  "voicevoxUrl": "http://127.0.0.1:50021",
  "speakerUuid": "...",
  "styleId": 0,
  "speedScale": 1.0,
  "volumeScale": 1.0,
  "pitchScale": 0.0,
  "intonationScale": 1.0,
  "prePhonemeLength": 0.1,
  "postPhonemeLength": 0.1,
  "outputSamplingRate": 44100
}
```

話者・スタイルのUUID/IDが分からない場合は、`list_speakers` ツールを呼んで一覧を取得してください。現在どの値がどの層から来ているかは `get_current_settings` ツールで確認できます。

### 話者名/スタイル名での指定

`speak`/`synthesize` は `speakerUuid`/`styleId` の代わりに `speakerName`/`styleName`(`list_speakers` の `name` と完全一致)でも話者・スタイルを指定できます。`styleName` を省略した場合はその話者の最初のスタイルが使われます。`speakerUuid`/`styleId` と `speakerName`/`styleName` は同時に指定できません(エラーになります)。

### 対応エンジン(COEIROINK / VOICEVOX)

`engine` を `"coeiroink"` または `"voicevox"` に設定すると、使用するTTSエンジンを切り替えられます。`speakerUuid`/`styleId`等の他のフィールドはエンジンを問わず共通で使われます(`styleId` はCOEIROINKでは「スタイルID」、VOICEVOXでは話者+スタイルを一体で表す「話者番号(speaker)」として解釈されます。`list_speakers` の `styles[].id` に対応する値を指定してください)。

- `engine` は他の話者設定と同様、`set_default_speaker`・`save_profile`・呼び出し時の明示引数のいずれでも変更できます。プロファイルに `engine` を含めれば、プロファイル切り替えでエンジンごと切り替えられます。
- `check_status` / `list_speakers` は `engine` 引数(任意)で対象エンジンを指定でき、既定エンジンを変えずに別エンジンの状態や話者一覧を確認できます。
- COEIROINKとVOICEVOXは別プロセスなので、両方同時に起動しておいて `engine` や `profile` で切り替えて使うこともできます。

### 疑似ストリーミング再生

`speak` はテキストを「。」「!」「?」・改行・最大文字数で断片に分割し、先頭の断片から順に合成・再生します。ある断片の再生中に次の断片の合成が進むため、全文の合成完了を待たずに再生が始まります(長文のナレーションで特に効果があります)。

- `wait`(既定 `true`): 全断片の再生完了まで待ってから応答する。`false` にすると合成・再生をバックグラウンドで進行させ、即座に応答を返す。
- `speak` の応答には呼び出し単位の `speakId` が含まれます(`wait` の真偽を問わず)。`stop_speaking` に `speakId` を渡すと、その呼び出しの再生だけを中断でき、他の並行する `speak` 呼び出しを巻き添えにしません。省略時は従来どおり全ての再生を中断します。
- `stop_speaking`: `speakId` 省略時は再生待ちのキューをすべて破棄し、現在再生中の音声があれば中断する(合成が進行中の断片があれば、そのHTTPリクエストも中断する)。`speakId` を指定すると、その呼び出しの再生だけを中断する。
- `wait:false` は即座に応答するため、その後の合成・再生の失敗はサーバーのstderrにしか出ません。`get_speak_status` に応答の `speakId` を渡すと、`state`(`running`/`completed`/`failed`)・エラー・`segmentsPlayed` を後から取得できます(直近16件のみ保持)。

### 複数話者の台本合成(synthesize_script)

`synthesize_script` は、1行につき「話者名,セリフ」形式で書かれた台本(例: `つくよみちゃん,こんにちは`)をまとめて音声合成し、行ごとにWAVファイルとして書き出します(このツール自体は再生しません)。空行と`#`で始まる行は無視されます。

- 合成を始める前に**全行**の話者名・スタイル名を `list_speakers` の一覧に対して検証し、1件でも解決できない行があれば、どのファイルも書き出さずにエラー(元の台本の行番号付き)を返します(部分的な書き出しを防ぐため)。
- 既定(`scriptFormat` 省略または `"legacy"`)では、各話者のスタイルは最初のスタイルが使われます。最初の半角カンマだけが区切りなので、セリフにカンマを含めても構いません。
- 行ごとにスタイルを指定したい場合は `scriptFormat: "styled"` を渡し、「話者名,スタイル名,セリフ」形式で書きます。形式は呼び出し全体に適用され、自動判定はしません。

  ```
  つくよみちゃん,れいせい,こんにちは
  つくよみちゃん,,スタイル欄が空ならその話者の最初のスタイル
  つくよみちゃん,げんき,はい,どうぞ
  ```

  - 最初の2つの半角カンマで区切り、残りはすべてセリフになります(上の3行目のセリフは `はい,どうぞ`)。各欄の前後の空白は取り除かれます。
  - スタイル欄が空(空白のみを含む)の行は、その話者の最初のスタイルを使います(設定ファイルやプロファイルの `styleId` は使いません)。話者名とセリフは空にできません。カンマが2つない行はエラーです。
  - 引用符は普通の文字として扱います(CSVの引用・エスケープ処理はしません)。カンマを含む話者名・スタイル名は指定できません。
  - 話者名・スタイル名は `list_speakers` の表示名と完全一致が必要です。
- `manifest.json` の各行には、実際に使われた `styleId`・`styleName` が記録されます。
- 出力先(`outputDir`、省略時は一時フォルダ)に、行ごとのWAVファイルと、ファイル名・再生時間(秒)・合計再生時間を含む `manifest.json` を書き出します。
- 実際に順番通り読み上げたい場合は、返ってきたマニフェストを見ながら `speak` を行ごとに呼び出してください(再生のバッチ化・自動連続再生は意図的にサポートしていません)。

## Claude Codeへの導入

```
/plugin marketplace add C:\path\to\coeiroink-mcp
/plugin install coeiroink@coeiroink-mcp
```

インストール後、Claude Codeを再起動すると `.mcp.json` で宣言されたMCPサーバーが読み込まれ、下記の各種ツールが使えるようになります。

## Codex CLIへの導入

```
npm run build
npm run install:codex
```

`codex mcp add` サブコマンドが使える場合はそれで登録し、使えない(古いバージョン等の)場合は `~/.codex/config.toml` に `[mcp_servers.coeiroink]` を直接、冪等に追記/更新します(既存のブロックがあれば丸ごと置き換えます)。登録後、Codexを再起動してください。

登録を解除するには `npm run uninstall:codex` を実行してください。

`CODEX_HOME` 環境変数を設定すると、Codexの設定ディレクトリを上書きできます(既定は `~/.codex`)。

手動で登録したい場合は、`~/.codex/config.toml` に以下を追記してください:

```toml
[mcp_servers.coeiroink]
command = "node"
args = ["C:\\path\\to\\coeiroink-mcp\\dist\\index.js"]
startup_timeout_sec = 20
```

## ツール一覧

| ツール | 説明 | 主な引数 |
|---|---|---|
| `check_status` | エンジンへの接続確認 | `engine`(任意、省略時は既定エンジン) |
| `list_speakers` | 話者・スタイル一覧の取得 | `engine`(任意、省略時は既定エンジン) |
| `speak` | テキストを合成し、この端末で即座に再生(長文は断片ごとに疑似ストリーミング) | `text`(必須)、`engine`/話者/スタイル/話速等(任意、`speakerName`/`styleName`可)、`profile`(任意)、`wait`(任意、既定true) |
| `synthesize` | テキストを合成し、WAVファイルとして保存 | `text`(必須)、`outputPath`(任意)、`engine`/話者/スタイル/話速等(任意、`speakerName`/`styleName`可)、`profile`(任意) |
| `synthesize_script` | 複数話者の台本(「話者名,セリフ」形式、`scriptFormat:"styled"`なら「話者名,スタイル名,セリフ」形式)をまとめて合成し、行ごとにWAV+再生時間つきmanifest.jsonを書き出す(再生はしない) | `script`(必須)、`scriptFormat`(任意、`legacy`/`styled`、既定`legacy`)、`outputDir`(任意)、`engine`/話速等(任意)、`profile`(任意) |
| `stop_speaking` | 再生中/再生待ちの音声を中断・破棄(`speakId`指定時はその呼び出しだけを中断) | `speakId`(任意、省略時は全呼び出し分を中断) |
| `get_speak_status` | `speak`呼び出しの実行状態(`state: running/completed/failed`、エラー、`segmentsPlayed`等)を後から取得。特に`wait:false`はエラーがstderrにしか出ないため唯一の取得手段。直近16件のみ保持 | `speakId`(任意、省略時は直近の呼び出し) |
| `get_current_settings` | 現在の実効設定値と、各項目の出所(session/activeProfile/userFile/repoFile/default)を取得 | なし |
| `set_default_speaker` | 既定のエンジン/話者/スタイル/話速等を変更 | `engine`/話者/スタイル/話速等(いずれか1つ以上)、`persist`(任意、trueで`~/.coeiroink-mcp/config.json`に永続化) |
| `list_profiles` | 保存済みプロファイルの一覧を取得 | なし |
| `save_profile` | プロファイルを保存/更新 | `name`(必須)、`engine`/話者/スタイル/話速等(いずれか1つ以上) |
| `delete_profile` | プロファイルを削除 | `name`(必須) |
| `use_profile` | アクティブなプロファイルを設定/解除 | `name`(任意、省略で解除) |

## トラブルシューティング

- **「(coeiroink/voicevox)エンジンが起動していません」というエラーが出る**: 該当するデスクトップアプリ/エンジンを起動してから再試行してください。`config.json` の `coeiroinkUrl`/`voicevoxUrl` が実際のポートと一致しているかも確認してください。`check_status` に `engine` を指定すると、既定エンジンを変えずに接続確認できます。
