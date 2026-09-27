import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeEngine, startMcpServer, buildMinimalWav } from "./mcp-client-helper.mjs";

test("speak (wait:true): a normal completed call reports played:true, interrupted:false, and the full segment count", async (t) => {
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(buildMinimalWav());
    },
  });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const result = await mcp.client.callTool({ name: "speak", arguments: { text: "短いテキストです" } });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(result.isError, undefined);
  assert.equal(parsed.played, true);
  assert.equal(parsed.interrupted, false);
  assert.equal(parsed.interruptedBy, null, "a call that finished normally must not report a spurious interruption reason (タスク6)");
  assert.equal(parsed.segments, 1);
  assert.equal(parsed.segmentsPlayed, 1);
  assert.equal(typeof parsed.speakId, "string", "every speak response must include a speakId (タスク6)");
});

test("speak (wait:true): stop_speaking mid-synthesis reports played:false and interrupted:true instead of a false played:true", async (t) => {
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      // stop_speaking(下で100ms後に発行)より確実に後まで応答しない遅延にする
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(buildMinimalWav());
      }, 3000);
    },
  });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const speakPromise = mcp.client.callTool({
    name: "speak",
    arguments: { text: "一文目です。二文目です。三文目です。" },
  });
  await new Promise((r) => setTimeout(r, 100));
  await mcp.client.callTool({ name: "stop_speaking", arguments: {} });

  const result = await speakPromise;
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(result.isError, undefined, JSON.stringify(parsed));
  assert.equal(parsed.played, false, "no segment should have been enqueued before the interrupt");
  assert.equal(parsed.interrupted, true);
  assert.equal(parsed.interruptedBy, "stop_speaking", "a global (no-args) stop_speaking() must report interruptedBy:'stop_speaking' (タスク6)");
  assert.equal(parsed.segmentsPlayed, 0);
  assert.equal(parsed.segments, 3);
  assert.equal(typeof parsed.speakId, "string");
});

test("speak (wait:true): stop_speaking during real playback (not synthesis) of the only segment reports played:false, interrupted:true, segmentsPlayed:0", async (t) => {
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      res.writeHead(200, { "Content-Type": "audio/wav" });
      // 合成は即座に応答し、実際の再生(PowerShell SoundPlayer)が6秒相当かかるWAVを返す。
      // これにより「合成段階ではなく、実プレイヤーでの再生段階」での中断を再現できる。
      res.end(buildMinimalWav(Math.round(44100 * 2 * 6)));
    },
  });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const speakPromise = mcp.client.callTool({
    name: "speak",
    arguments: { text: "長い文だけです。" },
  });
  // 合成は即座に終わるので、この時点で唯一のセグメントは既に再生開始(6秒の途中)しているはず
  await new Promise((r) => setTimeout(r, 800));
  await mcp.client.callTool({ name: "stop_speaking", arguments: {} });

  const result = await speakPromise;
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(result.isError, undefined, JSON.stringify(parsed));
  assert.equal(parsed.segments, 1);
  assert.equal(parsed.segmentsPlayed, 0, "the only segment was killed mid-playback, not completed");
  assert.equal(parsed.interrupted, true);
  assert.equal(parsed.played, false);
});

