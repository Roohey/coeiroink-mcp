// scripts/codex-cli-runner.mjsのescapeTrailingBackslashesForQuoting単体テスト。
// cmd.exeシェル経由でcodex.cmdを起動する際、各引数を環境変数経由で渡し、コマンド文字列側は
// "%VARNAME%"という固定プレースホルダだけを埋め込む方式にしている(値自体をコマンド文字列へ
// 直接埋め込まないため、値に%や&|<>^!等のcmd.exeメタ文字がいくつ含まれていても安全)。
// ただし値の末尾が奇数個のバックスラッシュで終わる場合、Win32のCreateProcess引数解析規則
// (CommandLineToArgvW互換)により閉じ引用符自体がエスケープされて壊れるため、この関数で
// 末尾のバックスラッシュ数を倍にしてから環境変数へセットする。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  escapeTrailingBackslashesForQuoting,
  buildCodexCmdInvocation,
  isUncPath,
  resolveExecutableFromPath,
  resolveInvokeBaseDir,
  runCodexCli,
} from "../scripts/codex-cli-runner.mjs";

const runnerModuleHref = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "codex-cli-runner.mjs")).href;
const nodeDir = path.dirname(process.execPath);
const fallbackPath = process.platform === "win32" ? `${nodeDir};C:\\Windows\\System32` : `${nodeDir}:/usr/bin`;

test("escapeTrailingBackslashesForQuoting: a value with no trailing backslash is left untouched", () => {
  assert.equal(escapeTrailingBackslashesForQuoting("C:\\Users\\gumi\\index.js"), "C:\\Users\\gumi\\index.js");
});

test("escapeTrailingBackslashesForQuoting: a single trailing backslash is doubled", () => {
  assert.equal(escapeTrailingBackslashesForQuoting("C:\\Users\\gumi\\"), "C:\\Users\\gumi\\\\");
});

test("escapeTrailingBackslashesForQuoting: an already-even number of trailing backslashes is doubled again (not left alone)", () => {
  // 2連続バックスラッシュ("\\\\"、2文字)は素朴には「安全」に見えるが、このヘルパーは
  // 呼び出し元の意図(元の値をそのまま1文字も変えずに引用符境界を安全に跨がせる)通りに
  // 常に末尾ランをそのまま倍にする。倍にした結果(4連続)もWin32解析規則の下で正しく
  // 元の2連続へ戻ることを検証する(下のround-trip系テストで実際の解析結果まで確認する)。
  assert.equal(escapeTrailingBackslashesForQuoting("C:\\Users\\gumi\\\\"), "C:\\Users\\gumi\\\\\\\\");
});

test("escapeTrailingBackslashesForQuoting: a backslash in the middle (not trailing) is left untouched", () => {
  assert.equal(escapeTrailingBackslashesForQuoting("C:\\Users\\gumi\\index.js"), "C:\\Users\\gumi\\index.js");
});

test("isUncPath: recognizes a UNC path (\\\\server\\share\\...)", () => {
  assert.equal(isUncPath("\\\\server\\share\\Users\\gumi\\AppData\\Local\\Temp"), true);
});

test("isUncPath: a normal drive-letter path is not a UNC path", () => {
  assert.equal(isUncPath("C:\\Users\\gumi\\AppData\\Local\\Temp"), false);
});

test("isUncPath: recognizes a forward-slash UNC path (//server/share/...)", () => {
  // Windowsはパス区切りとして\と/のどちらも受け付けるため、TEMP/TMPが//server/share/...の
  // ように設定されている場合os.tmpdir()はこれを正規化せずそのまま返す(実測確認済み)。
  // \\接頭辞のみを見る判定ではこの形式を見落とし、cwd分岐へ誤って進んでしまう。
  assert.equal(isUncPath("//server/share/Users/gumi/AppData/Local/Temp"), true);
});

