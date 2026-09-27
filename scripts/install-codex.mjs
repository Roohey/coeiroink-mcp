#!/usr/bin/env node
// coeiroink-mcpをCodex CLIに登録する。
// 1. `codex mcp add` サブコマンドが使えればそれを優先して使う。
// 2. 使えない(古いバージョン等)場合は ~/.codex/config.toml を直接、冪等に編集する
//    (既存の [mcp_servers.coeiroink] ブロックがあれば丸ごと置き換え、無ければ追記)。
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileAtomic } from "./atomic-write-file.mjs";
import { runCodexCli } from "./codex-cli-runner.mjs";

const SERVER_NAME = "coeiroink";
const pluginRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const distIndexPath = path.join(pluginRoot, "dist", "index.js");

// テスト/CI向けにCODEX_HOMEの上書きを許可する(Codex CLI自身もこの環境変数を尊重する)
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CONFIG_TOML_PATH = path.join(CODEX_HOME, "config.toml");

function ensureBuilt() {
  if (!existsSync(distIndexPath)) {
    console.error(`ビルド成果物が見つかりません: ${distIndexPath}`);
    console.error("先に `npm run build` を実行してください。");
    process.exit(1);
  }
}

function tryCodexCli() {
  return runCodexCli(["mcp", "add", SERVER_NAME, "--", "node", distIndexPath]);
}

// TOML basic stringのエスケープ規則(\"/\\/\n等)はJSON文字列のそれと互換なので、手書きの
// 正規表現置換(従来はバックスラッシュのみ対応で"や制御文字を考慮していなかった)ではなく
// JSON.stringifyへ委譲する。Windowsのパスに"は含められないため実質的には到達しないが、
// macOS/Linuxではパスに"や制御文字を含められるため必要な修正(旧N9)。単体テスト向けにexportする
// (Windowsではファイルパスに"を含む実ファイルを作れないため、実際のファイルシステムに依存せず
// 任意の文字列で検証できるよう純粋関数として切り出した)。
export function buildMcpServerBlockLines(serverName, indexPath) {
  return [`[mcp_servers.${serverName}]`, `command = "node"`, `args = [${JSON.stringify(indexPath)}]`, `startup_timeout_sec = 20`];
}

function upsertTomlFallback() {
  mkdirSync(CODEX_HOME, { recursive: true });
  const original = existsSync(CONFIG_TOML_PATH) ? readFileSync(CONFIG_TOML_PATH, "utf8") : "";

  const blockLines = buildMcpServerBlockLines(SERVER_NAME, distIndexPath);
  const headerLine = `[mcp_servers.${SERVER_NAME}]`;

  const lines = original.length > 0 ? original.split(/\r?\n/) : [];
  const headerIdx = lines.findIndex((line) => line.trim() === headerLine);

  let result;
  if (headerIdx === -1) {
    // 追記: 末尾の空行を整理してから、空行を1つ挟んで新規セクションを追加する
    result = [...lines];
    while (result.length > 0 && result[result.length - 1] === "") result.pop();
    if (result.length > 0) result.push("");
    result.push(...blockLines, "");
  } else {
    // 置換: 既存の[mcp_servers.coeiroink]セクションを、次の"["始まりの行(=次のセクション)の
    // 手前まで丸ごと入れ替える。args = ["..."] のように行の途中に[が現れる行は対象にしない。
    let endIdx = headerIdx + 1;
    while (endIdx < lines.length && !/^\s*\[/.test(lines[endIdx])) endIdx++;
    const tail = lines.slice(endIdx);
    result = [...lines.slice(0, headerIdx), ...blockLines, ...(tail.length > 0 ? [""] : []), ...tail];
  }

  writeFileAtomic(CONFIG_TOML_PATH, result.join("\n"));
  console.log(`config.toml に [mcp_servers.${SERVER_NAME}] を書き込みました: ${CONFIG_TOML_PATH}`);
}

// テスト(test/codex-install-toml-block.test.mjs)がbuildMcpServerBlockLinesだけを副作用なしで
// importできるよう、CLIとしての実行(codex CLI呼び出し・ファイル書き込み・process.exit)は
// このスクリプトが直接実行された場合(`node install-codex.mjs`)のみ行う。
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  ensureBuilt();
  console.log(`coeiroink-mcp をCodex CLIに登録します(コマンド: node "${distIndexPath}")`);
  if (tryCodexCli()) {
    console.log("`codex mcp add` で登録しました。");
  } else {
    console.log("`codex mcp add` が使えなかったため、config.tomlを直接編集します。");
    upsertTomlFallback();
  }
  console.log("Codexを再起動すると反映されます。");
}