test("speak (wait:true): stop_speaking after 2 of 5 segments actually finish playing reports segmentsPlayed:2, interrupted:true (not the enqueued count of 5)", async (t) => {
  let callCount = 0;
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      callCount++;
      res.writeHead(200, { "Content-Type": "audio/wav" });
      // baselineと本編の各先頭2断片は0秒WAV。本編の3〜5断片目は6秒WAV。
      // 0秒WAVでも、各断片のPowerShell起動・終了を待つ時間は必要になる。
      // 4・5セグメント目の内容は使われない(3セグメント目再生中にstopされ、再生キューに
      // 積まれたままplayerへは一度も渡らずskippedになるはず)。
      const durationSeconds = callCount <= 2 ? 0 : 6;
      res.end(buildMinimalWav(Math.round(44100 * 2 * durationSeconds)));
    },
  });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  // 本編で待ちたい「短い2断片の直列再生完了」を同じMCPサーバーで実測する。
  const baselineStart = Date.now();
  const baselineResult = await mcp.client.callTool({
    name: "speak",
    arguments: { text: "準備一文目です。準備二文目です。", wait: true },
  });
  const twoSegmentBaselineElapsed = Date.now() - baselineStart;
  assert.equal(baselineResult.isError, undefined);
  const baselineParsed = JSON.parse(baselineResult.content[0].text);
  assert.equal(baselineParsed.segments, 2);
  assert.equal(baselineParsed.segmentsPlayed, 2);
  assert.equal(baselineParsed.interrupted, false);
  assert.equal(callCount, 2, "baseline must consume exactly two synthesis requests");

  // wait:trueの完了後なのでbaselineの合成・再生は残っていない。
  // 本編の1・2断片目を短いWAVにするため、baselineの消費分をここでリセットする。
  callCount = 0;
  const stopDelayMs = twoSegmentBaselineElapsed + 800;
  t.diagnostic(`two-segment baseline=${twoSegmentBaselineElapsed}ms, stop delay=${stopDelayMs}ms`);

  const speakPromise = mcp.client.callTool({
    name: "speak",
    arguments: { text: "一文目です。二文目です。三文目です。四文目です。五文目です。" },
  });
  // 2断片分の実測時間に余裕を足し、3断片目(6秒)の途中で止めることを狙う。
  // 相対待ちも負荷変動を保証しないため、完了数は下の厳密な等値検証で確認する。
  await new Promise((r) => setTimeout(r, stopDelayMs));
  await mcp.client.callTool({ name: "stop_speaking", arguments: {} });

  const result = await speakPromise;
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(result.isError, undefined, JSON.stringify(parsed));
  assert.equal(callCount, 5, "the main scenario must request all five segments");
  assert.equal(parsed.segments, 5);
  assert.equal(
    parsed.segmentsPlayed,
    2,
    "exactly the first 2 segments must complete; the remaining 3 must not count as played"
  );
  assert.equal(parsed.interrupted, true);
  assert.equal(parsed.interruptedBy, "stop_speaking");
  assert.equal(parsed.played, true);
});

test("speak (wait:true): a synthesis failure on the 2nd of 2 segments reports an error AND the 1st segment's actual playback result (旧N5)", async (t) => {
  let callCount = 0;
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      callCount++;
      if (callCount === 1) {
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(buildMinimalWav());
        return;
      }
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("synthetic engine failure");
    },
  });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const result = await mcp.client.callTool({
    name: "speak",
    arguments: { text: "一文目です。二文目です。" },
  });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(result.isError, true, JSON.stringify(parsed));
  assert.match(parsed.error, /HTTP 500/, "the underlying engine error must be surfaced");
  // 従来はここでthrowしてisError:trueだけを返しており、1セグメント目が実際に
  // enqueue・再生されたという事実(segmentsPlayed)が呼び出し元に伝わらなかった。
  assert.equal(parsed.segments, 2);
  assert.equal(parsed.segmentsPlayed, 1, "the 1st segment must have actually finished playing by the time this error resolves");
  assert.equal(parsed.played, true);
  assert.equal(parsed.interrupted, true);
  assert.equal(parsed.interruptedBy, "synthesis-error", "タスク6: a synthesis failure must report interruptedBy:'synthesis-error'");
});

test("speak (wait:true): a playback failure on the 2nd of 2 segments reports a structured error AND the 1st segment's actual playback result (タスク4)", async (t) => {
  let callCount = 0;
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      callCount++;
      res.writeHead(200, { "Content-Type": "audio/wav" });
      if (callCount === 1) {
        res.end(buildMinimalWav());
        return;
      }
      // 非RIFFバイト列。PowerShellのMedia.SoundPlayer.PlaySync()が実際に例外を投げ、
      // execFileのコールバックがerrを受け取る(非0終了)ことを手動検証済み。
      res.end(Buffer.from("this is not a wav file at all, just garbage bytes"));
    },
  });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const result = await mcp.client.callTool({
    name: "speak",
    arguments: { text: "一文目です。二文目です。" },
  });
  const text = result.content?.[0]?.text ?? "";
  const parsed = JSON.parse(text); // 修正前はプレーンテキストのPowerShellエラーが返りここでthrowする
  assert.equal(result.isError, true, text);
  assert.equal(parsed.errorKind, "playback");
  assert.equal(parsed.segments, 2);
  assert.equal(parsed.segmentsPlayed, 1, "the 1st segment must have actually finished playing by the time this error resolves");
  assert.equal(parsed.played, true);
  assert.equal(parsed.interrupted, true);
  assert.equal(parsed.interruptedBy, "playback-error", "タスク6: a playback failure must report interruptedBy:'playback-error'");
});

