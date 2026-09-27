// index.tsのツールハンドラを本物のMCPプロトコル(stdio)経由で呼び出すための共通ヘルパー。
// index.tsはトップレベルでtransportに接続してしまう(単体importできない)ため、
// ビルド済みdist/index.jsを実際に子プロセスとして起動し、SDKのClientで話しかける。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const distIndexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

/**
 * 偽のCOEIROINK互換HTTPサーバーを起動する。speakersはlist_speakers/synthesize_scriptの
 * 話者解決に使う固定リストを返す。synthesizeHandlerを渡すと/v1/synthesisの挙動をテストごとに
 * カスタマイズできる(遅延・エラー等)。
 */
export function startFakeEngine({ speakers, synthesizeHandler } = {}) {
  const defaultSpeakers = speakers ?? [
    {
      speakerName: "テスト話者A",
      speakerUuid: "uuid-a",
      styles: [{ styleName: "ノーマル", styleId: 0 }],
    },
    {
      speakerName: "テスト話者B",
      speakerUuid: "uuid-b",
      styles: [{ styleName: "ノーマル", styleId: 1 }],
    },
  ];
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/v1/engine_info")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "fake-engine" }));
      return;
    }
    if (req.url?.startsWith("/v1/speakers")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(defaultSpeakers));
      return;
    }
    if (req.url?.startsWith("/v1/synthesis")) {
      if (synthesizeHandler) {
        synthesizeHandler(req, res);
        return;
      }
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(buildMinimalWav());
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** 有効なWAV(RIFF/fmt/data)を最小構成で組み立てる。 */
export function buildMinimalWav(dataSize = 100) {
  const fmtChunk = Buffer.alloc(24);
  fmtChunk.write("fmt ", 0, "ascii");
  fmtChunk.writeUInt32LE(16, 4);
  fmtChunk.writeUInt16LE(1, 8);
  fmtChunk.writeUInt16LE(1, 10); // mono
  fmtChunk.writeUInt32LE(44100, 12);
  fmtChunk.writeUInt32LE(44100 * 2, 16);
  fmtChunk.writeUInt16LE(2, 20);
  fmtChunk.writeUInt16LE(16, 22);
  const dataChunk = Buffer.alloc(8 + dataSize);
  dataChunk.write("data", 0, "ascii");
  dataChunk.writeUInt32LE(dataSize, 4);
  const body = Buffer.concat([fmtChunk, dataChunk]);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + body.length, 4);
  header.write("WAVE", 8, "ascii");
  return Buffer.concat([header, body]);
}

/**
 * dist/index.jsを子プロセスとして起動し、接続済みのMCP Clientを返す。
 * 設定ファイルは一時ディレクトリに隔離し、coeiroinkUrlはfakeEngineBaseUrlを指すリポジトリ
 * 共有設定として渡す。captureStderr:trueを渡すと子プロセスのstderrを蓄積し、返り値の
 * getStderr()で読み取れるようにする(既定はignoreのまま、多くのテストはstderrを見ないため)。
 */
export async function startMcpServer(fakeEngineBaseUrl, { captureStderr = false } = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-integration-"));
  const userConfigDir = path.join(tmpRoot, "user");
  const repoConfigPath = path.join(tmpRoot, "repo-config.json");
  fs.writeFileSync(
    repoConfigPath,
    JSON.stringify({ engine: "coeiroink", coeiroinkUrl: fakeEngineBaseUrl, speakerUuid: "uuid-a", styleId: 0 })
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distIndexPath],
    env: {
      COEIROINK_MCP_CONFIG_DIR: userConfigDir,
      COEIROINK_MCP_REPO_CONFIG_PATH: repoConfigPath,
    },
    // 実リポジトリのディレクトリを子プロセスのcwdとして継承させない。相対パス絡みのツール引数
    // (outputPath/outputDir)をテストする際に、万一検証が漏れていても実プロジェクトのファイルを
    // 書き換えてしまわないようにするため(tmpRoot自体は隔離済みの使い捨てディレクトリ)。
    cwd: tmpRoot,
    stderr: captureStderr ? "pipe" : "ignore",
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  const stderrChunks = [];
  if (captureStderr && transport.stderr) {
    transport.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  }
  return {
    client,
    tmpRoot,
    getStderr: () => Buffer.concat(stderrChunks).toString("utf8"),
    close: async () => {
      await client.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}
