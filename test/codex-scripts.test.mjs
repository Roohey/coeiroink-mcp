import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

// install-codex.mjs/uninstall-codex.mjs は `codex` CLIをまず試すため、
// PATHから`codex`実行ファイルのディレクトリを取り除いて確実にTOML直接編集の
// フォールバック経路を通す(codexが入っていない環境でも再現性を保つため)。
const scriptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const installScript = path.join(scriptsDir, "install-codex.mjs");
const uninstallScript = path.join(scriptsDir, "uninstall-codex.mjs");

const nodeDir = path.dirname(process.execPath);
const fallbackPath = process.platform === "win32" ? `${nodeDir};C:\\Windows\\System32` : `${nodeDir}:/usr/bin`;

// fault-inject-fs.mjs はテスト専用のpreloadモジュール。`--import`でsubprocessに読み込ませ、
// fs.writeFileSync/fsyncSync/renameSyncのいずれか1つだけを合成エラーに置き換える。
// scripts/atomic-write-file.mjs はこの3関数だけでconfig.tomlの原子的書き込みを行うため、
// install-codex.mjs/uninstall-codex.mjsをモック不可能なsubprocessとして起動したままでも、
// 一時ファイル書き込み・fsync・rename各段階の障害注入を実スクリプト経由で検証できる。
const faultInjectPreload = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fault-inject-fs.mjs")
).href;

let tmpHome;
let configTomlPath;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-codex-test-"));
  configTomlPath = path.join(tmpHome, "config.toml");
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function runInstall() {
  return execFileSync("node", [installScript], {
    env: { ...process.env, CODEX_HOME: tmpHome, PATH: fallbackPath },
    encoding: "utf8",
  });
}

function runUninstall() {
  return execFileSync("node", [uninstallScript], {
    env: { ...process.env, CODEX_HOME: tmpHome, PATH: fallbackPath },
    encoding: "utf8",
  });
}

function runInstallWithFault(step) {
  return execFileSync("node", ["--import", faultInjectPreload, installScript], {
    env: { ...process.env, CODEX_HOME: tmpHome, PATH: fallbackPath, COEIROINK_MCP_TEST_FAULT_INJECT_STEP: step },
    encoding: "utf8",
  });
}

function runUninstallWithFault(step) {
  return execFileSync("node", ["--import", faultInjectPreload, uninstallScript], {
    env: { ...process.env, CODEX_HOME: tmpHome, PATH: fallbackPath, COEIROINK_MCP_TEST_FAULT_INJECT_STEP: step },
    encoding: "utf8",
  });
}

function readToml() {
  return fs.readFileSync(configTomlPath, "utf8");
}

function listTmpLeftovers() {
  return fs.readdirSync(tmpHome).filter((name) => name.startsWith("config.toml.tmp-"));
}

test("install: creates config.toml with a coeiroink block when none exists", () => {
  runInstall();
  const toml = readToml();
  assert.match(toml, /\[mcp_servers\.coeiroink\]/);
  assert.match(toml, /command = "node"/);
});

test("install: replaces a stale coeiroink block without corrupting a following section whose args contain '['", () => {
  fs.writeFileSync(
    configTomlPath,
    [
      'model = "gpt-5.6-sol"',
      "",
      "[mcp_servers.other_server]",
      'command = "node"',
      'args = ["other.js"]',
      "",
      "[mcp_servers.coeiroink]",
      'command = "node"',
      'args = ["C:\\\\old\\\\stale\\\\path.js"]',
      "startup_timeout_sec = 999",
      "",
      "[mcp_servers.after]",
      'command = "node"',
      'args = ["after.js"]',
      "",
    ].join("\n")
  );
  runInstall();
  const toml = readToml();
  assert.match(toml, /\[mcp_servers\.other_server\]/);
  assert.match(toml, /\[mcp_servers\.after\]/);
  assert.match(toml, /args = \["after\.js"\]/);
  assert.doesNotMatch(toml, /old\\\\stale\\\\path\.js/);
  // "after"セクションのargs行がそのまま残っている(壊れていない)ことを確認
  const afterIdx = toml.indexOf("[mcp_servers.after]");
  assert.ok(afterIdx !== -1);
  assert.match(toml.slice(afterIdx), /args = \["after\.js"\]/);
});