test("speak (wait:true): when segment 1's playback fails and segment 2 plays normally, the response is only sent once both playbacks have finished (タスク4)", async (t) => {
  let callCount = 0;
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      callCount++;
      res.writeHead(200, { "Content-Type": "audio/wav" });
      if (callCount === 1) {
        // ウォームアップ(baseline計測用)はほぼ無音の最小WAV
        res.end(buildMinimalWav());
        return;
      }
      if (callCount === 2) {
        // 非RIFFバイト列で1セグメント目の再生を失敗させる
        res.end(Buffer.from("this is not a wav file at all, just garbage bytes"));
        return;
      }
      if (callCount === 3) {
        // 2セグメント目は1.5秒相当の再生時間がある正常なWAV
        res.end(buildMinimalWav(Math.round(44100 * 2 * 1.5)));
        return;
      }
      // 4回目以降(後続speak呼び出し)はほぼ無音の最小WAV
      res.end(buildMinimalWav());
    },
  });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  // PowerShell起動オーバーヘッドは実行環境(負荷・アンチウイルス等)により大きく変動するため、
  // 絶対値の閾値ではなく、同一環境で計測した「単発呼び出し1回分」を基準にした相対閾値にする
  // (取り込み前の/codex:reviewの指摘: 絶対デッドラインだと遅い/高負荷なホストで誤検知しうる)。
  const baselineStart = Date.now();
  await mcp.client.callTool({ name: "speak", arguments: { text: "準備運転です。" } });
  const baselineElapsed = Date.now() - baselineStart;

  const start = Date.now();
  const result = await mcp.client.callTool({
    name: "speak",
    arguments: { text: "一文目です。二文目です。" },
  });
  const elapsed = Date.now() - start;
  const parsed = JSON.parse(result.content?.[0]?.text ?? "");
  assert.equal(result.isError, true, JSON.stringify(parsed));
  assert.equal(parsed.errorKind, "playback");
  assert.equal(parsed.segments, 2);
  assert.equal(parsed.segmentsPlayed, 1, "only the 2nd segment actually finished playing");
  // 応答が返る時点で2セグメント目(1.5秒)の再生も終わっているはず。allSettledで両方待つ
  // 設計であれば、後続のspeakを即座に発行できる(=2セグメント目の再生完了を待たされない)。
  // 1.5秒は実音声の再生時間(PlaySync()が物理的にブロックする長さ)であり、PowerShell起動
  // オーバーヘッドと違ってマシン速度に左右されないため、ここは絶対閾値のままでよい。
  assert.ok(elapsed >= 1400, `expected the response to wait for segment 2's ~1.5s playback to finish, took only ${elapsed}ms`);

  const followUpStart = Date.now();
  await mcp.client.callTool({ name: "speak", arguments: { text: "後続の発話です。" } });
  const followUpElapsed = Date.now() - followUpStart;
  // baseline(単発呼び出し1回分)+余裕を閾値にする。もしキューが2セグメント目の再生完了を
  // 二重に待たされる退行が起きれば、baselineに関係なく約1.5秒分は確実に上乗せされるため、
  // この相対閾値でも実際の退行は検出できる。
  assert.ok(
    followUpElapsed < baselineElapsed + 1200,
    `a follow-up speak call must start close to baseline (${baselineElapsed}ms) once the erroring call's response is sent, took ${followUpElapsed}ms`
  );
});

test("speak (wait:false): a background synthesis failure is still logged to stderr, not silently swallowed (旧N5修正の副作用回帰)", async (t) => {
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("synthetic engine failure");
    },
  });
  const mcp = await startMcpServer(engine.baseUrl, { captureStderr: true });
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const result = await mcp.client.callTool({ name: "speak", arguments: { text: "一文目です。", wait: false } });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(result.isError, undefined);
  assert.equal(parsed.queued, true);
  assert.equal(typeof parsed.speakId, "string", "wait:false's immediate response must include a speakId too (タスク6)");

  // wait:falseはバックグラウンドで合成が進むため、run()が失敗を検知してstderrへ書くまで少し待つ
  let stderr = "";
  for (let i = 0; i < 30; i++) {
    stderr = mcp.getStderr();
    if (stderr.includes("speak (wait:false) failed")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(stderr, /speak \(wait:false\) failed/, `background synthesis failure must still be logged; stderr was: ${JSON.stringify(stderr)}`);
  assert.match(stderr, /HTTP 500/, `the underlying engine error must be included; stderr was: ${JSON.stringify(stderr)}`);
});

