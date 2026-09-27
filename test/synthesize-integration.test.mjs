import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startFakeEngine, startMcpServer, buildMinimalWav } from "./mcp-client-helper.mjs";

async function callSynthesize(client, args) {
  const result = await client.callTool({ name: "synthesize", arguments: args });
  const text = result.content?.[0]?.text ?? "";
  return { isError: result.isError === true, text, parsed: result.isError ? undefined : JSON.parse(text) };
}

test("synthesize: saves a new file at an explicit absolute outputPath", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const outputPath = path.join(mcp.tmpRoot, "out.wav");
  const res = await callSynthesize(mcp.client, { text: "こんにちは", outputPath });

  assert.equal(res.isError, false, res.text);
  assert.equal(res.parsed.filePath, outputPath);
  assert.ok(fs.existsSync(outputPath));
});

test("synthesize: rejects a relative outputPath instead of resolving it against the server's cwd", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const res = await callSynthesize(mcp.client, { text: "こんにちは", outputPath: "package.json" });

  assert.equal(res.isError, true);
  assert.match(res.text, /絶対パスで指定/);
});

test("synthesize: rejects a ../ relative outputPath", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const res = await callSynthesize(mcp.client, { text: "こんにちは", outputPath: "../../escape.wav" });

  assert.equal(res.isError, true);
  assert.match(res.text, /絶対パスで指定/);
});

test("synthesize: rejects a rejected outputPath without creating any directory", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const res = await callSynthesize(mcp.client, { text: "こんにちは", outputPath: "brand-new-subdir/notes.wav" });

  assert.equal(res.isError, true);
  assert.equal(fs.existsSync(path.join(mcp.tmpRoot, "brand-new-subdir")), false, "rejected path must not create directories as a side effect");
});

test("synthesize: refuses to overwrite an existing file at outputPath, content is left untouched", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const outputPath = path.join(mcp.tmpRoot, "victim.txt");
  fs.writeFileSync(outputPath, "sentinel-user-data");

  const res = await callSynthesize(mcp.client, { text: "こんにちは", outputPath });

  assert.equal(res.isError, true);
  assert.match(res.text, /既にファイルが存在します/);
  assert.equal(fs.readFileSync(outputPath, "utf8"), "sentinel-user-data", "existing file content must be unchanged");
});

test("synthesize: parallel calls with no outputPath get unique default paths", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const results = await Promise.all(
    Array.from({ length: 5 }, () => callSynthesize(mcp.client, { text: "こんにちは" }))
  );
  for (const r of results) assert.equal(r.isError, false, r.text);
  const paths = results.map((r) => r.parsed.filePath);
  assert.equal(new Set(paths).size, paths.length, "every parallel default path must be unique");
  for (const p of paths) assert.ok(fs.existsSync(p));
});

test("synthesize: rejects whitespace-only text (including U+3000 full-width space) with a clear error (旧N6)", async (t) => {
  let synthesisCallCount = 0;
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      synthesisCallCount++;
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(buildMinimalWav());
    },
  });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const res = await callSynthesize(mcp.client, { text: "　  　" });

  assert.equal(res.isError, true, res.text);
  assert.match(res.text, /空白文字のみ/);
  assert.equal(synthesisCallCount, 0, "must reject before any synthesis request is sent");
});

test("synthesize: rejects text exceeding the per-call character limit before any synthesis is attempted, and the connection survives", async (t) => {
  let synthesisCallCount = 0;
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      synthesisCallCount++;
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(buildMinimalWav());
    },
  });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  // MAX_SYNTHESIZE_TEXT_CHARS (src/index.ts) is 5,000 — one character over it. Schema-level
  // rejection (zod .max()) resolves as a normal CallToolResult with isError:true (the SDK
  // converts schema validation failures into a tool-level error, not a thrown protocol error).
  const result = await mcp.client.callTool({ name: "synthesize", arguments: { text: "あ".repeat(5_001) } });
  const text = result.content?.[0]?.text ?? "";
  assert.equal(result.isError, true, text);
  assert.match(text, /too_big|at most 5000/);
  assert.equal(synthesisCallCount, 0, "must reject before any synthesis request is sent");

  const tools = await mcp.client.listTools();
  assert.ok(tools.tools.length > 0, "the connection must survive a schema-level rejection");
});

test(
  "synthesize: aborts reading an oversized response mid-stream instead of waiting for the whole body, and creates no output file",
  { timeout: 10_000 },
  async (t) => {
    const engine = await startFakeEngine({
      synthesizeHandler: (req, res) => {
        res.writeHead(200, { "Content-Type": "audio/wav" });
        // MAX_SYNTHESIS_RESPONSE_BYTES (src/tts-engine.ts) is 100MiB. Write 1MiB past it and then
        // deliberately never call res.end() (the connection stays open). If the client streams the
        // body and aborts as soon as the byte count crosses the limit, this resolves quickly without
        // waiting for res.end(). If a regression goes back to buffering the whole body first (e.g.
        // res.arrayBuffer()) before checking its size, this would hang forever waiting for a response
        // that never completes — caught here by the test's own timeout instead of hanging the suite.
        res.write(Buffer.alloc(100 * 1024 * 1024 + 1024 * 1024));
      },
    });
    const mcp = await startMcpServer(engine.baseUrl);
    t.after(async () => {
      await mcp.close();
      await engine.close();
    });

    const outputPath = path.join(mcp.tmpRoot, "too-big.wav");
    const res = await callSynthesize(mcp.client, { text: "こんにちは", outputPath });

    assert.equal(res.isError, true);
    assert.match(res.text, /応答サイズが上限/);
    assert.equal(fs.existsSync(outputPath), false, "no file should be created when the response is rejected");

    const tools = await mcp.client.listTools();
    assert.ok(tools.tools.length > 0, "the connection must survive a tool-level rejection");
  }
);
