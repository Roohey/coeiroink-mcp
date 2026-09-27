# Changelog

このプロジェクトの変更点は [Keep a Changelog](https://keepachangelog.com/ja/1.0.0/) の形式に従って記録します。
バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に従います(1.0.0まではツールの引数・返却形式の破壊的変更でminorを上げます)。

## [Unreleased]

## [0.9.0] - 2026-09-10

### Added

- `speak` の応答に `speakId` を追加し、`get_speak_status` を新設した(全13ツール)。`wait:false` を含む呼び出しの実行状態・合成/再生エラー・終了時の再生完了数・中断理由を後から取得できる。開始順で直近16件をプロセス内に保持し、ID省略時は最後に開始した呼び出しを返す。記録がない場合は `found:false` を返す。
- `stop_speaking` に任意の `speakId` を追加した。指定した呼び出しの合成・再生だけを中断し、他の呼び出しを巻き添えにしない。指定時は `{stopped, scope:"call", found}`、省略時は従来の全域停止に `scope:"all"` を加えて返す。

### Changed

- **(破壊的変更)** 全ツールで未知の引数を拒否するようにした。`speedScale` を `speed` と誤記するなど、以前は無視されていた余分なキーも `isError:true` のツールエラーになる。
- **(破壊的変更)** 入力と合成サイズの制限を追加した。`speak`/`synthesize` は空の話者名・スタイル名、空白のみのテキスト、5,000文字超のテキストを拒否する。`speak` は最大500断片、台本は有効行500行・セリフ合計50,000文字・合成結果合計200MiBまでとし、各合成応答は100MiBを超えた時点で読み取りを中断する。`speak`/`synthesize`/`set_default_speaker`/`save_profile` の数値引数は有限値に限定し、`speedScale` は0.1〜10、`volumeScale`/`intonationScale` は0〜10、`pitchScale` は-10〜10を受け付ける。
- **(破壊的変更)** `synthesize` の `outputPath` と `synthesize_script` の `outputDir` は絶対パスで指定する。相対・UNC・拡張長パスを拒否し、Windowsではドライブレターを含む完全修飾パスに限定した。`synthesize` は既存ファイルへの上書きを拒否し、`synthesize_script` は既存の非空ディレクトリを出力先として受け付けない。出力先の省略は引き続き可能。
- **(破壊的変更)** `speak(wait:true)` の `played` は、最後まで再生できた断片が1つ以上ある場合だけ `true` を返す。再生完了数 `segmentsPlayed`、未完了断片の有無 `interrupted`、中断理由 `interruptedBy` を追加した。合成/再生失敗は、当該呼び出しの再生終了を待ち、`isError:true` とJSON形式のテキスト(`error`、`errorKind`、再生結果、`speakId`)を返す。入力検証など実行開始前のエラーは従来のテキストエラー。
- 台本処理・出力パス検証・出力公開を独立したモジュールに整理し、障害注入・並行実行・MCPプロトコル経由の回帰テストを拡充した。テストの一時ファイル後始末と負荷時の不安定性も改善した。

### Fixed

- MCPリクエストのキャンセルが合成HTTPリクエストに伝わらない問題と、`speak(wait:true)` の再生中・再生待ち断片がキャンセル後も残る問題を修正した。キャンセルしたリクエスト自身には応答が返らないため、結果は状態照会または診断ログで確認する。応答済みの `wait:false` は `stop_speaking({speakId})` で停止する。
- `synthesize_script` は全行のWAVとmanifestが揃ってから出力先へ公開し、途中失敗による部分出力・既存結果との混在を防ぐようにした。出力先省略時の名前衝突も修正した。別ボリュームへの公開に対応し、検出した公開競合では明示エラーと復旧用のステージングを残す。公開失敗時は予約前の状態への復元を試みる。ただし同じ出力先への並行操作を完全に排他する保証はない。
- 設定ファイルの破損・一時的な読み取り失敗による既存設定の消失を防ぎ、設定とCodex連携用TOMLの書き込みを原子的にした。不正な型・エンジン名・URL・プロファイル値は警告して除外し、既定値等へのフォールバックを行う。`__proto__` という名前のプロファイルが消失する問題も修正した。
- 合成タイムアウトを接続拒否と区別し、未知のエンジン名も原因が分かるエラーとして報告するようにした。
- Windowsでの `install:codex`/`uninstall:codex` のCodex CLI検出・起動・引数転送を修正した。空白や `%VAR%`/`!VAR!` を含むパス、UNCの一時ディレクトリ等による起動失敗や引数の変化を防ぐようにした。

### Security

- Windowsでカレントディレクトリの偽 `codex.cmd` を実行してしまう経路を修正した。実行対象をPATHから事前に絶対パスへ解決し、一時起動スクリプトの既定保存先を共有TEMPからユーザーホーム配下へ移して、ディレクトリとファイルを排他的に作成するようにした。
- 依存関係で報告されていた既知の脆弱性3件に対応するロックファイル更新を行った(`@modelcontextprotocol/sdk` 1.29.0→1.30.0、`@hono/node-server` 1.19.14→2.0.12、`fast-uri` 3.1.3→3.1.5)。

## [0.8.0] - 2026-07-19

### Added
- `speak`/`synthesize` に `speakerName`/`styleName` 引数を追加。`list_speakers` の表示名と完全一致する話者名・スタイル名で指定でき、`styleName` 省略時はその話者の最初のスタイルが使われる。`speakerUuid`/`styleId` との同時指定はエラーになる。(`src/speaker-resolver.ts`)
- `synthesize_script` ツールを追加。「話者名,セリフ」形式の台本(1行1発話)をまとめて音声合成し、行ごとにWAVファイルとして書き出す。書き出しを始める前に全行の話者名を検証し、1件でも解決できなければ何も書き出さずにエラーを返す。行ごとの再生時間(秒)・ファイル名を含む `manifest.json` を出力先に書き出す(`src/wav.ts` でWAVヘッダから再生時間を算出)。再生の自動連続化は意図的に対象外(既存の `speak` を行ごとに呼ぶ運用を想定)。

### Fixed
- v0.7.0で導入した旧`url`→`coeiroinkUrl`マイグレーションにおいて、`get_current_settings`の`values.coeiroinkUrl`は正しく移行後の値を返す一方、`sources.coeiroinkUrl`が移行元(userFile/repoFile)ではなく`"default"`を誤って報告する不整合を修正。設定スナップショットを「移行済みフィールド(sources判定用)」と「生データ(profiles等の抽出用)」に分離した。
- `combineSignals`(合成リクエストの中断シグナル結合)が、`getStopSignal()`のような長寿命シグナルに`{once:true}`のリスナーを登録したまま、リクエスト完了後も解除していなかったため、`stop_speaking`が一度も呼ばれない長時間セッションで`speak`/`synthesize`を呼ぶたびにリスナーが際限なく積み上がるリークがあった問題を修正。リクエスト完了後に必ず`dispose()`でリスナーを解除するようにした。
（いずれも `/codex:review --base db472ab` の指摘に基づく)

