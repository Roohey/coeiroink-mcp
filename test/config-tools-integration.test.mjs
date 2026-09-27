import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startFakeEngine, startMcpServer } from "./mcp-client-helper.mjs";

/**
 * client.callTool()はSDK内部でJSON.stringify(message)を経由してからワイヤへ送る。
 * JS側で実際にInfinityな数値を保持していても、JSON.stringify(Infinity)は仕様上"null"になる
 * ため、通常の経路では素通りしない(nullはzodのnumber型チェックで普通に弾かれる)。
 * 実際の脆弱性は「ワイヤ上のJSONテキストに1e400のような指数表記の数値リテラルが直接
 * 書かれていた場合、受信側のJSON.parseがIEEE754のオーバーフロー規則でこれをInfinityへ
 * 変換し、そのInfinityがzodのnumber型チェックを通過してしまう」という、JSON.parse自体の
 * 仕様に起因するものなので、これを実際に再現するにはSDKクライアントの通常の
 * シリアライズ経路を経由せず、生のJSON-RPCテキストを子プロセスのstdinへ直接書き込む
 * 必要がある(client.callTool()にInfinityを渡しても、送信前にnullへ潰されてしまい
 * この脆弱性を再現できない)。
 */
function sendRawToolCall(mcp, id, name, rawArgumentsBody) {
  return new Promise((resolve, reject) => {
    const proc = mcp.client.transport._process;
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === id) {
          proc.stdout.off("data", onData);
          clearTimeout(timer);
          resolve(msg);
          return;
        }
      }
    };
    proc.stdout.on("data", onData);
    const raw = `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"${name}","arguments":{${rawArgumentsBody}}}}\n`;
    proc.stdin.write(raw, (err) => {
      if (err) reject(err);
    });
    const timer = setTimeout(() => {
      proc.stdout.off("data", onData);
      reject(new Error("timed out waiting for raw tool call response"));
    }, 5000);
    timer.unref();
  });
}

test("set_default_speaker: an ordinary in-range speedScale is accepted and persisted (sanity check for the new bounds)", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const result = await mcp.client.callTool({ name: "set_default_speaker", arguments: { speedScale: 1.5, persist: true } });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(result.isError, undefined, JSON.stringify(parsed));
  assert.equal(parsed.values.speedScale, 1.5);
});

test("set_default_speaker: speedScale far outside the sane range is rejected by the schema, not silently clamped", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const result = await mcp.client.callTool({ name: "set_default_speaker", arguments: { speedScale: 999, persist: true } });
  assert.equal(result.isError, true);
});

test("set_default_speaker: speedScale:1e400 (a wire-level exponent literal that JSON.parse turns into a real Infinity) is rejected, and the user config file is left untouched", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const userConfigPath = path.join(mcp.tmpRoot, "user", "config.json");
  const before = fs.existsSync(userConfigPath) ? fs.readFileSync(userConfigPath, "utf8") : undefined;

  const response = await sendRawToolCall(mcp, 999001, "set_default_speaker", `"speedScale":1e400,"persist":true`);

  assert.ok(response.result, JSON.stringify(response));
  assert.equal(response.result.isError, true, JSON.stringify(response.result));
  assert.match(response.result.content[0].text, /-32602/, "must be a schema validation rejection, not a normal tool error");
  assert.match(response.result.content[0].text, /finite/i, "must be rejected specifically for not being finite");

  const after = fs.existsSync(userConfigPath) ? fs.readFileSync(userConfigPath, "utf8") : undefined;
  assert.equal(after, before, "the config file must not have been written to");
});

test("set_default_speaker: speedScale:-1e400 (negative Infinity on the wire) is rejected the same way", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const response = await sendRawToolCall(mcp, 999002, "set_default_speaker", `"speedScale":-1e400,"persist":true`);

  assert.ok(response.result, JSON.stringify(response));
  assert.equal(response.result.isError, true, JSON.stringify(response.result));
  assert.match(response.result.content[0].text, /finite/i);
});