test("install: running twice is idempotent (still exactly one coeiroink block)", () => {
  runInstall();
  runInstall();
  const toml = readToml();
  const count = (toml.match(/\[mcp_servers\.coeiroink\]/g) ?? []).length;
  assert.equal(count, 1);
});

test("uninstall: removes the coeiroink block and its nested child tables, leaves unrelated sections", () => {
  fs.writeFileSync(
    configTomlPath,
    [
      'model = "gpt-5.6-sol"',
      "",
      "[mcp_servers.coeiroink]",
      'command = "node"',
      'args = ["a.js"]',
      "",
      "[mcp_servers.coeiroink.env]",
      'SOME_KEY = "some_value"',
      "",
      "[mcp_servers.after]",
      'command = "node"',
      'args = ["after.js"]',
      "",
    ].join("\n")
  );
  runUninstall();
  const toml = readToml();
  assert.doesNotMatch(toml, /\[mcp_servers\.coeiroink\]/);
  assert.doesNotMatch(toml, /\[mcp_servers\.coeiroink\.env\]/);
  assert.match(toml, /\[mcp_servers\.after\]/);
});

test("uninstall: does not remove a similarly-named-but-unrelated section", () => {
  fs.writeFileSync(
    configTomlPath,
    ["[mcp_servers.coeiroink]", 'command = "node"', 'args = ["a.js"]', "", "[mcp_servers.coeiroink_other]", 'command = "node"', 'args = ["b.js"]', ""].join(
      "\n"
    )
  );
  runUninstall();
  const toml = readToml();
  assert.doesNotMatch(toml, /\[mcp_servers\.coeiroink\]/);
  assert.match(toml, /\[mcp_servers\.coeiroink_other\]/);
});

test("uninstall: is a no-op (does not throw) when there is nothing to remove", () => {
  assert.doesNotThrow(() => runUninstall());
  assert.equal(fs.existsSync(configTomlPath), false);
});

// ---- config.tomlの原子的書き込み(タスク8)のスクリプト経由での回帰テスト ----
// scripts/atomic-write-file.mjs自体のfsyncSync等直接呼び出しでの検証はtest/atomic-write-file.test.mjsに
// 既にあるが、ここではinstall-codex.mjs/uninstall-codex.mjsという実スクリプトを実subprocessとして
// 起動したまま(fault-inject-fs.mjsをpreloadすることでプロセス境界を越えて)一時ファイル書き込み・
// fsync・rename各段階の障害注入を再現し、実際の書き込み経路の配線ごと検証する。

test("install: successful run leaves no config.toml.tmp-* leftover", () => {
  runInstall();
  assert.deepEqual(listTmpLeftovers(), []);
});

test("uninstall: successful run leaves no config.toml.tmp-* leftover", () => {
  runInstall();
  runUninstall();
  assert.deepEqual(listTmpLeftovers(), []);
});

for (const step of ["write", "fsync", "rename"]) {
  test(`install: a failure during the ${step} step of the atomic write leaves a pre-existing config.toml byte-for-byte unchanged, and no tmp file behind`, () => {
    // 事前に無関係な既存セクションを含むconfig.tomlを作っておき、破損しないことを確認する
    const before = ['model = "gpt-5.6-sol"', "", "[mcp_servers.other_server]", 'command = "node"', 'args = ["other.js"]', ""].join("\n");
    fs.writeFileSync(configTomlPath, before);

    assert.throws(() => runInstallWithFault(step));

    assert.equal(readToml(), before, "the pre-existing config.toml must be byte-for-byte unchanged");
    assert.deepEqual(listTmpLeftovers(), [], "the failed temp file must not be left behind");
  });

  test(`uninstall: a failure during the ${step} step of the atomic write leaves the coeiroink block intact (not partially removed), and no tmp file behind`, () => {
    runInstall();
    const before = readToml();
    assert.match(before, /\[mcp_servers\.coeiroink\]/);

    assert.throws(() => runUninstallWithFault(step));

    assert.equal(readToml(), before, "config.toml must be byte-for-byte unchanged; the block must not be half-removed");
    assert.deepEqual(listTmpLeftovers(), [], "the failed temp file must not be left behind");
  });
}