## [0.7.0] - 2026-07-19

### Added
- `node:test`(Node.js組み込み、追加依存なし)による自動テストスイートを追加。`npm test`で実行。実際のエンジン・PowerShell再生プロセスは起動せず、設定ファイルの読み書きも一時ディレクトリに隔離される。これまで各バージョンで使い捨てスクリプトを書いて手動検証してきた項目(文分割、設定解決の優先順位・プロファイル・プロトタイプ汚染耐性・旧urlマイグレーション、再生キューの世代管理・排他ロック・再生プロセスのレースコンディション、`install/uninstall-codex.mjs`のTOML編集ロジック、合成リクエストの中断)をリグレッションテストとして固定化した。
- `stop_speaking` が、進行中の音声合成HTTPリクエスト(COEIROINK `/v1/synthesis` やVOICEVOX `/audio_query`・`/synthesis`)も中断するようになった。従来はキュー・ロックのみリセットしていたため、中断後もリクエスト自体は最大60秒間エンジン側のCPUを使い続けていた。

### Changed
- テスト容易化のための内部整理: `src/config.ts` にリポジトリ/ユーザー設定ファイルのパスを環境変数(`COEIROINK_MCP_REPO_CONFIG_PATH`/`COEIROINK_MCP_CONFIG_DIR`)で差し替えられる注入点と、テスト専用の状態リセット関数を追加。`src/playback.ts` の再生プロセス起動部を差し替え可能にした。`TtsEngineClient.synthesize` に任意の中断シグナル引数を追加。

### Fixed
- v0.6.0で`url`を`coeiroinkUrl`/`voicevoxUrl`に分割した際、旧`url`を使っていた既存の設定ファイル(手動編集していた場合など)が移行なしにサイレントに無視され、カスタムポートを使っているユーザーが既定ポートへの接続に切り替わってしまう(気づかず接続失敗、または別プロセスに接続)問題を修正。`coeiroinkUrl`が明示されていない場合、旧`url`をCOEIROINKの接続先として引き継ぎ、非推奨警告をstderrに出力するようにした。(`/codex:adversarial-review --base c51d77f` の指摘に基づく)

