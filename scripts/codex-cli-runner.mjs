// install-codex.mjs/uninstall-codex.mjsで共用する`codex` CLI起動ヘルパー。
import { execFileSync } from "node:child_process";
// default import(named importではなく)にしているのは、テストからt.mock.method(crypto,
// "randomUUID", ...)でモック可能にするため(named importで束縛した関数はモックしても反映
// されない。scripts/atomic-write-file.mjsのfsで確立した既存の方針を踏襲)。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// "..."で囲んだ引数をWin32のCreateProcess引数解析規則(CommandLineToArgvW互換)へ渡すとき、
// 閉じ引用符の直前にバックスラッシュが奇数個続くと、最後の1つが引用符自体をエスケープして
// しまい閉じ引用符として機能しない(結果、後続のテキストまで同じ引数に取り込まれて壊れる)。
// 末尾のバックスラッシュ数を倍にしておくと、この規則の下で正しく元の個数の引数に戻る
// (2個のバックスラッシュ+引用符 → 1個のリテラルバックスラッシュ+引用符終端、という対応)。
// テスト(単体)向けにexportする。
export function escapeTrailingBackslashesForQuoting(value) {
  return value.replace(/\\+$/, (run) => run + run);
}

// cmd.exeは`\\server\share\...`形式のUNCパスをカレントディレクトリとして扱えない仕様
// (`cwd`にUNCパスを渡すと「UNC パスはサポートされません。Windows ディレクトリを既定で
// 使用します。」という警告つきで無視され、`C:\Windows`等へ黙って差し替わる)。Windowsは
// パス区切りとして`\`と`/`のどちらも受け付けるため、TEMP/TMPが`//server/share/...`という
// フォワードスラッシュ形式のUNCパスに設定されている場合、os.tmpdir()はそれをそのまま
// (バックスラッシュへ正規化せず)返す。`p.startsWith("\\\\")`だけの判定ではこの形式を
// 見落とし、cwd分岐へ誤って進んで同じ起動失敗を起こすことを実測で確認したため、先頭2文字が
// `\`・`/`のいずれか(組み合わせ可)であるかで判定する。テスト(単体)向けにexportする。
export function isUncPath(p) {
  return (p[0] === "\\" || p[0] === "/") && (p[1] === "\\" || p[1] === "/");
}

// codex.cmd(npm install -g経由のWindows実体)をcmd.exeシェル経由で起動する際、実行対象を
// bare名のままコマンド文字列へ埋め込むと、その文字列を含む一時.cmdファイルがcwd=os.tmpdir()で
// 起動されるため、cmd.exeのbare filename解決(NoDefaultCurrentDirectoryInExePathが未設定な
// 通常のシェルではカレントディレクトリをPATHより先に検索する仕様)により、tmpDirへ書き込める
// 別の主体が同名の"codex.cmd"を置くだけで本物のcodexより優先実行されてしまう
// (2026-08-04の統合改修プランで、生成したバッチをcwd付きで実起動し、decoyが本物の引数
// (`mcp add coeiroink -- node <distPath>`)を受け取って実行されることを実測確認済み。この
// 環境では%TEMP%に非ユーザーSID複数がModify権限を持つため、これはサンドボックス脱出の
// プリミティブとして機能しうる)。対策として、実行対象は呼び出し前にPATHのみから絶対パスへ
// 解決する(カレントディレクトリは検索対象に含めない)。where.exeはcwdのdecoyを先に返すため
// 使わない(実測確認済み)。空エントリ・引用符付きエントリを除去し、絶対パスでないPATHエントリ
// は無視する。テスト(単体)向けにexportする。pathValue/pathExtValueは既定でprocess.env.PATH/
// PATHEXTを読むが、テストからカレントプロセスのPATHを汚さずに検証できるよう引数で上書き可能に
// している。
export function resolveExecutableFromPath(name, pathValue = process.env.PATH ?? "", pathExtValue = process.env.PATHEXT) {
  const pathext =
    process.platform === "win32"
      ? (pathExtValue ?? ".COM;.EXE;.BAT;.CMD").split(path.delimiter).filter((ext) => ext !== "")
      : [];
  const candidateNames = process.platform === "win32" && path.extname(name) === "" ? pathext.map((ext) => name + ext) : [name];
  for (const rawDir of pathValue.split(path.delimiter)) {
    const dir = rawDir.replace(/^"(.*)"$/, "$1");
    if (dir === "" || !path.isAbsolute(dir)) continue;
    for (const candidateName of candidateNames) {
      const candidatePath = path.join(dir, candidateName);
      try {
        if (fs.statSync(candidatePath).isFile()) return candidatePath;
      } catch {
        // このディレクトリには存在しない。次の候補/次のディレクトリを試す。
      }
    }
  }
  return undefined;
}