// `npm install -g`経由でインストールされたcodexはcodex.cmd(バッチファイル)になる。Node.jsの仕様
// (CVE-2024-27980対応)により、shellを介さずには直接実行できないため、以前はこの経路が常に失敗し
// TOML直接編集フォールバックに落ちていた(Windows専用の問題なので他OSではスキップする)。
(process.platform === "win32" ? test : test.skip)(
  "install: on Windows, a codex.cmd shim on PATH (npm-style install) is actually invoked instead of always falling back to TOML editing",
  () => {
    const fakeCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-fake-codex-"));
    const callLogPath = path.join(fakeCodexDir, "calls.log");
    fs.writeFileSync(
      path.join(fakeCodexDir, "codex.cmd"),
      ["@echo off", 'echo %* >> "%CODEX_CALL_LOG%"', "exit /b 0", ""].join("\r\n")
    );

    execFileSync("node", [installScript], {
      env: {
        ...process.env,
        CODEX_HOME: tmpHome,
        PATH: `${fakeCodexDir};${fallbackPath}`,
        CODEX_CALL_LOG: callLogPath,
      },
      encoding: "utf8",
    });

    const calls = fs.readFileSync(callLogPath, "utf8");
    // 各引数は環境変数経由の"%VARNAME%"展開で渡される(値自体に%や&|<>^!等のcmd.exeメタ文字が
    // あっても安全に1引数として届けるため)ため、バッチの%*が見る時点で個別にダブルクオート
    // されている。
    assert.match(
      calls,
      /"mcp" "add" "coeiroink" "--" "node"/,
      "the fake codex.cmd should have been invoked with the expected args"
    );
    assert.equal(fs.existsSync(configTomlPath), false, "the TOML fallback must not run once the CLI path succeeds");

    fs.rmSync(fakeCodexDir, { recursive: true, force: true });
  }
);