test("speak: rejects whitespace-only text (including U+3000 full-width space) with a clear error instead of silently reporting played:false (旧N6)", async (t) => {
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

  const result = await mcp.client.callTool({ name: "speak", arguments: { text: "　  　" } });
  const text = result.content?.[0]?.text ?? "";
  assert.equal(result.isError, true, text);
  assert.match(text, /空白文字のみ/);
  assert.equal(synthesisCallCount, 0, "must reject before any synthesis request is sent");

  const tools = await mcp.client.listTools();
  assert.ok(tools.tools.length > 0, "the connection must survive a schema-level rejection");
});

test("speak: rejects text exceeding the per-call character limit before any synthesis is attempted, and the connection survives", async (t) => {
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

  // MAX_SPEAK_TEXT_CHARS (src/index.ts) is 5,000 — one character over it. Schema-level rejection
  // (zod .max()) resolves as a normal CallToolResult with isError:true (the SDK converts schema
  // validation failures into a tool-level error, not a thrown/rejected protocol error).
  const result = await mcp.client.callTool({ name: "speak", arguments: { text: "あ".repeat(5_001) } });
  const text = result.content?.[0]?.text ?? "";
  assert.equal(result.isError, true, text);
  assert.match(text, /too_big|at most 5000/);
  assert.equal(synthesisCallCount, 0, "must reject before any synthesis request is sent");

  const tools = await mcp.client.listTools();
  assert.ok(tools.tools.length > 0, "the connection must survive a schema-level rejection");
});

test("speak: rejects text that would split into more segments than MAX_SPEAK_SEGMENTS, before synthesizing anything", async (t) => {
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

  // MAX_SPEAK_SEGMENTS (src/segment.ts) is 500 — 501 punctuation-delimited segments (1002 chars,
  // well under the character limit) to isolate the segment-count guard from the char-count guard.
  const result = await mcp.client.callTool({ name: "speak", arguments: { text: "あ。".repeat(501) } });
  const text = result.content?.[0]?.text ?? "";
  assert.equal(result.isError, true, text);
  assert.match(text, /断片数が多すぎます/);
  assert.equal(synthesisCallCount, 0, "must reject before any synthesis request is sent");

  const tools = await mcp.client.listTools();
  assert.ok(tools.tools.length > 0, "the connection must survive a tool-level rejection");
});

test(
  "speak: aborts reading an oversized response mid-stream instead of waiting for the whole body",
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

    const result = await mcp.client.callTool({ name: "speak", arguments: { text: "短いテキストです" } });
    const text = result.content?.[0]?.text ?? "";
    assert.equal(result.isError, true, text);
    assert.match(text, /応答サイズが上限/);

    const tools = await mcp.client.listTools();
    assert.ok(tools.tools.length > 0, "the connection must survive a tool-level rejection");
  }
);

test("speak (wait:true): when segment 1's playback fails AND segment 2's synthesis also fails, both errors are surfaced (not just the synthesis one) (タスク4)", async (t) => {
  let callCount = 0;
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      callCount++;
      if (callCount === 1) {
        // 1セグメント目は合成自体は成功するが非RIFFバイト列を返し、後で再生が失敗する
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(Buffer.from("this is not a wav file at all, just garbage bytes"));
        return;
      }
      // 2セグメント目は合成自体が失敗する。1セグメント目の再生失敗が確定する前に
      // ループを抜けるため、synthesisErrorとplaybackErrorsが同時に存在する状態になる。
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("synthetic engine failure");
    },
  });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const result = await mcp.client.callTool({
    name: "speak",
    arguments: { text: "一文目です。二文目です。" },
  });
  const text = result.content?.[0]?.text ?? "";
  const parsed = JSON.parse(text);
  assert.equal(result.isError, true, text);
  assert.equal(parsed.errorKind, "synthesis", "the synthesis failure stopped the loop, so it is the primary errorKind");
  assert.match(parsed.error, /HTTP 500/, "the synthesis error must still be surfaced");
  assert.match(
    parsed.error,
    /PlaySync|Command failed/,
    "the 1st segment's playback failure must not be silently dropped just because a synthesis error also occurred"
  );
  assert.equal(parsed.segments, 2);
  assert.equal(parsed.segmentsPlayed, 0, "the 1st segment's playback failed, so nothing actually finished playing");
});

