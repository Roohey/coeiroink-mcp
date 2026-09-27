#!/usr/bin/env node
// install-codex.mjs で登録したcoeiroink-mcpのCodex CLI登録を解除する。
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write-file.mjs";
import { runCodexCli } from "./codex-cli-runner.mjs";

const SERVER_NAME = "coeiroink";
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CONFIG_TOML_PATH = path.join(CODEX_HOME, "config.toml");

function tryCodexCli() {
  return runCodexCli(["mcp", "remove", SERVER_NAME]);
}

// "[mcp_servers.coeiroink]" や "[[mcp_servers.coeiroink.env]]" のようなセクション見出し行から
// テーブル名(角括弧と前後の空白を除いた部分)を取り出す。セクション見出しでなければnull。
function sectionNameOf(line) {
  const match = line.trim().match(/^\[+\s*([^\[\]]+?)\s*\]+$/);
  return match ? match[1] : null;
}

function removeTomlFallback() {
  if (!existsSync(CONFIG_TOML_PATH)) {
    console.log("config.tomlが見つかりません。何もしませんでした。");
    return;
  }
  const original = readFileSync(CONFIG_TOML_PATH, "utf8");
  const parentName = `mcp_servers.${SERVER_NAME}`;
  const lines = original.split(/\r?\n/);
  const headerIdx = lines.findIndex((line) => sectionNameOf(line) === parentName);
  if (headerIdx === -1) {
    console.log(`[mcp_servers.${SERVER_NAME}] は見つかりませんでした。何もしませんでした。`);
    return;
  }
  // [mcp_servers.coeiroink.env] のような子テーブルも本体の一部として一緒に削除する。
  // それ以外の(無関係な)セクションに到達したら止める。args = ["..."] のように行の途中に
  // [が現れる行はセクション見出しと判定されないので対象にしない。
  let endIdx = headerIdx + 1;
  while (endIdx < lines.length) {
    const name = sectionNameOf(lines[endIdx]);
    if (name !== null && name !== parentName && !name.startsWith(`${parentName}.`)) break;
    endIdx++;
  }
  const result = [...lines.slice(0, headerIdx), ...lines.slice(endIdx)];
  writeFileAtomic(CONFIG_TOML_PATH, result.join("\n"));
  console.log(`config.toml から [mcp_servers.${SERVER_NAME}] を削除しました: ${CONFIG_TOML_PATH}`);
}

console.log(`coeiroink-mcp のCodex CLI登録を解除します。`);
if (tryCodexCli()) {
  console.log("`codex mcp remove` で解除しました。");
} else {
  console.log("`codex mcp remove` が使えなかったため、config.tomlを直接編集します。");
  removeTomlFallback();
}