// パスの一部がたまたま実在する環境変数名(例: %PATH%)と一致すると、cmd.exeの%展開が
// 二重引用符の中でも作動してしまい、そのパスの断片が丸ごとPATH環境変数の値へ無警告で
// 置き換わることを実測で確認した(Codex stop-time reviewの指摘)。install-codex.mjsは
// 自分のディレクトリ配下のdist/index.jsを対象とするため、"%PATH%"という文字列を含む
// ディレクトリ名を持つ一時ディレクトリへスクリプト一式をコピーしてから実行することで再現する。
(process.platform === "win32" ? test : test.skip)(
  "install: a distIndexPath containing a literal %VAR%-looking substring is delivered verbatim, not expanded as an environment variable",
  () => {
    const scriptsSrcDir = path.dirname(installScript);
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-%PATH%-test-"));
    const projScriptsDir = path.join(projDir, "scripts");
    fs.mkdirSync(projScriptsDir, { recursive: true });
    for (const name of ["install-codex.mjs", "atomic-write-file.mjs", "codex-cli-runner.mjs"]) {
      fs.copyFileSync(path.join(scriptsSrcDir, name), path.join(projScriptsDir, name));
    }
    const projDistDir = path.join(projDir, "dist");
    fs.mkdirSync(projDistDir, { recursive: true });
    fs.writeFileSync(path.join(projDistDir, "index.js"), "// dummy build artifact for testing\n");
    const copiedInstallScript = path.join(projScriptsDir, "install-codex.mjs");
    const expectedDistIndexPath = path.join(projDistDir, "index.js");
    assert.match(expectedDistIndexPath, /%PATH%/, "precondition: the copied dist/index.js path must contain a literal %PATH%-looking substring");

    const fakeCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-fake-codex-argv-"));
    const argvLogPath = path.join(fakeCodexDir, "argv.json");
    fs.writeFileSync(
      path.join(fakeCodexDir, "codex-logger.mjs"),
      "import fs from 'node:fs';\nfs.writeFileSync(process.env.CODEX_ARGV_LOG, JSON.stringify(process.argv.slice(2)));\n"
    );
    fs.writeFileSync(
      path.join(fakeCodexDir, "codex.cmd"),
      ["@echo off", `node "%~dp0codex-logger.mjs" %*`, "exit /b 0", ""].join("\r\n")
    );

    execFileSync("node", [copiedInstallScript], {
      env: {
        ...process.env,
        CODEX_HOME: tmpHome,
        PATH: `${fakeCodexDir};${fallbackPath}`,
        CODEX_ARGV_LOG: argvLogPath,
      },
      encoding: "utf8",
    });

    const receivedArgv = JSON.parse(fs.readFileSync(argvLogPath, "utf8"));
    assert.deepEqual(
      receivedArgv,
      ["mcp", "add", "coeiroink", "--", "node", expectedDistIndexPath],
      "the %PATH%-looking substring must arrive verbatim, not expanded into the real PATH environment variable's value"
    );
    assert.equal(fs.existsSync(configTomlPath), false, "the TOML fallback must not run once the CLI path succeeds");

    fs.rmSync(projDir, { recursive: true, force: true });
    fs.rmSync(fakeCodexDir, { recursive: true, force: true });
  }
);

// execFileSync(..., {shell:true})にargs配列を渡すと(旧codex.cmd起動経路がそうしていたように)、
// Node自身は引数を一切エスケープせず単純にスペースで連結するだけなので、Node 24でDEP0190警告が
// 出る(このバグ自体がスペースを含むパスでの引数分割崩壊の根本原因でもあった)。単一のコマンド
// 文字列として渡す新方式でこの警告が消えたことを、spawnSyncでstderrを直接検査して確認する
// (execFileSyncのencoding:"utf8"戻り値はstdoutのみのため、stderrを個別取得できるspawnSyncを使う)。
(process.platform === "win32" ? test : test.skip)(
  "install: the codex.cmd shell fallback no longer emits a DEP0190 deprecation warning",
  () => {
    const fakeCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-fake-codex-"));
    fs.writeFileSync(path.join(fakeCodexDir, "codex.cmd"), ["@echo off", "exit /b 0", ""].join("\r\n"));

    const result = spawnSync(process.execPath, [installScript], {
      env: { ...process.env, CODEX_HOME: tmpHome, PATH: `${fakeCodexDir};${fallbackPath}` },
      encoding: "utf8",
    });

    assert.doesNotMatch(result.stderr, /DEP0190/, `expected no DEP0190 warning, got stderr: ${result.stderr}`);

    fs.rmSync(fakeCodexDir, { recursive: true, force: true });
  }
);