/**
 * MCPクライアント側キャンセル(client.callTool({signal})でcontroller.abort())は、SDKの
 * プロトコル仕様上、サーバー側でそのリクエストへの応答を一切送信しない(server/shared/
 * protocol.jsの共通ハンドラが`if (abortController.signal.aborted) return;`でハンドラの
 * 戻り値ごと破棄する)。このため、interruptedBy:"cancel"を含む構造化応答は、キャンセルした
 * その呼び出し自身の戻り値としては絶対に観測できない(クライアント側のPromiseも即座に
 * rejectし、生のJSON-RPCで直接受信を試みても同じくサーバーが送信しない)。唯一の観測手段が
 * サーバー側のstderr診断ログ(タスク6でsrc/index.tsに追加)であることを、この制約を踏まえて検証する。
 */
test("speak (wait:true): an MCP client-side cancellation is logged to stderr as interruptedBy:'cancel', because the SDK never sends a response for a cancelled request (タスク6)", async (t) => {
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(buildMinimalWav());
      }, 500);
    },
  });
  const mcp = await startMcpServer(engine.baseUrl, { captureStderr: true });
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const controller = new AbortController();
  const callPromise = mcp.client.callTool(
    { name: "speak", arguments: { text: "キャンセルされる発話です。" } },
    undefined,
    { signal: controller.signal }
  );
  await new Promise((r) => setTimeout(r, 100)); // 合成が進行中のタイミングでキャンセルする
  controller.abort();
  await assert.rejects(callPromise, "the SDK rejects the caller's own promise locally on abort, independent of the server");

  let stderr = "";
  for (let i = 0; i < 30; i++) {
    stderr = mcp.getStderr();
    if (stderr.includes("interrupted by cancel")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(
    stderr,
    /speak interrupted by cancel/,
    `expected the server to log the cancel-caused interruption; stderr was: ${JSON.stringify(stderr)}`
  );
});

test("stop_speaking({speakId}): stops only the targeted call's playback, leaving a concurrently-queued call unaffected (タスク6, Codexが明示的に要求した交差シナリオ)", async (t) => {
  let callCount = 0;
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      callCount++;
      res.writeHead(200, { "Content-Type": "audio/wav" });
      // callCount 1 = baseline(準備運転)。2〜4回目がAの3断片で3秒相当の無音WAV。
      // 5回目以降(Bの断片)はほぼ無音。baseline自身を「長い断片」に含めてしまうと
      // baselineElapsedが不当に膨らみ、後段の相対閾値アサーションが有名無実化する
      // (実装直後のCodex stop-time reviewが検出: cancelOwnerを意図的に無効化した
      // mutantでもこのテストが誤って合格することを実測で確認した上で修正した)。
      const isASegment = callCount >= 2 && callCount <= 4;
      res.end(buildMinimalWav(isASegment ? Math.round(44100 * 2 * 3) : 100));
    },
  });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const baselineStart = Date.now();
  await mcp.client.callTool({ name: "speak", arguments: { text: "準備運転です。" } });
  const baselineElapsed = Date.now() - baselineStart;

  const aResult = await mcp.client.callTool({
    name: "speak",
    arguments: { text: "A一文目。A二文目。A三文目。", wait: false },
  });
  const aParsed = JSON.parse(aResult.content[0].text);
  assert.equal(typeof aParsed.speakId, "string");

  // Aの1断片目(3秒)の再生が確実に始まっているタイミングでBをenqueueし、Aだけを止める
  await new Promise((r) => setTimeout(r, baselineElapsed + 800));

  const bIssuedAt = Date.now();
  const bPromise = mcp.client.callTool({ name: "speak", arguments: { text: "Bの発話です。" } });
  await new Promise((r) => setTimeout(r, 50)); // BがAの後ろにenqueueされる猶予

  const stopResult = await mcp.client.callTool({ name: "stop_speaking", arguments: { speakId: aParsed.speakId } });
  const stopParsed = JSON.parse(stopResult.content[0].text);
  assert.deepEqual(stopParsed, { stopped: true, scope: "call", found: true });

  const bResult = await bPromise;
  const bElapsed = Date.now() - bIssuedAt;
  const bParsed = JSON.parse(bResult.content[0].text);
  assert.equal(bResult.isError, undefined, JSON.stringify(bParsed));
  assert.equal(bParsed.played, true, "B must not be collaterally silenced by stop_speaking({speakId: A})");
  assert.equal(bParsed.interrupted, false, "B must complete normally, not caught by A's targeted stop");
  assert.equal(bParsed.segmentsPlayed, 1);
  // 修正前はstop_speaking({speakId})という引数自体が存在せずスキーマで拒否されていた。
  // 修正後は、Aの残り断片(合計最大約6秒)を待たされず、Bが速やかに完走できるはず。
  assert.ok(
    bElapsed < baselineElapsed + 2000,
    `expected B to complete promptly once A's targeted stop clears the shared queue, took ${bElapsed}ms`
  );
});

