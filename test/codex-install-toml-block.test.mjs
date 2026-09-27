// scripts/install-codex.mjsのbuildMcpServerBlockLines単体テスト。config.tomlフォールバックへ
// 書き出すargs行のエスケープ(旧N9: 従来はバックスラッシュのみ対応で"や制御文字を考慮していな
// かった)を検証する。Windowsのファイルパスには"や大半の制御文字を含められない(実ファイルを
// 作れない)ため、実ファイルシステムに依存せず任意の文字列で検証できる純粋関数として
// install-codex.mjs側で切り出してある。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMcpServerBlockLines } from "../scripts/install-codex.mjs";

test("buildMcpServerBlockLines: a plain Windows path with backslashes is escaped correctly", () => {
  const lines = buildMcpServerBlockLines("coeiroink", "C:\\Users\\gumi\\coeiroink-mcp\\dist\\index.js");
  const argsLine = lines.find((l) => l.startsWith("args ="));
  assert.equal(argsLine, 'args = ["C:\\\\Users\\\\gumi\\\\coeiroink-mcp\\\\dist\\\\index.js"]');
});

test("buildMcpServerBlockLines: a path containing a double quote is escaped (macOS/Linux path, not representable on Windows)", () => {
  const lines = buildMcpServerBlockLines("coeiroink", '/home/gumi/weird"path/dist/index.js');
  const argsLine = lines.find((l) => l.startsWith("args ="));
  assert.equal(argsLine, 'args = ["/home/gumi/weird\\"path/dist/index.js"]');
});

test("buildMcpServerBlockLines: a path containing control characters (newline/tab) is escaped instead of producing invalid TOML", () => {
  const lines = buildMcpServerBlockLines("coeiroink", "/home/gumi/weird\npath\twith\rcontrol/dist/index.js");
  const argsLine = lines.find((l) => l.startsWith("args ="));
  // 生の改行/タブ/CRが1行のTOML args行に紛れ込んでいない(すべて\n/\t/rへエスケープ済み)ことを確認する
  assert.equal(argsLine.includes("\n"), false);
  assert.equal(argsLine.includes("\t"), false);
  assert.match(argsLine, /\\n/);
  assert.match(argsLine, /\\t/);
  assert.match(argsLine, /\\r/);
});

test("buildMcpServerBlockLines: the escaped args line round-trips back to the original path when parsed as JSON", () => {
  const original = 'C:\\weird "quoted"\\path\nwith\tcontrol\\index.js';
  const lines = buildMcpServerBlockLines("coeiroink", original);
  const argsLine = lines.find((l) => l.startsWith("args ="));
  const jsonArrayText = argsLine.slice("args = ".length);
  const [roundTripped] = JSON.parse(jsonArrayText);
  assert.equal(roundTripped, original);
});

test("buildMcpServerBlockLines: includes the expected header/command/timeout lines", () => {
  const lines = buildMcpServerBlockLines("coeiroink", "C:\\index.js");
  assert.deepEqual(lines.slice(0, 2), ["[mcp_servers.coeiroink]", 'command = "node"']);
  assert.equal(lines[3], "startup_timeout_sec = 20");
});