// スペースを含むインストールパス(`C:\Program Files\...`等)で、旧execFileSync(cmd, args, {shell:true})
// 方式(argsを単純にスペース連結)は引数の区切りが壊れ、codex.cmd(実際にはNode製のfakeシム経由で
// process.argvを記録する)側が「1つの引数として渡された完全なパス」ではなく「スペースで分割された
// 複数の引数」を受け取ってしまう(実際のcodexバイナリなら想定外の引数でexit非0になりうるが、
// たまたまexit 0を返せば「登録は失敗しているのに成功と報告される」ことになる)。install-codex.mjs
// 自体は自分のディレクトリ配下のdist/index.jsを対象とするため、スクリプト一式をスペースを含む
// 一時ディレクトリへコピーしてから実行することで、実際のスペース入りパスを再現する。
(process.platform === "win32" ? test : test.skip)(
  "install: a distIndexPath containing a space is delivered to codex.cmd as a single argument, not split apart",
  () => {
    const scriptsSrcDir = path.dirname(installScript);
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink mcp space test-"));
    const projScriptsDir = path.join(projDir, "scripts");
    fs.mkdirSync(projScriptsDir, { recursive: true });
    for (const name of ["install-codex.mjs", "atomic-write-file.mjs", "codex-cli-runner.mjs"]) {
      fs.copyFileSync(path.join(scriptsSrcDir, name), path.join(projScriptsDir, name));
    }
    const projDistDir = path.join(projDir, "dist");
    fs.mkdirSync(projDistDir, { recursive: true });
    fs.writeFileSync(path.join(projDistDir, "index.js"), "// dummy build artifact for testing\n");
    const copiedInstallScript = path.join(projScriptsDir, "install-codex.mjs");
    const expectedDistIndexPath = path.join(projDistDir, "index.js");
    assert.match(expectedDistIndexPath, /\s/, "precondition: the copied dist/index.js path must actually contain a space");

    const fakeCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-fake-codex-argv-"));
    const argvLogPath = path.join(fakeCodexDir, "argv.json");
    fs.writeFileSync(
      path.join(fakeCodexDir, "codex-logger.mjs"),
      "import fs from 'node:fs';\nfs.writeFileSync(process.env.CODEX_ARGV_LOG, JSON.stringify(process.argv.slice(2)));\n"
    );
    fs.writeFileSync(
      path.join(fakeCodexDir, "codex.cmd"),
      ["@echo off", `node "%~dp0codex-logger.mjs" %*`, "exit /b 0", ""].join("\r\n")
    );

    execFileSync("node", [copiedInstallScript], {
      env: {
        ...process.env,
        CODEX_HOME: tmpHome,
        PATH: `${fakeCodexDir};${fallbackPath}`,
        CODEX_ARGV_LOG: argvLogPath,
      },
      encoding: "utf8",
    });

    const receivedArgv = JSON.parse(fs.readFileSync(argvLogPath, "utf8"));
    assert.deepEqual(
      receivedArgv,
      ["mcp", "add", "coeiroink", "--", "node", expectedDistIndexPath],
      "the spaced path must arrive as exactly one array element, not split at the space"
    );
    assert.equal(fs.existsSync(configTomlPath), false, "the TOML fallback must not run once the CLI path succeeds");

    fs.rmSync(projDir, { recursive: true, force: true });
    fs.rmSync(fakeCodexDir, { recursive: true, force: true });
  }
);