test("stop_speaking() (no args) still stops every concurrent call, not just one (既存契約の維持, タスク6)", async (t) => {
  let callCount = 0;
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      callCount++;
      res.writeHead(200, { "Content-Type": "audio/wav" });
      // callCount 1 = baseline(準備運転)。2〜5回目がA・Bそれぞれ2断片ずつで3秒相当、
      // 6回目以降(follow-up)はほぼ無音(交差シナリオのテストと同じ理由でbaseline自身は
      // 「長い断片」に含めない)。
      const isLongSegment = callCount >= 2 && callCount <= 5;
      res.end(buildMinimalWav(isLongSegment ? Math.round(44100 * 2 * 3) : 100));
    },
  });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const baselineStart = Date.now();
  await mcp.client.callTool({ name: "speak", arguments: { text: "準備運転です。" } });
  const baselineElapsed = Date.now() - baselineStart;

  await mcp.client.callTool({ name: "speak", arguments: { text: "A一文目。A二文目。", wait: false } });
  await mcp.client.callTool({ name: "speak", arguments: { text: "B一文目。B二文目。", wait: false } });
  await new Promise((r) => setTimeout(r, baselineElapsed + 800));

  const stopResult = await mcp.client.callTool({ name: "stop_speaking", arguments: {} });
  const stopParsed = JSON.parse(stopResult.content[0].text);
  assert.deepEqual(stopParsed, { stopped: true, scope: "all" });

  const followUpStart = Date.now();
  await mcp.client.callTool({ name: "speak", arguments: { text: "後続の発話です。" } });
  const followUpElapsed = Date.now() - followUpStart;
  // A・Bとも止まっていれば、後続speakはbaseline程度で即座に開始できるはず。
  // どちらか一方でも生き残っていれば、その残り再生(最大約6秒)を待たされる。
  assert.ok(
    followUpElapsed < baselineElapsed + 2000,
    `expected the shared queue to be fully cleared by stop_speaking(), took ${followUpElapsed}ms`
  );
});

test("stop_speaking({speakId}): an unknown or already-finished speakId returns found:false without throwing (タスク6)", async (t) => {
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(buildMinimalWav());
    },
  });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const neverExisted = await mcp.client.callTool({ name: "stop_speaking", arguments: { speakId: "no-such-speak-id" } });
  const neverExistedParsed = JSON.parse(neverExisted.content[0].text);
  assert.equal(neverExisted.isError, undefined, JSON.stringify(neverExistedParsed));
  assert.deepEqual(neverExistedParsed, { stopped: false, scope: "call", found: false });

  // 既に完了済みのspeakId(waitして完走させた後)も同様にfound:falseになるはず
  const finished = await mcp.client.callTool({ name: "speak", arguments: { text: "短い発話です" } });
  const finishedSpeakId = JSON.parse(finished.content[0].text).speakId;
  const afterFinish = await mcp.client.callTool({ name: "stop_speaking", arguments: { speakId: finishedSpeakId } });
  const afterFinishParsed = JSON.parse(afterFinish.content[0].text);
  assert.deepEqual(afterFinishParsed, { stopped: false, scope: "call", found: false });

  const tools = await mcp.client.listTools();
  assert.ok(tools.tools.length > 0, "the connection must survive these no-op stop_speaking calls");
});