// cmd.exeシェル経由の一時トランポリンは、既定では共有%TEMP%ではなくユーザーのホーム
// ディレクトリ配下(~/.coeiroink-mcp/codex-invoke)に作成する。タスク1(resolveExecutableFromPath)
// で実行対象codex.cmd自体の解決は塞いだが、トランポリン自身の内容は書き込みから実行までの間に
// 差し替えられる経路が残っていた(ファイル名はrandomUUID()で推測不能なため事前設置は不可、
// 書き込み後の監視による差し替えのみが理論上の脅威)。%TEMP%はこの環境では実測で
// `CodexSandboxUsers`等の非ユーザーSID複数がModify権限を持ち、新規サブディレクトリにも
// 継承されることを確認済みのため、TEMP内に専用ディレクトリを作るだけでは書き込み権限は
// 減らない。一方`%USERPROFILE%`(=ホームディレクトリ)には当該ACEが無いことを実測確認済み。
// テスト(単体)向けにexportする。homeDirは既定でos.homedir()を読むが、テストから汚さずに
// 検証できるよう引数で上書き可能にしている(src/config.tsのCOEIROINK_MCP_CONFIG_DIRと同じ方針)。
export function resolveInvokeBaseDir(invokeBaseDirOverride = process.env.COEIROINK_MCP_CODEX_INVOKE_DIR, homeDir = os.homedir()) {
  return invokeBaseDirOverride ?? path.join(homeDir, ".coeiroink-mcp", "codex-invoke");
}

/**
 * cmd.exeシェル経由でcmdを起動するための一時.cmdファイルの中身と、そこで参照する環境変数の
 * 組を組み立てる(副作用なし)。cmdは呼び出し前にresolveExecutableFromPath等で解決済みの
 * 絶対パスであることを前提とする(bare名をそのまま渡すと上記のhijack脆弱性が再発するため、
 * このスクリプト内でbuildCodexCmdInvocationにbare名を渡している箇所がないか変更時は確認
 * すること)。cmdも他の引数と同じ環境変数プレースホルダ機構でコマンド文字列へ渡され、バッチ
 * 本文にはbare名も解決済みパスもテキストとして直接現れない。
 * テスト(単体・「/v:onを外側から強制しても中身のsetlocal行が勝つか」の直接検証)向けに
 * exportする。設計上の理由はrunCodexCliのdocコメントを参照。
 */
export function buildCodexCmdInvocation(cmd, args) {
  if (cmd === "") {
    throw new Error("runCodexCli: 空文字列の実行対象はcmd.exeシェル経由では渡せません。");
  }
  const argEnv = { COEIROINK_MCP_CODEX_EXE: escapeTrailingBackslashesForQuoting(cmd) };
  const argTokens = args.map((value, i) => {
    if (value === "") {
      // Windowsでは環境変数へ空文字列を設定することは事実上「未定義」と等価であり
      // (`set FOO=`で変数自体が消える)、%VAR%展開を空文字列へ安全に解決する手段がない。
      // 呼び出し元(サブコマンド名/サーバー名/自分自身のインストールパス)はいずれも
      // 空文字列になり得ないため、到達したら実装上の想定違反として明示的に失敗させる。
      throw new Error("runCodexCli: 空文字列の引数はcmd.exeシェル経由では渡せません。");
    }
    const varName = `COEIROINK_MCP_CODEX_ARG_${i}`;
    argEnv[varName] = escapeTrailingBackslashesForQuoting(value);
    return `"%${varName}%"`;
  });
  const batContent = ["@echo off", "setlocal disabledelayedexpansion", `"%COEIROINK_MCP_CODEX_EXE%" ${argTokens.join(" ")}`, ""].join(
    "\r\n"
  );
  return { batContent, argEnv };
}