// runCodexCliのcmd.exeシェル経由の起動は、引数を渡す一時トランポリンをinvokeBaseDir
// (COEIROINK_MCP_CODEX_INVOKE_DIRで差し替え可能。既定は~/.coeiroink-mcp/codex-invoke)配下の
// 専用ディレクトリに生成する。**2026-08-04の統合改修プラン タスク2で、共有os.tmpdir()から
// この専用ディレクトリへ移した**(理由: %TEMP%は非ユーザーSID複数がModify権限を持ち、新規
// サブディレクトリにも継承されるため、TEMP内に専用ディレクトリを作るだけでは書き込み権限は
// 減らない。タスク1でcodex.cmd自体の解決は塞いだが、トランポリン自身の内容は書き込みから
// 実行までの間に差し替えられる経路が残っていた)。移設前はTEMP/TMPでこの一連のケースを
// 再現していたが、移設後はTEMP/TMPを差し替えてもトランポリンの置き場所には一切影響しない
// ため、以下は全てCOEIROINK_MCP_CODEX_INVOKE_DIRを差し替える形に retarget してある。invokeBaseDir
// 自体に問題のある文字を含む環境では、生成したトランポリンのパスを経由してcmd.exeの
// コマンドライン解釈に影響しうる。単に「installが成功したか」だけでは、overrideが無視されて
// 既定のホームディレクトリ配下が黙って使われていても見かけ上は同じく成功してしまう(=配線の
// 証拠にならない)ため、(1)override配下に実際にディレクトリが作られたこと(existsSync)、
// (2)fakeなcodex.cmdの%CD%(トランポリンのcwdから継承される)がoverride配下であること、の
// 両方を検証してoverrideが実際に配線されていることを確認する。
function testInstallSucceedsWithInvokeBaseDir(testTitle, dirSuffix) {
  (process.platform === "win32" ? test : test.skip)(testTitle, () => {
    const invokeParent = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-weird-invokedir-parent-"));
    const weirdInvokeBaseDir = path.join(invokeParent, dirSuffix);
    // ここでは事前にmkdirしない: 実装側のfs.mkdirSync(invokeBaseDir, {recursive:true})が
    // このパスを実際に作成すること自体を「overrideが効いている証拠」として使うため。

    const fakeCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-fake-codex-"));
    const callLogPath = path.join(fakeCodexDir, "calls.log");
    const cwdLogPath = path.join(fakeCodexDir, "cwd.log");
    fs.writeFileSync(
      path.join(fakeCodexDir, "codex.cmd"),
      ["@echo off", 'echo %* >> "%CODEX_CALL_LOG%"', 'echo %CD% >> "%CODEX_CWD_LOG%"', "exit /b 0", ""].join("\r\n")
    );

    try {
      execFileSync("node", [installScript], {
        env: {
          ...process.env,
          CODEX_HOME: tmpHome,
          PATH: `${fakeCodexDir};${fallbackPath}`,
          CODEX_CALL_LOG: callLogPath,
          CODEX_CWD_LOG: cwdLogPath,
          COEIROINK_MCP_CODEX_INVOKE_DIR: weirdInvokeBaseDir,
        },
        encoding: "utf8",
      });

      const calls = fs.readFileSync(callLogPath, "utf8");
      assert.match(calls, /"mcp" "add" "coeiroink" "--" "node"/, "the fake codex.cmd should have been invoked with the expected args");
      assert.equal(fs.existsSync(configTomlPath), false, "the TOML fallback must not run once the CLI path succeeds");
      assert.equal(
        fs.existsSync(weirdInvokeBaseDir),
        true,
        "the overridden invoke-base directory must actually have been created (proves COEIROINK_MCP_CODEX_INVOKE_DIR was honored, not silently ignored)"
      );
      const cwd = fs.readFileSync(cwdLogPath, "utf8").trim().toLowerCase();
      assert.ok(
        cwd.startsWith(weirdInvokeBaseDir.toLowerCase()),
        `the trampoline's cwd "${cwd}" must be a subdirectory of the overridden invoke-base dir "${weirdInvokeBaseDir}"`
      );
      assert.deepEqual(
        fs.readdirSync(weirdInvokeBaseDir),
        [],
        "the per-run invocation directory must be cleaned up"
      );
    } finally {
      fs.rmSync(invokeParent, { recursive: true, force: true });
      fs.rmSync(fakeCodexDir, { recursive: true, force: true });
    }
  });
}

// (a) invokeBaseDirがスペースを含むパス(例: `C:\Users\John Doe\...`)にある環境では、生成される
// トランポリンのパス自体にスペースが含まれ、execFileSync(file, args, {shell:true})がfile側も
// argsと同様に一切エスケープしないため、cmd.exeがスペースの手前までしか実行対象と認識できず
// 登録処理自体が失敗しうる(元々はos.tmpdir()に対してCodex stop-time reviewが実測発見・再現した
// 不具合。タスク2でトランポリンの置き場所自体が変わったため、同じ懸念をCOEIROINK_MCP_CODEX_INVOKE_DIR
// に対して再検証する)。
testInstallSucceedsWithInvokeBaseDir(
  "install: succeeds via the codex.cmd shell fallback even when COEIROINK_MCP_CODEX_INVOKE_DIR itself contains a space",
  "spaced invoke dir"
);

