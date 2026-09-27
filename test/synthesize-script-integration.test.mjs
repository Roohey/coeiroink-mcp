import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeEngine, startMcpServer, buildMinimalWav } from "./mcp-client-helper.mjs";

function listStagingDirs() {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("coeiroink-script-staging-"));
}

async function callSynthesizeScript(client, args) {
  const result = await client.callTool({ name: "synthesize_script", arguments: args });
  const text = result.content?.[0]?.text ?? "";
  return { isError: result.isError === true, text, parsed: result.isError ? undefined : JSON.parse(text) };
}

test("synthesize_script: rejects a non-empty existing outputDir without touching it or leaking a staging dir", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const outputDir = path.join(mcp.tmpRoot, "reused-dir");
  fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, "leftover.txt"), "do not touch me");

  const before = listStagingDirs();
  const res = await callSynthesizeScript(mcp.client, {
    script: "テスト話者A,こんにちは",
    outputDir,
  });

  assert.equal(res.isError, true);
  assert.match(res.text, /空ではありません/);
  assert.deepEqual(fs.readdirSync(outputDir), ["leftover.txt"], "existing directory must be untouched");
  assert.equal(fs.readFileSync(path.join(outputDir, "leftover.txt"), "utf8"), "do not touch me");
  assert.deepEqual(listStagingDirs(), before, "no staging directory should be left behind for a rejected call");
});

test("synthesize_script: publishes into a fresh (non-existent) outputDir and leaves no staging directory behind", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const outputDir = path.join(mcp.tmpRoot, "brand-new-dir");
  const before = listStagingDirs();
  const res = await callSynthesizeScript(mcp.client, {
    script: "テスト話者A,こんにちは\nテスト話者B,元気ですか",
    outputDir,
  });

  assert.equal(res.isError, false, res.text);
  assert.equal(res.parsed.outputDir, outputDir);
  assert.equal(res.parsed.lineCount, 2);
  const files = fs.readdirSync(outputDir).sort();
  assert.deepEqual(files, ["001-テスト話者A.wav", "002-テスト話者B.wav", "manifest.json"]);
  const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf8"));
  assert.equal(manifest.lines.length, 2);
  assert.deepEqual(listStagingDirs(), before, "staging directory must be cleaned up after a successful publish");
});

test("synthesize_script: an empty pre-existing outputDir is accepted", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const outputDir = path.join(mcp.tmpRoot, "empty-existing-dir");
  fs.mkdirSync(outputDir);
  const res = await callSynthesizeScript(mcp.client, { script: "テスト話者A,こんにちは", outputDir });

  assert.equal(res.isError, false, res.text);
  assert.deepEqual(fs.readdirSync(outputDir).sort(), ["001-テスト話者A.wav", "manifest.json"]);
});

test("synthesize_script: a mid-script synthesis failure leaves an explicit outputDir untouched (no partial files, no staging leak)", async (t) => {
  let callCount = 0;
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      callCount++;
      if (callCount === 2) {
        res.writeHead(500).end("boom");
        return;
      }
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(buildMinimalWav());
    },
  });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const outputDir = path.join(mcp.tmpRoot, "never-created-dir");
  const before = listStagingDirs();
  const res = await callSynthesizeScript(mcp.client, {
    script: "テスト話者A,一行目\nテスト話者B,二行目(ここで失敗する)\nテスト話者A,三行目",
    outputDir,
  });

  assert.equal(res.isError, true);
  assert.equal(fs.existsSync(outputDir), false, "outputDir must never be created when synthesis fails partway");
  assert.deepEqual(listStagingDirs(), before, "no staging directory should be left behind on failure");
});

test("synthesize_script: rejects a script exceeding the line-count limit before synthesizing anything", async (t) => {
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

  const script = Array.from({ length: 501 }, (_, i) => `テスト話者A,${i}行目`).join("\n");
  const res = await callSynthesizeScript(mcp.client, { script });

  assert.equal(res.isError, true);
  assert.match(res.text, /行数が多すぎます/);
  assert.equal(synthesisCallCount, 0, "must reject before any synthesis request is sent");
});