test("get_speak_status: after speak(wait:false) fails on the 2nd segment's synthesis, the speakId can be queried for state:'failed' with the underlying error and the 1st segment's actual playback result (タスク7)", async (t) => {
  let callCount = 0;
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      callCount++;
      if (callCount === 1) {
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(buildMinimalWav());
        return;
      }
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("synthetic engine failure");
    },
  });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const queued = await mcp.client.callTool({
    name: "speak",
    arguments: { text: "一文目です。二文目です。", wait: false },
  });
  const queuedParsed = JSON.parse(queued.content[0].text);
  assert.equal(queuedParsed.queued, true);
  const speakId = queuedParsed.speakId;

  let statusParsed;
  for (let i = 0; i < 50; i++) {
    const status = await mcp.client.callTool({ name: "get_speak_status", arguments: { speakId } });
    statusParsed = JSON.parse(status.content[0].text);
    if (statusParsed.state !== "running") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(statusParsed.found, true, JSON.stringify(statusParsed));
  assert.equal(statusParsed.state, "failed");
  assert.match(statusParsed.error, /HTTP 500/, "the underlying engine error must be surfaced via get_speak_status too");
  assert.equal(statusParsed.errorKind, "synthesis");
  assert.equal(statusParsed.segments, 2);
  assert.equal(
    statusParsed.segmentsPlayed,
    1,
    "the 1st segment must have actually finished playing before this failed status is recorded"
  );
});

/**
 * 上とほぼ同じシナリオだが、失敗の起点を「合成(HTTP 500)」ではなく「実再生(PowerShell
 * SoundPlayer)」にする。wait:falseはバックグラウンドで進行するため、再生失敗がrecordSpeakFinish
 * (get_speak_statusの記録)に届く前にサーバープロセスごと不安定にならないか(Stop hookの
 * Codex stop-time reviewが懸念した経路)を、実際のMCP子プロセスを使って検証する。5並列でも
 * 子プロセスが(自分たちが明示的にcloseするまで)終了しないこと、接続がlistTools()で
 * 生存確認できることまで含めて固定する。
 */
test("get_speak_status: after speak(wait:false) fails on the 2nd segment's real playback (not synthesis), the speakId can be queried for state:'failed', and the server survives it (タスク7, Codex stop-time review)", async (t) => {
  let callCount = 0;
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      callCount++;
      res.writeHead(200, { "Content-Type": "audio/wav" });
      // callCount 2回目だけ非RIFFバイト列(合成自体は成功するが実再生が失敗する)を返す。
      // 1回目(この呼び出しの1断片目)・3回目以降(後続speak呼び出し)は正常なWAVを返す。
      if (callCount === 2) {
        res.end(Buffer.from("this is not a wav file at all, just garbage bytes"));
        return;
      }
      res.end(buildMinimalWav());
    },
  });
  const mcp = await startMcpServer(engine.baseUrl, { captureStderr: true });
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const queued = await mcp.client.callTool({
    name: "speak",
    arguments: { text: "一文目です。二文目です。", wait: false },
  });
  const speakId = JSON.parse(queued.content[0].text).speakId;

  let statusParsed;
  for (let i = 0; i < 50; i++) {
    const status = await mcp.client.callTool({ name: "get_speak_status", arguments: { speakId } });
    statusParsed = JSON.parse(status.content[0].text);
    if (statusParsed.state !== "running") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(statusParsed.found, true, JSON.stringify(statusParsed));
  assert.equal(statusParsed.state, "failed");
  assert.equal(statusParsed.errorKind, "playback");
  assert.equal(statusParsed.segments, 2);
  assert.equal(statusParsed.segmentsPlayed, 1);

  // サーバー(MCP子プロセス)がこの再生失敗で不安定にならず、後続のツール呼び出しに
  // 応答できることを直接検証する(懸念された「サーバーを終了させ得る」の反証)。
  const tools = await mcp.client.listTools();
  assert.ok(tools.tools.length > 0, "the connection must survive a wait:false playback failure");
  const followUp = await mcp.client.callTool({ name: "speak", arguments: { text: "後続の発話です。" } });
  assert.equal(followUp.isError, undefined, "a later call must still succeed normally after the earlier playback failure");
});

/**
 * 単発の再生失敗だけでなく、5並列同時の再生失敗でもサーバーが不安定にならないことを固定する
 * (Stop hookのCodex stop-time reviewが「これは検証スクリプトでの一度きりの手動確認に過ぎず、
 * 再実行可能な回帰テストとして残っていない」と指摘したため追加)。
 */