// (b) 同じ理由で、invokeBaseDirが%PATH%のような実在の環境変数名と一致する文字列を含む場合も
// 検証する(cwdオプションはcmd.exeのテキスト解釈対象にならないため%展開の影響を受けないはず、
// という設計が新しい置き場所でも成立していることの確認)。
testInstallSucceedsWithInvokeBaseDir(
  "install: succeeds via the codex.cmd shell fallback even when COEIROINK_MCP_CODEX_INVOKE_DIR contains a %VAR%-looking substring",
  "coeiroink-mcp-%PATH%-invokedir"
);

// (c) 同じ理由で、invokeBaseDirが!VAR!(遅延展開)形式の文字列を含む場合も検証する。
testInstallSucceedsWithInvokeBaseDir(
  "install: succeeds via the codex.cmd shell fallback even when COEIROINK_MCP_CODEX_INVOKE_DIR contains a !VAR!-looking substring",
  "coeiroink-mcp-!SECRETVAR!-invokedir"
);

// (d) cwd方式はcmd.exeがUNCパスをカレントディレクトリとして扱えない仕様のため、invokeBaseDir
// 自体がUNCパス(例: `\\server\share\...`。ローミングプロファイル等でホームディレクトリが
// ネットワーク共有になっていると起こりうる)だと、cwdが黙って`C:\Windows`等へ差し替わり登録
// 処理自体が失敗しうる(元々はos.tmpdir()に対する不具合として発見されたが、タスク2でトランポリン
// の置き場所自体が変わったため、同じ懸念をCOEIROINK_MCP_CODEX_INVOKE_DIRに対して再検証する)。
// 管理共有(\\localhost\<ドライブ文字>$)を使ってUNCパスを作り再現する(管理共有が無効化されている
// 環境では意味のある検証にならないためグレースフルにスキップする)。UNCではcwdオプションを使わず
// 絶対パス+環境変数参照にフォールバックするため(isUncPath分岐)、%CD%はトランポリンのcwdを
// 反映しない。代わりに、override配下に実際にディレクトリが作られたことをexistsSyncで確認する。
function toLocalhostUncPath(localPath) {
  const match = /^([A-Za-z]):\\(.*)$/.exec(localPath);
  return match ? `\\\\localhost\\${match[1]}$\\${match[2]}` : null;
}

(process.platform === "win32" ? test : test.skip)(
  "install: succeeds via the codex.cmd shell fallback even when COEIROINK_MCP_CODEX_INVOKE_DIR is a UNC path",
  (t) => {
    const uncBase = toLocalhostUncPath(os.tmpdir());
    if (!uncBase) {
      t.skip("os.tmpdir() is not a simple drive-letter path; cannot derive a UNC equivalent");
      return;
    }
    const uncInvokeBaseDir = path.join(uncBase, `coeiroink-mcp-unc-invokedir-${randomUUID()}`);
    try {
      fs.mkdirSync(uncInvokeBaseDir, { recursive: true });
      fs.rmSync(uncInvokeBaseDir, { recursive: true, force: true }); // 到達性のプローブのみ。実際の作成は対象コードに行わせる。
    } catch (e) {
      t.skip(`administrative share not reachable in this environment: ${e.message}`);
      return;
    }

    const fakeCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-fake-codex-"));
    const callLogPath = path.join(fakeCodexDir, "calls.log");
    fs.writeFileSync(
      path.join(fakeCodexDir, "codex.cmd"),
      ["@echo off", 'echo %* >> "%CODEX_CALL_LOG%"', "exit /b 0", ""].join("\r\n")
    );

    try {
      execFileSync("node", [installScript], {
        env: {
          ...process.env,
          CODEX_HOME: tmpHome,
          PATH: `${fakeCodexDir};${fallbackPath}`,
          CODEX_CALL_LOG: callLogPath,
          COEIROINK_MCP_CODEX_INVOKE_DIR: uncInvokeBaseDir,
        },
        encoding: "utf8",
      });

      const calls = fs.readFileSync(callLogPath, "utf8");
      assert.match(calls, /"mcp" "add" "coeiroink" "--" "node"/, "the fake codex.cmd should have been invoked with the expected args");
      assert.equal(fs.existsSync(configTomlPath), false, "the TOML fallback must not run once the CLI path succeeds");
      assert.equal(
        fs.existsSync(uncInvokeBaseDir),
        true,
        "the overridden UNC invoke-base directory must actually have been created (proves the override was honored, not silently ignored)"
      );
      assert.deepEqual(fs.readdirSync(uncInvokeBaseDir), [], "the per-run invocation directory must be cleaned up");
    } finally {
      fs.rmSync(uncInvokeBaseDir, { recursive: true, force: true });
      fs.rmSync(fakeCodexDir, { recursive: true, force: true });
    }
  }
);