test("synthesize_script: rejects a relative outputDir instead of resolving it against the server's cwd", async (t) => {
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

  const before = listStagingDirs();
  const res = await callSynthesizeScript(mcp.client, { script: "テスト話者A,こんにちは", outputDir: "relative-dir" });

  assert.equal(res.isError, true);
  assert.match(res.text, /絶対パスで指定/);
  assert.equal(synthesisCallCount, 0, "must reject before any synthesis request is sent");
  assert.equal(fs.existsSync(path.join(mcp.tmpRoot, "relative-dir")), false, "rejected outputDir must not be created");
  assert.deepEqual(listStagingDirs(), before, "no staging directory should be left behind for a rejected call");
});

test("synthesize_script: a regular file created at outputDir mid-synthesis (after the pre-check) is not destroyed at publish time (TOCTOU)", async (t) => {
  const outputDirRef = {};
  let callCount = 0;
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      callCount++;
      if (callCount === 1) {
        // 事前チェック(readdir)はもう通過済み。ここで初めて、合成中にユーザーが
        // outputDirへ通常ファイルを作成した状況を模す。
        fs.writeFileSync(outputDirRef.current, "user data created mid-synthesis, do not touch");
      }
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(buildMinimalWav());
    },
  });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const outputDir = path.join(mcp.tmpRoot, "raced-with-a-file");
  outputDirRef.current = outputDir;
  const before = listStagingDirs();
  const res = await callSynthesizeScript(mcp.client, {
    script: "テスト話者A,一行目\nテスト話者B,二行目",
    outputDir,
  });

  assert.equal(res.isError, true, res.text);
  assert.equal(fs.lstatSync(outputDir).isDirectory(), false, "the racing file must not be replaced by a directory");
  assert.equal(
    fs.readFileSync(outputDir, "utf8"),
    "user data created mid-synthesis, do not touch",
    "the racing file's content must survive untouched"
  );
  assert.deepEqual(listStagingDirs(), before, "no staging directory should be left behind after a rejected publish");
});

test("synthesize_script: rejects a script exceeding the total-character limit before synthesizing anything", async (t) => {
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

  // 2行×25001文字 = 50002文字 > 上限50000文字。行数(500)は超えない。
  const script = `テスト話者A,${"あ".repeat(25001)}\nテスト話者B,${"い".repeat(25001)}`;
  const res = await callSynthesizeScript(mcp.client, { script });

  assert.equal(res.isError, true);
  assert.match(res.text, /合計文字数が多すぎます/);
  assert.equal(synthesisCallCount, 0, "must reject before any synthesis request is sent");
});

test("synthesize_script: two concurrent calls to the same fresh outputDir — the loser's response includes its staging path, and the staged WAVs are still there", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const outputDir = path.join(mcp.tmpRoot, "concurrent-publish-target");
  const before = listStagingDirs();
  const [resA, resB] = await Promise.all([
    callSynthesizeScript(mcp.client, { script: "テスト話者A,一つ目の呼び出し", outputDir }),
    callSynthesizeScript(mcp.client, { script: "テスト話者B,二つ目の呼び出し", outputDir }),
  ]);

  const results = [resA, resB];
  const winners = results.filter((r) => !r.isError);
  const losers = results.filter((r) => r.isError);
  assert.equal(winners.length, 1, `exactly one call must win, got: ${JSON.stringify(results)}`);
  assert.equal(losers.length, 1);
  assert.match(losers[0].text, /同じ出力先へ同時に公開しようとしました/);

  const stagingPathMatch = losers[0].text.match(/合成済みデータは (.+) に残しています。/);
  assert.ok(stagingPathMatch, `loser's error message must include the staging path: ${losers[0].text}`);
  const stagingPath = stagingPathMatch[1];
  assert.equal(fs.existsSync(stagingPath), true, "the losing call's staging directory must survive so the user can recover it");
  const stagedFiles = fs.readdirSync(stagingPath);
  assert.ok(stagedFiles.some((f) => f.endsWith(".wav")), `staging dir must still contain the synthesized WAV: ${stagedFiles}`);
  assert.ok(stagedFiles.includes("manifest.json"));

  // the surviving staging dir is the one loser's leftover — it must not be counted as a "leak" of
  // an unrelated/successful call, but it is intentionally NOT cleaned up here (that is the point).
  const after = listStagingDirs();
  assert.deepEqual(after.filter((d) => !before.includes(d)), [path.basename(stagingPath)]);

  t.after(() => fs.rmSync(stagingPath, { recursive: true, force: true }));
});