## [0.6.0] - 2026-07-19

### Added
- VOICEVOX(及びAPI互換エンジン)対応。`engine` 設定(`"coeiroink"` | `"voicevox"`)でTTSエンジンを切り替えられるようにした。`engine` は他の話者設定と同様、`set_default_speaker`・`save_profile`・呼び出し時の明示引数で変更でき、プロファイルにも含められる。
- `check_status` / `list_speakers` に任意の `engine` 引数を追加。既定エンジンを変えずに別エンジンの状態・話者一覧を確認できる。
- `src/tts-engine.ts`(共通の`TtsEngineClient`インターフェースと接続エラーハンドリング)、`src/voicevox-client.ts`(VOICEVOXの`/audio_query`→`/synthesis`2段階APIの実装)、`src/tts-registry.ts`(エンジン名からクライアントを引くレジストリ)を追加。

### Changed
- **(破壊的変更)** 設定ファイルのURLフィールドを `url` から `coeiroinkUrl` / `voicevoxUrl` の2つに分割した。既存の `~/.coeiroink-mcp/config.json` / リポジトリの `config.json` に残る古い `url` キーは無視され、既定値(`coeiroinkUrl`)にフォールバックする。
- 内部の設定型 `CoeiroinkConfig` を `VoiceConfig` にリネーム(複数エンジンを扱うようになったため)。

### Fixed
- (v0.5.0タグ後、本リリースまでの間に修正) [P1] ロック(`runExclusive`)待ち中に `stop_speaking` が呼ばれた場合、待機していた呼び出しが世代番号をロック取得後に取得していたため、その呼び出し自身は中断済みと気づかず新しい世代を採用して普通に再生されてしまう問題を修正。世代番号はロック取得前(呼び出し開始時点)で記録するようにした。
- (同上) [P2] `stop_speaking` が再生キューのみリセットし、合成の直列化ロック(`pipelineLock`)を解放していなかったため、中断した呼び出しがまだ待っている合成リクエストの完了(最大60秒)まで、新しい`speak`呼び出しの合成開始がブロックされる問題を修正。`stopPlayback`で`pipelineLock`もリセットするようにした。
- (同上) [P2] `uninstall-codex.mjs`のconfig.toml直接編集フォールバックが `[mcp_servers.coeiroink.env]` のような子テーブルを別セクションと誤認識して削除対象から漏らし、`command`/`url`を持たない不完全なサーバー定義が残ってCodexの設定読み込みが失敗しうる問題を修正。子テーブルも含めて削除するようにした。(いずれも `/codex:review --base 3417b8f` の指摘に基づく)

## [0.5.0] - 2026-07-19

### Added
- `npm run install:codex` / `npm run uninstall:codex` を追加。`codex mcp add`/`codex mcp remove` サブコマンドが使えればそれを使い、使えない場合は `~/.codex/config.toml` を直接、冪等に編集する(`scripts/install-codex.mjs` / `scripts/uninstall-codex.mjs`)。`CODEX_HOME` 環境変数で設定ディレクトリを上書き可能。

### Fixed
- (v0.4.0タグ後、本リリースまでの間に修正) [P1] `stop_speaking` 呼び出し後も `speak` の合成ループが止まらず、まだ合成されていなかった残りの断片が新しい世代でキューに積まれて再生されてしまう(中断したはずの発話が実質的に「再開」する)問題を修正。ループ内で世代番号の変化を検知して打ち切るようにした。
- (同上) [P2] 複数の `speak` 呼び出しが同時に進行すると、各々の断片が合成完了順に共有の再生キューへ積まれ、発話が入り混じる恐れがあった問題を修正。合成→キュー投入までを呼び出し単位で排他制御(`runExclusive`)するようにした。
- (同上) [P2] `stopPlayback` で古い再生プロセスをkillした直後に次の再生が始まると、killされた旧プロセスの終了コールバックが新しいプロセスの `currentChild` を誤って解除してしまい、以後の `stop_speaking` が効かなくなるレース条件を修正。
- (同上) [P2] 文分割の区切り文字に全角の「！」「？」が含まれておらず、半角記号が誤って重複していた(コピペミス)問題を修正。(いずれも `/codex:review --base 88c7275` の指摘に基づく)