test("get_speak_status: 5 concurrent speak(wait:false) calls that all fail on real playback do not destabilize the server — every status resolves to state:'failed' and the connection stays responsive (タスク7, Codex stop-time review)", async (t) => {
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      res.writeHead(200, { "Content-Type": "audio/wav" });
      // 全呼び出しの合成は成功するが、返すWAVは常に非RIFFバイト列(=実再生が必ず失敗する)
      res.end(Buffer.from("this is not a wav file at all, just garbage bytes"));
    },
  });
  const mcp = await startMcpServer(engine.baseUrl, { captureStderr: true });
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const speakIds = [];
  for (let i = 0; i < 5; i++) {
    const res = await mcp.client.callTool({ name: "speak", arguments: { text: `発話${i}です。`, wait: false } });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.queued, true);
    speakIds.push(parsed.speakId);
  }

  // 5件全てのstateがrunning以外に確定するまで待つ(いずれかがハング/クラッシュしていれば
  // ここでタイムアウトし、テスト自体が失敗する形でそれを検出できる)。
  for (const speakId of speakIds) {
    let parsed;
    for (let i = 0; i < 50; i++) {
      const status = await mcp.client.callTool({ name: "get_speak_status", arguments: { speakId } });
      parsed = JSON.parse(status.content[0].text);
      if (parsed.state !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(parsed?.found, true, `speakId ${speakId} could not be queried: ${JSON.stringify(parsed)}`);
    assert.equal(parsed.state, "failed", `speakId ${speakId} did not resolve to failed: ${JSON.stringify(parsed)}`);
    assert.equal(parsed.errorKind, "playback");
  }

  // 5件同時の再生失敗のあとも、サーバーが不安定にならず引き続き応答できることを直接検証する。
  const tools = await mcp.client.listTools();
  assert.ok(tools.tools.length > 0, "the connection must survive 5 concurrent playback failures");
});

test("get_speak_status: speak(wait:false) reports state:'running' while synthesis is still in flight, then state:'completed' once it finishes (タスク7)", async (t) => {
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const engine = await startFakeEngine({
    synthesizeHandler: async (req, res) => {
      await gate; // 呼び出し元がstate:"running"を観測するまで合成応答を保留する
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(buildMinimalWav());
    },
  });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const queued = await mcp.client.callTool({ name: "speak", arguments: { text: "短いテキストです", wait: false } });
  const speakId = JSON.parse(queued.content[0].text).speakId;

  const runningStatus = await mcp.client.callTool({ name: "get_speak_status", arguments: { speakId } });
  const runningParsed = JSON.parse(runningStatus.content[0].text);
  assert.equal(runningParsed.found, true);
  assert.equal(runningParsed.state, "running", "合成応答をまだ保留しているので、この時点では完了しているはずがない");

  releaseGate();

  let completedParsed;
  for (let i = 0; i < 50; i++) {
    const status = await mcp.client.callTool({ name: "get_speak_status", arguments: { speakId } });
    completedParsed = JSON.parse(status.content[0].text);
    if (completedParsed.state !== "running") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(completedParsed.state, "completed");
  assert.equal(completedParsed.segmentsPlayed, 1);
  assert.equal(completedParsed.interruptedBy, null);
});

test("get_speak_status: omitting speakId returns the most recently started call, not an arbitrary one (タスク7)", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  await mcp.client.callTool({ name: "speak", arguments: { text: "一つ目です" } });
  const second = await mcp.client.callTool({ name: "speak", arguments: { text: "二つ目です" } });
  const secondSpeakId = JSON.parse(second.content[0].text).speakId;

  const status = await mcp.client.callTool({ name: "get_speak_status", arguments: {} });
  const parsed = JSON.parse(status.content[0].text);
  assert.equal(parsed.found, true);
  assert.equal(parsed.speakId, secondSpeakId);
});

test("get_speak_status: an unknown speakId returns found:false without throwing (タスク7)", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const status = await mcp.client.callTool({ name: "get_speak_status", arguments: { speakId: "no-such-speak-id" } });
  const parsed = JSON.parse(status.content[0].text);
  assert.equal(status.isError, undefined, JSON.stringify(parsed));
  assert.deepEqual(parsed, { found: false });
});