// (e) isUncPathは当初"\\"接頭辞のみを見ていたが、Windowsはパス区切りとして"\"と"/"のどちらも
// 受け付けるため、invokeBaseDirが"//server/share/..."というフォワードスラッシュ形式のUNCパスに
// なっている場合を見落とし、cwd分岐へ誤って進んで同じ起動失敗を起こしうる。
(process.platform === "win32" ? test : test.skip)(
  "install: succeeds via the codex.cmd shell fallback even when COEIROINK_MCP_CODEX_INVOKE_DIR is a forward-slash UNC path",
  (t) => {
    const uncBase = toLocalhostUncPath(os.tmpdir());
    if (!uncBase) {
      t.skip("os.tmpdir() is not a simple drive-letter path; cannot derive a UNC equivalent");
      return;
    }
    const uncInvokeBaseDir = path.join(uncBase, `coeiroink-mcp-fwdslash-unc-invokedir-${randomUUID()}`);
    try {
      fs.mkdirSync(uncInvokeBaseDir, { recursive: true });
      fs.rmSync(uncInvokeBaseDir, { recursive: true, force: true }); // 到達性のプローブのみ。実際の作成は対象コードに行わせる。
    } catch (e) {
      t.skip(`administrative share not reachable in this environment: ${e.message}`);
      return;
    }
    // overrideへはフォワードスラッシュ形式で渡す(os.tmpdir()がTEMP/TMPを正規化せずそのまま
    // 返すのと同様、この環境変数もアプリ側で正規化していないことを模す)。
    const uncInvokeBaseDirForwardSlash = uncInvokeBaseDir.replace(/\\/g, "/");

    const fakeCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-fake-codex-"));
    const callLogPath = path.join(fakeCodexDir, "calls.log");
    fs.writeFileSync(
      path.join(fakeCodexDir, "codex.cmd"),
      ["@echo off", 'echo %* >> "%CODEX_CALL_LOG%"', "exit /b 0", ""].join("\r\n")
    );

    try {
      execFileSync("node", [installScript], {
        env: {
          ...process.env,
          CODEX_HOME: tmpHome,
          PATH: `${fakeCodexDir};${fallbackPath}`,
          CODEX_CALL_LOG: callLogPath,
          COEIROINK_MCP_CODEX_INVOKE_DIR: uncInvokeBaseDirForwardSlash,
        },
        encoding: "utf8",
      });

      const calls = fs.readFileSync(callLogPath, "utf8");
      assert.match(calls, /"mcp" "add" "coeiroink" "--" "node"/, "the fake codex.cmd should have been invoked with the expected args");
      assert.equal(fs.existsSync(configTomlPath), false, "the TOML fallback must not run once the CLI path succeeds");
      assert.equal(
        fs.existsSync(uncInvokeBaseDir),
        true,
        "the overridden UNC invoke-base directory must actually have been created (proves the override was honored, not silently ignored)"
      );
      assert.deepEqual(fs.readdirSync(uncInvokeBaseDir), [], "the per-run invocation directory must be cleaned up");
    } finally {
      fs.rmSync(uncInvokeBaseDir, { recursive: true, force: true });
      fs.rmSync(fakeCodexDir, { recursive: true, force: true });
    }
  }
);