test("isUncPath: recognizes a mixed-separator UNC path", () => {
  assert.equal(isUncPath("/\\server/share"), true);
  assert.equal(isUncPath("\\/server/share"), true);
});

test("escapeTrailingBackslashesForQuoting: an empty string is left untouched", () => {
  assert.equal(escapeTrailingBackslashesForQuoting(""), "");
});

test("buildCodexCmdInvocation: sets one environment variable per argument, keyed by position, plus the executable placeholder", () => {
  const { argEnv } = buildCodexCmdInvocation("codex.cmd", ["mcp", "add", "coeiroink"]);
  assert.deepEqual(argEnv, {
    COEIROINK_MCP_CODEX_EXE: "codex.cmd",
    COEIROINK_MCP_CODEX_ARG_0: "mcp",
    COEIROINK_MCP_CODEX_ARG_1: "add",
    COEIROINK_MCP_CODEX_ARG_2: "coeiroink",
  });
});

test("buildCodexCmdInvocation: the generated batch content places setlocal disabledelayedexpansion on its own line, not chained with &", () => {
  const { batContent } = buildCodexCmdInvocation("codex.cmd", ["mcp"]);
  const lines = batContent.split("\r\n");
  assert.equal(lines[0], "@echo off");
  assert.equal(lines[1], "setlocal disabledelayedexpansion");
  assert.doesNotMatch(lines[1], /&/, "setlocal must be its own line, not chained via & with the following command");
});