/**
 * `codex`コマンドを候補名を変えながら実行する。
 * Windowsでは、公式インストーラ経由(codex.exe、実行可能ファイル)ならshellなしでも直接
 * 起動できるが、`npm install -g`経由(codex.cmd、バッチファイル)はNode.jsの仕様
 * (CVE-2024-27980対応)によりshellを介さないと直接実行できない。まずshellなしで
 * 各候補名を試し、すべて失敗した場合のみ最終手段としてcmd.exeシェル経由で再試行する。
 *
 * シェル経由の呼び出しは、実測で確認した5段階の不具合を踏まえて設計している。
 * (1) execFileSync(file, args, {shell:true})のようにargs配列をそのまま渡すと、Node自身は
 *     引数を一切エスケープせず単純にスペースで連結するだけなので(Node 24でDEP0190警告の
 *     対象、実測でも発生を確認済み)、スペースを含むインストールパス(`C:\Program Files\...`
 *     等)で引数の区切りが壊れる。壊れた状態でもcodex側がexit 0を返すことがあり、実際には
 *     登録されていないのに「登録しました」と報告してしまう不具合があった。
 * (2) (1)の対策として引数を自前でダブルクオートするだけでは不十分: cmd.exeは"..."の中に
 *     あっても%VAR%形式の環境変数展開を行う(引用符はこの展開を止めない)。実際に、パスの
 *     一部がたまたま実在する環境変数名(例: %PATH%)と一致すると、そのパスの断片が丸ごと
 *     PATH環境変数の値へ無警告で置き換わることを実測で確認した。%を個別にキャレットで
 *     エスケープする手法も、引用符の境界を跨ぐとバックスラッシュの個数次第で引用符自体を
 *     破壊する(上記のescapeTrailingBackslashesForQuotingが対処している規則そのもの)ため
 *     安全に組み合わせられない。そこで各引数をこのスクリプト自身が名付けた一意な環境変数
 *     (呼び出し元の値を汚染しないよう毎回env全体をコピーする)として子プロセスへ渡し、
 *     コマンド文字列側は"%VARNAME%"という固定のプレースホルダだけを埋め込む方式にした。
 *     cmd.exeの%展開は「参照した変数の値をそのまま1回だけ展開する」動作で、展開結果を
 *     再度%展開の対象として走査することはない(実測確認済み)ため、値自体に空白・%・
 *     &|<>^!等のcmd.exeメタ文字がいくつ含まれていても安全に1つの引数として届く……はずだが、
 * (3) (2)には見落としがあった: cmd.exeの遅延展開(setlocal enabledelayedexpansionまたは
 *     `cmd /v:on`で有効化される!VAR!形式の展開)が有効な環境では、(2)で%展開によって
 *     値がテキストへ差し込まれた「後」に、遅延展開が同じ行を!...!パターンについて再走査
 *     してしまう(%展開と違い、遅延展開は"その時点の"テキストを対象にするため)。実際に、
 *     値の中に!SOMEVAR!という文字列がそのまま含まれていると、遅延展開が有効な環境では
 *     それが別の環境変数の値へ置き換わってしまうことを実測で確認した。遅延展開はcmd.exeの
 *     起動時オプション(/v:off)かバッチファイル内の`setlocal disabledelayedexpansion`行
 *     でしか確実に無効化できず、しかも`command1 & setlocal disabledelayedexpansion & command2`
 *     のように同一行内で連結しても効果がない(行全体が一括で展開されてから実行されるため、
 *     実測で確認済み)。`cmd.exe`をexecFileSyncへ直接の実行対象として渡し`/v:off`を追加
 *     しようとする案も試したが、Node自身のexe向け引数エスケープとcmd.exeの`/c`引数の
 *     独自クオート剥がし規則(`cmd /?`参照)が噛み合わず別の破壊を引き起こした。最終的に、
 *     一時ファイルとして実体を持つ.cmdファイルを都度生成し、`setlocal disabledelayedexpansion`
 *     を(同一行への連結ではなく)独立した行として2行目に置く、バッチスクリプトの標準的な
 *     手法を採用した(実ファイルの別行であれば、外側の/v:on環境下でも確実に無効化できる
 *     ことを実測確認済み)。生成した一時ファイルはfinallyで必ず削除する。
 * (4) (3)の一時.cmdファイル自体のパス(os.tmpdir()配下)にも見落としがあった: os.tmpdir()が
 *     スペースを含むユーザー名配下(例: `C:\Users\John Doe\AppData\Local\Temp`)にある環境
 *     では、生成した一時.cmdファイルのパス自体にスペースが含まれうる。execFileSync(file,
 *     args, {shell:true})はfile側(コマンド名)もargsと同様に一切エスケープせず連結するだけ
 *     なので、これを未クオートのままfileパラメータへ渡すとcmd.exeがスペースの手前までしか
 *     実行対象と認識できず起動自体に失敗する(実測で再現済み)ことをCodex stop-time review
 *     が追加検出した。最初は二重引用符で囲む対策を試みたが、(2)と同じ理由(引用符は%展開を
 *     止めない)でos.tmpdir()自体がたまたま%PATH%のような実在の環境変数名を含む場合には
 *     依然として壊れることを、続くCodex stop-time reviewの指摘で実測確認した。根本的に
 *     解決するには、os.tmpdir()のテキスト自体をコマンドライン文字列へ一切埋め込まない設計に
 *     する必要がある: execFileSyncのcwdオプションはOSのCreateProcessへ直接working directory
 *     として渡され、cmd.exeがテキストとして解釈するコマンドライン文字列には一切現れない
 *     (%展開・遅延展開いずれの影響も受けない)。そこでcwdを一時ファイルのディレクトリに
 *     設定したうえで、コマンドライン側は".\<ファイル名>"(ファイル名は固定プレフィックス+
 *     randomUUID()の16進数+ハイフンのみで構成され、%・!・空白等を一切含み得ない)だけに
 *     した。os.tmpdir()の中身に%・!・空白のいずれが含まれていても(遅延展開が外側から強制
 *     されている場合を含め)一切影響を受けないことを実測確認済み。なお".\"という相対パス
 *     接頭辞が必要な根拠として、当初「cmd.exeはbare filenameでは既定でカレントディレクトリを
 *     検索しない」と説明していたが、これは誤り(2026-08-04の統合改修プランで訂正。計測を
 *     行ったエージェント/ツールのシェル環境で`NoDefaultCurrentDirectoryInExePath=1`だった
 *     ことに起因する誤測定であり、他の実測確認事項(%展開・!遅延展開・UNC関連)はこの変数と
 *     無関係に独立で再検証済み)。実際にはこの変数が未設定な通常のシェルでは、cmd.exeは
 *     bare filenameをPATHより先にカレントディレクトリから検索する。".\"接頭辞は、この変数の
 *     値によらず確実にトランポリン自身(ランダムなUUIDを含む予測不能な名前で、cwdに実在する)
 *     を起動するために必要である(`=1`の環境では接頭辞なしのbare名は「内部コマンドまたは
 *     外部コマンドとして認識されていません」で失敗することを実測確認済み)。この誤った前提
 *     こそが、codex.cmd自体のhijack脆弱性(cwdへ書き込める別の主体が同名の"codex.cmd"を
 *     置くと本物より優先実行される)を見落とす一因になった。対策(resolveExecutableFromPath
 *     による事前のPATH限定解決)はそのdocコメントを参照。
 * (5) (4)のcwd方式にも見落としがあった: cwdをUNCパス(例: `\\server\share\...`。ローミング
 *     プロファイルや企業環境でTEMP/TMPがネットワーク共有へリダイレクトされていると起こり
 *     うる)にすると、cmd.exeは起動時に「UNC パスはサポートされません。Windows ディレクトリ
 *     を既定で使用します。」という警告つきでcwdを黙って`C:\Windows`等へ差し替えてしまい
 *     (cmd.exe自体の仕様上の制約。cwdの値自体は正しくCreateProcessへ渡っている)、".\<ファイル
 *     名>"という相対参照が見当違いのディレクトリを探して失敗することをCodex stop-time review
 *     の指摘で実測確認した。UNCパスはcwdとしては使えないが、絶対パスとして直接参照する分には
 *     問題ない(cmd.exeの制約はあくまで「カレントディレクトリ」としての扱いに限られる)ため、
 *     os.tmpdir()がUNCパスの場合だけ(2)の環境変数置換方式(絶対パスを"%VARNAME%"経由で参照)
 *     にフォールバックするようにした。この分岐でのみ(3)で塞いだはずの遅延展開の穴が
 *     理論上再度開く(tmpDir自体が!VAR!形式の文字列を含み、かつ外部から遅延展開が強制されて
 *     いる場合)が、UNC TEMPという時点で既に稀な環境であり、この分岐を通らなければ「常に
 *     起動失敗してconfig.toml直接編集にフォールバックし続ける」という状態だったことを踏まえ、
 *     許容できるトレードオフと判断した(現状維持より確実に改善するため)。判定用のisUncPath
 *     は当初"\\\\"接頭辞のみを見ていたが、Windowsはパス区切りとして"\"と"/"のどちらも
 *     受け付けるため、TEMP/TMPが"//server/share/..."というフォワードスラッシュ形式のUNCパス
 *     に設定されている場合(os.tmpdir()はこれを正規化せずそのまま返す)を見落とし、cwd分岐へ
 *     誤って進んで同じ起動失敗を起こすことをCodex stop-time reviewの指摘で実測確認したため、
 *     先頭2文字が"\"・"/"のいずれか(組み合わせ可)であるかで判定するよう修正した。
 * (6) その後、2026-08-04の統合改修プランのタスク2で、トランポリンの置き場所自体を共有
 *     os.tmpdir()から専用のホームディレクトリ配下(既定は~/.coeiroink-mcp/codex-invoke/<uuid>/。
 *     resolveInvokeBaseDir参照)へ移した。理由: %TEMP%は(この環境では)CodexSandboxUsers等の
 *     非ユーザーSID複数がModify権限を持ち、新規に作った専用サブディレクトリにも継承される
 *     ことを実測確認したため、TEMP内に専用ディレクトリを作るだけでは書き込み権限は減らない
 *     (タスク1でcodex.cmd自体の解決は塞いだが、トランポリン自身の内容を書き込みから実行までの
 *     間に差し替えられる経路が理論上残っていた)。上記(4)(5)で確立した「cwdオプションで
 *     コマンドライン文字列への埋め込みを避ける」「UNCの場合は絶対パス+環境変数参照に
 *     フォールバックする」という設計はそのまま踏襲し、対象ディレクトリだけを差し替えている
 *     (isUncPathの判定対象もos.tmpdir()からinvokeBaseDirへ変更。ローミングプロファイル等で
 *     ホームディレクトリ自体がUNCパスになりうるため、UNCフォールバック自体は引き続き必要)。
 * ここで渡す引数はすべて呼び出し元スクリプト内の既知の値(サブコマンド名/サーバー名/自分
 * 自身のインストールパス)で外部入力を含まないため、シェル経由であることのインジェクション
 * リスクは実質的にない。
 */