## [0.4.0] - 2026-07-19

### Added
- `speak` に疑似ストリーミング再生を導入。テキストを句点等・改行・最大文字数で断片に分割し、先頭の断片から順に合成・再生する(ある断片の再生中に次の断片を合成するため、全文合成の完了を待たずに再生が始まる)。
- `speak` に `wait` 引数を追加(既定 `true`)。`false` にすると合成・再生をバックグラウンドで進行させ、MCP呼び出しは即座に応答する。
- `stop_speaking` ツールを追加。再生待ちのキューを破棄し、現在再生中の音声があれば中断する。

### Changed
- `playback.ts` の再生プロセスをハンドル保持する形にリファクタし、`stop_speaking` から中断できるようにした。

### Fixed
- (v0.3.0タグ後、本リリースまでの間に修正) プロファイル保存時に `profiles` メタデータが `loadConfig`/`resolveEffectiveSettings`/`get_current_settings.values` の解決済み設定値に漏れ出していた問題を修正。設定ファイルの生データからは `CoeiroinkConfig` の既知フィールドだけを抽出してマージするようにした。
- (同上) プロファイル名の存在確認に `in`/ブラケットアクセスを使っていたため、`toString`/`constructor` 等の `Object.prototype` 由来のプロパティ名を実在しないプロファイルとして誤って受理してしまう問題を修正。`use_profile`/`delete_profile`/`resolveEffectiveSettings` の存在確認を `Object.hasOwn` に変更。(いずれも `/codex:review --base 99e66be` の指摘に基づく)

## [0.3.0] - 2026-07-19

### Added
- キャラクター別設定プロファイル機能: `save_profile` / `list_profiles` / `delete_profile` / `use_profile` ツールを追加。話者・スタイル・話速等の組み合わせに名前を付けて `~/.coeiroink-mcp/config.json` の `profiles` に保存し、切り替えられるようにした(部分指定も可)。
- `speak` / `synthesize` に `profile` 引数を追加。その呼び出し1回だけ指定のプロファイルを適用できる。
- 設定解決順序にプロファイル層を追加: 呼び出し時の明示引数 > `profile`引数 > アクティブプロファイル(`use_profile`) > セッション既定値 > ユーザー設定ファイル > リポジトリ共有既定値 > ハードコード既定値。
- `get_current_settings` が `activeProfile` と、各項目の出所として `activeProfile` ソースを返すようになった。

### Changed
- `src/coeiroink-client.ts` に `TtsEngineClient` インターフェースを導入し、`index.ts` からはこのインターフェース越しにのみエンジン機能を呼び出すようにリファクタ(将来の別エンジン対応に備えた内部整理。マルチエンジン対応自体は未実装)。

### Fixed
- `get_current_settings` が返す `values` と `sources` が異なるタイミングのファイル内容を基準にして食い違うことがある問題を修正。リポジトリ共有既定値・ユーザー設定ファイルの生データとマージ結果を同一スナップショットとしてキャッシュし、両者が必ず一致するようにした。(`/codex:review` 指摘)

## [0.2.0] - 2026-07-19

### Added
- `set_default_speaker` ツール: 話者・スタイル・話速等の既定値を変更できるようにした。`persist: true` で `~/.coeiroink-mcp/config.json` に永続化、省略時はこのMCPサーバーのプロセス生存中のみ有効なセッション既定値として扱う。
- `get_current_settings` ツール: 現在の実効設定値と、各項目がどの層(session/userFile/repoFile/default)から来ているかを返す。
- `npm run check:version`: `package.json` / `.claude-plugin/plugin.json` / `.claude-plugin/marketplace.json` のバージョン不一致を検出するスクリプト。

### Changed
- 設定の解決順序を明確化: セッション既定値 > ユーザー設定ファイル(`~/.coeiroink-mcp/config.json`) > リポジトリ同梱の共有既定値(`config.json`) > ハードコード既定値。
- ユーザーごとの永続設定の保存先をリポジトリ直下の `config.json` から `~/.coeiroink-mcp/config.json` に分離(git管理下のファイルが実行時に書き換わらないようにするため)。
- MCPサーバーのバージョン文字列を `package.json` から読み込むようにし、ハードコードをやめた。

## [0.1.0] - 2026-07-19

### Added
- 初回リリース。`check_status` / `list_speakers` / `speak` / `synthesize` の4ツールを持つMCPサーバー。
- Claude Codeプラグインとしての配布形式(`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json`)。
- Codex CLIへの手動導入手順(READMEに記載)。