// buildCodexCmdInvocationが生成する.cmdファイル本体を、外側から`cmd /v:on`で遅延展開を
// 強制した状態で直接実行し、2行目のsetlocal disabledelayedexpansionが実際に効いて
// (外側の/v:onを上書きして)!VAR!展開から値を守れているかを検証する(Codex stop-time
// reviewの指摘: 遅延展開を無効化しておらず!VAR!を含むパスが破壊される、への回帰テスト)。
// mid-line結合(`command1 & setlocal ... & command2`)では効果がないことを実測で確認済み
// なので、本当に独立した行になっているかまでこのテストで検証する。
(process.platform === "win32" ? test : test.skip)(
  "buildCodexCmdInvocation: the generated .cmd protects a !VAR!-looking argument value from delayed expansion even when the outer cmd.exe has delayed expansion forced on",
  () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-delayed-exp-test-"));
    const receiverPath = path.join(tmpDir, "receiver.mjs");
    const argvLogPath = path.join(tmpDir, "argv.json");
    fs.writeFileSync(receiverPath, "import fs from 'node:fs';\nfs.writeFileSync(process.env.ARGV_LOG, JSON.stringify(process.argv.slice(2)));\n");

    const dangerousValue = "C:\\Users\\gumi\\!SECRET_ENV_VAR!\\index.js";
    const { batContent, argEnv } = buildCodexCmdInvocation("node", [receiverPath, dangerousValue]);
    const tmpBatPath = path.join(tmpDir, `invoke-${randomUUID()}.cmd`);
    fs.writeFileSync(tmpBatPath, batContent);

    try {
      // 外側のcmd.exeを/v:onで起動し、遅延展開を意図的に強制する。SECRET_ENV_VARという
      // 別の環境変数が実在し、!SECRET_ENV_VAR!が展開されてしまうとその値に置き換わる
      // (バグがあれば検出できる)ようにしておく。
      execFileSync("cmd.exe", ["/v:on", "/c", tmpBatPath], {
        env: { ...process.env, ...argEnv, ARGV_LOG: argvLogPath, SECRET_ENV_VAR: "LEAKED-BY-DELAYED-EXPANSION" },
        encoding: "utf8",
      });

      const receivedArgv = JSON.parse(fs.readFileSync(argvLogPath, "utf8"));
      assert.deepEqual(
        receivedArgv,
        [dangerousValue],
        "the !VAR!-looking substring must survive verbatim even under an externally-forced delayed-expansion environment"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
);

// 2026-08-04の統合改修プラン タスク1: codex.cmdの実行対象解決がbare名のままだと、生成した
// トランポリンがcwd=os.tmpdir()で起動されるため、cmd.exeのbare filename解決
// (NoDefaultCurrentDirectoryInExePathが未設定な通常のシェルではcwdをPATHより先に検索する)
// により、tmpDirへ書き込める別の主体が同名の"codex.cmd"を置くだけで本物より優先実行される
// (実起動経路での実測再現済み)。resolveExecutableFromPathはこれを防ぐため、カレント
// ディレクトリを一切検索対象に含めずPATHのみから絶対パスへ解決する。
test("resolveExecutableFromPath: finds the PATH-listed executable, ignoring a same-named decoy in the current working directory", () => {
  const legitDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-resolve-legit-"));
  const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-resolve-cwd-"));
  const legitPath = path.join(legitDir, "probe.cmd");
  fs.writeFileSync(legitPath, "@echo off\r\nexit /b 0\r\n");
  fs.writeFileSync(path.join(cwdDir, "probe.cmd"), "@echo off\r\nexit /b 0\r\n");

  const originalCwd = process.cwd();
  process.chdir(cwdDir);
  try {
    const resolved = resolveExecutableFromPath("probe.cmd", `${legitDir}${path.delimiter}${fallbackPath}`);
    assert.equal(resolved, legitPath, "must return the PATH-listed shim, not the decoy sitting in cwd");
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(legitDir, { recursive: true, force: true });
    fs.rmSync(cwdDir, { recursive: true, force: true });
  }
});

test("resolveExecutableFromPath: returns undefined when the executable is not found anywhere on PATH", () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-resolve-empty-"));
  try {
    assert.equal(resolveExecutableFromPath("does-not-exist-anywhere.cmd", `${emptyDir}${path.delimiter}${fallbackPath}`), undefined);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("resolveExecutableFromPath: ignores a relative PATH entry even when it would resolve to a real file relative to cwd", () => {
  const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-resolve-relative-"));
  fs.writeFileSync(path.join(cwdDir, "probe.cmd"), "@echo off\r\nexit /b 0\r\n");

  const originalCwd = process.cwd();
  process.chdir(cwdDir);
  try {
    const resolved = resolveExecutableFromPath("probe.cmd", `.${path.delimiter}${fallbackPath}`);
    assert.equal(resolved, undefined, "a relative PATH entry ('.') must be skipped, not resolved against cwd");
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(cwdDir, { recursive: true, force: true });
  }
});

test("buildCodexCmdInvocation: the resolved executable is passed via an environment-variable placeholder, never embedded as a bare token", () => {
  const resolvedExe = "C:\\Users\\gumi\\AppData\\Roaming\\npm\\codex.cmd";
  const { batContent, argEnv } = buildCodexCmdInvocation(resolvedExe, ["mcp", "add", "coeiroink"]);
  assert.equal(argEnv.COEIROINK_MCP_CODEX_EXE, resolvedExe);
  const lines = batContent.split("\r\n");
  assert.match(lines[2], /^"%COEIROINK_MCP_CODEX_EXE%"/, "the executable line must start with the env-var placeholder");
  assert.doesNotMatch(batContent, /codex\.cmd/, "the resolved executable path text must not appear literally in the batch content");
});

// decoy codex.cmdをトランポリンのcwd(os.tmpdir())に、正規シムをPATHに設置して実際にrunCodexCliを
// 子プロセス内で起動し、正規シムだけが実行されることを検証する(2026-08-04統合改修プラン タスク1の
// 最重要回帰テスト)。子プロセスのenvを直接組み立てることで、テスト実行元のシェル自身の
// NoDefaultCurrentDirectoryInExePathの値に依存せず、未設定/`1`設定の両条件を確実に再現する
// (タスク15のNODE_TEST_CONTEXTと同じ「継承された環境変数がテストを無力化する」罠を踏まないため)。
(process.platform === "win32" ? test : test.skip)(
  "runCodexCli: a decoy codex.cmd placed in the trampoline's cwd (os.tmpdir()) is never executed; only the PATH-resolved shim runs",
  () => {
    const legitDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-hijack-legit-"));
    const decoyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-hijack-decoytmp-"));
    const markerPath = path.join(decoyTmpDir, "marker.log");

    fs.writeFileSync(path.join(legitDir, "codex.cmd"), ["@echo off", `echo LEGIT >> "${markerPath}"`, "exit /b 0", ""].join("\r\n"));
    fs.writeFileSync(path.join(decoyTmpDir, "codex.cmd"), ["@echo off", `echo HIJACKED >> "${markerPath}"`, "exit /b 0", ""].join("\r\n"));

    const harnessScript = `import(${JSON.stringify(runnerModuleHref)}).then((m) => { m.runCodexCli(["mcp", "add", "coeiroink"]); });`;

    try {
      for (const noDefaultCwdSearch of [undefined, "1"]) {
        fs.rmSync(markerPath, { force: true });
        const childEnv = {
          ...process.env,
          PATH: `${legitDir};${fallbackPath}`,
          TEMP: decoyTmpDir,
          TMP: decoyTmpDir,
        };
        delete childEnv.NoDefaultCurrentDirectoryInExePath;
        if (noDefaultCwdSearch !== undefined) childEnv.NoDefaultCurrentDirectoryInExePath = noDefaultCwdSearch;

        execFileSync(process.execPath, ["-e", harnessScript], { env: childEnv, encoding: "utf8" });

        const marker = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf8") : "";
        assert.doesNotMatch(
          marker,
          /HIJACKED/,
          `decoy codex.cmd in the trampoline's cwd must not execute (NoDefaultCurrentDirectoryInExePath=${noDefaultCwdSearch})`
        );
        assert.match(
          marker,
          /LEGIT/,
          `the PATH-resolved codex.cmd must execute (NoDefaultCurrentDirectoryInExePath=${noDefaultCwdSearch})`
        );
      }
    } finally {
      fs.rmSync(legitDir, { recursive: true, force: true });
      fs.rmSync(decoyTmpDir, { recursive: true, force: true });
    }
  }
);

// 2026-08-04の統合改修プラン タスク2: 一時トランポリンの置き場所を共有%TEMP%の外へ移す。
// %TEMP%は(この環境では)CodexSandboxUsers等の非ユーザーSID複数がModify権限を持ち、新規
// サブディレクトリにも継承されるため、TEMP内に専用ディレクトリを作るだけでは書き込み権限は
// 減らない(タスク1で実行対象の解決は塞いだが、トランポリン自身の内容を書き込みから実行までの
// 間に差し替えられる経路が残っていた)。resolveInvokeBaseDirは既定でユーザーのホーム
// ディレクトリ配下(~/.coeiroink-mcp/codex-invoke)を返す。
test("resolveInvokeBaseDir: defaults to <home>/.coeiroink-mcp/codex-invoke, not under the shared os.tmpdir()", () => {
  const fakeHome = "C:\\Users\\testuser";
  const resolved = resolveInvokeBaseDir(undefined, fakeHome);
  assert.equal(resolved, path.join(fakeHome, ".coeiroink-mcp", "codex-invoke"));
  assert.ok(
    !resolved.toLowerCase().startsWith(os.tmpdir().toLowerCase()),
    "the default invoke base dir must not live under the shared os.tmpdir()"
  );
});

test("resolveInvokeBaseDir: an explicit override takes precedence over the homedir-based default", () => {
  assert.equal(resolveInvokeBaseDir("D:\\custom\\invoke-dir", "C:\\Users\\testuser"), "D:\\custom\\invoke-dir");
});

// COEIROINK_MCP_CODEX_INVOKE_DIRでbase dirを差し替え、実際にrunCodexCliを2回連続で呼ぶ。
// fakeなcodex.cmd(PATH経由)が%CD%(トランポリンのcwdから継承される)をログへ追記するため、
// 「本当にoverrideが効いているか」「実行ごとに別ディレクトリになるか」「使用後にリークしないか」
// を直接検証できる(単に成功したかどうかだけでは、overrideが無視されて既定のホーム
// ディレクトリが黙って使われていても見かけ上は同じく成功するため、これだけでは配線の証拠に
// ならない)。
(process.platform === "win32" ? test : test.skip)(
  "runCodexCli: each invocation gets a fresh, distinct invoke directory under COEIROINK_MCP_CODEX_INVOKE_DIR, and none are left behind",
  (t) => {
    const legitDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-invokedir-legit-"));
    const invokeBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-invokedir-base-"));
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-invokedir-log-"));
    const cwdLogPath = path.join(logDir, "cwd.log");
    fs.writeFileSync(path.join(legitDir, "codex.cmd"), ["@echo off", `echo %CD% >> "${cwdLogPath}"`, "exit /b 0", ""].join("\r\n"));

    const originalPath = process.env.PATH;
    const originalInvokeDir = process.env.COEIROINK_MCP_CODEX_INVOKE_DIR;
    process.env.PATH = `${legitDir};${fallbackPath}`;
    process.env.COEIROINK_MCP_CODEX_INVOKE_DIR = invokeBaseDir;
    t.after(() => {
      process.env.PATH = originalPath;
      if (originalInvokeDir === undefined) delete process.env.COEIROINK_MCP_CODEX_INVOKE_DIR;
      else process.env.COEIROINK_MCP_CODEX_INVOKE_DIR = originalInvokeDir;
      fs.rmSync(legitDir, { recursive: true, force: true });
      fs.rmSync(invokeBaseDir, { recursive: true, force: true });
      fs.rmSync(logDir, { recursive: true, force: true });
    });

    assert.equal(runCodexCli(["mcp", "add", "coeiroink"]), true, "first invocation should succeed");
    assert.equal(runCodexCli(["mcp", "add", "coeiroink"]), true, "second invocation should succeed");

    const cwds = fs
      .readFileSync(cwdLogPath, "utf8")
      .trim()
      .split(/\r?\n/);
    assert.equal(cwds.length, 2, "the fake codex.cmd should have run exactly twice");
    const [firstCwd, secondCwd] = cwds.map((c) => c.toLowerCase());
    assert.notEqual(firstCwd, secondCwd, "each invocation must use a distinct invoke directory");
    for (const cwd of cwds) {
      assert.ok(
        cwd.toLowerCase().startsWith(invokeBaseDir.toLowerCase()),
        `invoke cwd "${cwd}" must be a subdirectory of the overridden base dir "${invokeBaseDir}"`
      );
    }
    assert.deepEqual(fs.readdirSync(invokeBaseDir), [], "no per-run invocation directory should be left behind");
  }
);

// トランポリン本体の排他書き込み(wx)が失敗した場合、runCodexCliはfalseを返すだけでなく、
// (mkdirSyncまで進んで既に作られていた)専用ディレクトリもリークしないことを検証する。
(process.platform === "win32" ? test : test.skip)(
  "runCodexCli: if writing the trampoline into the invoke directory fails, it reports false and leaves no per-run directory behind",
  (t) => {
    const legitDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-invokedir-fault-legit-"));
    const invokeBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-invokedir-fault-base-"));
    fs.writeFileSync(path.join(legitDir, "codex.cmd"), ["@echo off", "exit /b 0", ""].join("\r\n"));

    const originalPath = process.env.PATH;
    const originalInvokeDir = process.env.COEIROINK_MCP_CODEX_INVOKE_DIR;
    process.env.PATH = `${legitDir};${fallbackPath}`;
    process.env.COEIROINK_MCP_CODEX_INVOKE_DIR = invokeBaseDir;

    const err = Object.assign(new Error("simulated exclusive-write failure"), { code: "EEXIST" });
    t.mock.method(fs, "writeFileSync", () => {
      throw err;
    });

    t.after(() => {
      t.mock.restoreAll();
      process.env.PATH = originalPath;
      if (originalInvokeDir === undefined) delete process.env.COEIROINK_MCP_CODEX_INVOKE_DIR;
      else process.env.COEIROINK_MCP_CODEX_INVOKE_DIR = originalInvokeDir;
      fs.rmSync(legitDir, { recursive: true, force: true });
      fs.rmSync(invokeBaseDir, { recursive: true, force: true });
    });

    assert.equal(runCodexCli(["mcp", "add", "coeiroink"]), false, "must report failure rather than silently succeeding or throwing");
    assert.deepEqual(
      fs.readdirSync(invokeBaseDir),
      [],
      "the per-run invocation directory must not be left behind even when the trampoline write fails"
    );
  }
);

// Codex stop-time reviewの指摘: invokeDir変数はpath.join(...)の時点で(fs.mkdirSyncの成否を
// 問わず)代入されるため、万一そのUUID名のディレクトリが既に(自分たちが作ったのではない別の
// 主体によって)存在していた場合、fs.mkdirSync(invokeDir)はEEXISTで失敗するが、finallyブロックは
// 「invokeDirが代入されているかどうか」だけを見て無条件にfs.rmSync(invokeDir, {recursive:true})
// を呼んでしまい、自分たちが作った覚えのないディレクトリを中身ごと削除してしまう
// (排他的作成という設計の趣旨——所有権が確認できないものには触れない——に反する)。
// randomUUID()による衝突は現実には起こらないが、コード自体の正しさとして「作成に成功した
// ものだけを削除する」よう固定する。crypto.randomUUID()をモックして意図的に衝突させ、
// 衝突先ディレクトリの中身が生き残ることを検証する。
(process.platform === "win32" ? test : test.skip)(
  "runCodexCli: if the per-run invoke directory name collides with a pre-existing, unowned directory, it does not delete it",
  (t) => {
    const legitDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-collision-legit-"));
    const invokeBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-collision-base-"));
    fs.writeFileSync(path.join(legitDir, "codex.cmd"), ["@echo off", "exit /b 0", ""].join("\r\n"));

    const fixedUuid = "11111111-1111-1111-1111-111111111111";
    const collidingDir = path.join(invokeBaseDir, fixedUuid);
    fs.mkdirSync(collidingDir);
    const sentinelPath = path.join(collidingDir, "sentinel.txt");
    fs.writeFileSync(sentinelPath, "not created by runCodexCli; must not be deleted");

    t.mock.method(crypto, "randomUUID", () => fixedUuid);

    const originalPath = process.env.PATH;
    const originalInvokeDir = process.env.COEIROINK_MCP_CODEX_INVOKE_DIR;
    process.env.PATH = `${legitDir};${fallbackPath}`;
    process.env.COEIROINK_MCP_CODEX_INVOKE_DIR = invokeBaseDir;
    t.after(() => {
      t.mock.restoreAll();
      process.env.PATH = originalPath;
      if (originalInvokeDir === undefined) delete process.env.COEIROINK_MCP_CODEX_INVOKE_DIR;
      else process.env.COEIROINK_MCP_CODEX_INVOKE_DIR = originalInvokeDir;
      fs.rmSync(legitDir, { recursive: true, force: true });
      fs.rmSync(invokeBaseDir, { recursive: true, force: true });
    });

    assert.equal(
      runCodexCli(["mcp", "add", "coeiroink"]),
      false,
      "must fail cleanly (name collision) rather than proceeding into someone else's directory"
    );
    assert.equal(
      fs.existsSync(sentinelPath),
      true,
      "the pre-existing, unowned directory's contents must survive untouched (must not be deleted just because its name was assigned to invokeDir)"
    );
  }
);