export function runCodexCli(args) {
  const candidates = process.platform === "win32" ? ["codex", "codex.exe"] : ["codex"];
  for (const cmd of candidates) {
    try {
      execFileSync(cmd, args, { stdio: "inherit" });
      return true;
    } catch {
      // 次の候補を試す
    }
  }
  if (process.platform === "win32") {
    // 実行対象はカレントディレクトリを検索対象に含めずPATHのみから事前に絶対パスへ解決する
    // (理由・実測結果はresolveExecutableFromPathのdocコメントを参照)。見つからない場合は
    // 「bare名で運試しする」経路を残さず、シェル経由を試みずに呼び出し元のTOML直接編集
    // フォールバックへ委ねる。
    const resolvedCodexPath = resolveExecutableFromPath("codex.cmd");
    if (resolvedCodexPath === undefined) {
      return false;
    }
    // トランポリンは共有%TEMP%ではなくinvokeBaseDir(既定は~/.coeiroink-mcp/codex-invoke。
    // 理由はresolveInvokeBaseDirのdocコメントを参照)配下に、実行ごとに一意な専用ディレクトリを
    // 作って書き込む。ディレクトリ自体を非再帰mkdirで作成する(既存なら理論上あり得ないが
    // EEXISTで失敗する排他的作成)ことに加え、トランポリン本体もwxフラグで排他的に書き込み、
    // 万一の名前衝突時に既存内容を無警告で上書きしないようにしている。
    const invokeBaseDir = resolveInvokeBaseDir();
    let invokeDir;
    // fs.mkdirSync(invokeDir)自体が(理論上あり得ないUUID衝突等で)失敗した場合、そのパスは
    // 自分たちが作ったものではない。invokeDirCreatedByUsで「実際に自分で作成できたか」を
    // 明示的に追跡し、finallyでの削除をそれが真の場合だけに限定する(Codex stop-time
    // reviewの指摘: invokeDir変数はpath.join()の時点で代入されるため、これを見ただけの
    // 素朴なfinallyだと、万一の名前衝突時に自分が作った覚えのない既存ディレクトリを中身ごと
    // 削除してしまう——排他的作成という設計の趣旨に反する)。
    let invokeDirCreatedByUs = false;
    try {
      const { batContent, argEnv } = buildCodexCmdInvocation(resolvedCodexPath, args);
      fs.mkdirSync(invokeBaseDir, { recursive: true });
      invokeDir = path.join(invokeBaseDir, crypto.randomUUID());
      fs.mkdirSync(invokeDir);
      invokeDirCreatedByUs = true;
      const tmpBatFileName = "invoke.cmd";
      const tmpBatPath = path.join(invokeDir, tmpBatFileName);
      fs.writeFileSync(tmpBatPath, batContent, { flag: "wx" });
      const env = { ...process.env, ...argEnv };
      if (isUncPath(invokeBaseDir)) {
        // cmd.exeはUNCパスをcwdとして扱えないため、絶対パスを環境変数経由で直接参照する
        // (UNCパス自体を実行対象として参照する分にはcmd.exeの制約に抵触しない)。ローミング
        // プロファイル等でホームディレクトリ自体がUNCパスになりうるため、この分岐は
        // invokeBaseDirの位置がTEMPからホームディレクトリへ変わった後も引き続き必要。
        env.COEIROINK_MCP_CODEX_BAT_PATH = escapeTrailingBackslashesForQuoting(tmpBatPath);
        execFileSync(`"%COEIROINK_MCP_CODEX_BAT_PATH%"`, { stdio: "inherit", shell: true, env });
      } else {
        // 引数を渡さない(commandを単一の文字列として渡す)ことで、Node 24のDEP0190
        // (shell:true+args配列の組み合わせへの警告)を回避する(実測確認済み)。実際の引数は
        // すべて上記の一時.cmdファイル自身に埋め込み済みなので、ここでは渡す必要がない。
        // このトランポリン自身はrandomUUID()を含む専用ディレクトリの中にあるため、cwd検索で
        // 拾われてもhijackの標的にはならない(resolveExecutableFromPathで事前解決するのは
        // codex.cmd自体だけでよい理由)。".\"接頭辞は、NoDefaultCurrentDirectoryInExePathの
        // 値によらず確実にこのトランポリン自身を起動するために必要(詳細はファイル冒頭の
        // buildCodexCmdInvocation直前のコメント参照)。
        execFileSync(`.\\${tmpBatFileName}`, { stdio: "inherit", shell: true, cwd: invokeDir, env });
      }
      return true;
    } catch {
      return false;
    } finally {
      if (invokeDirCreatedByUs) fs.rmSync(invokeDir, { recursive: true, force: true });
    }
  }
  return false;
}
