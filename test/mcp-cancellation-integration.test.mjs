import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startFakeEngine, startMcpServer, buildMinimalWav } from "./mcp-client-helper.mjs";

/** 指定ミリ秒だけ応答を遅らせる/v1/synthesisハンドラを作る。呼び出し回数をcounterで数えられる。 */
function slowSynthesizeHandler(delayMs, counter) {
  return (_req, res) => {
    counter.count++;
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(buildMinimalWav());
    }, delayMs);
  };
}

/**
 * counter.countがminに達するまでポーリングで待つ。
 * これらのテストは「MCPリクエストがfakeEngineへの実HTTPリクエストとして実際にディスパッチされた後で
 * abortする」ことを保証したい。固定ミリ秒のsetTimeoutでabortを発火させる従来design(旧実装)は、
 * CPU/IOが混雑している状況(npm testで多数のテストファイルが並列実行される等)では、固定時間内に
 * リクエストが実際に送出される前にabortが先に発火し、counter.countが期待値に達しないまま
 * テストが失敗することがあった(たまに再現する不安定性であり、src側のロジックの問題ではない)。
 * 固定タイマーに依存せず、実際のディスパッチ完了(counter.countの増加)をイベントとして直接
 * 待つことでこの競合を根本的に解消する。
 */
async function waitForCount(counter, min, { timeoutMs = 5000, intervalMs = 5 } = {}) {
  const start = Date.now();
  while (counter.count < min) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`counter.countが${timeoutMs}ms以内に${min}に達しませんでした(現在値: ${counter.count})`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test("synthesize: MCP client-side cancellation aborts the in-flight request quickly and writes no file", async (t) => {
  const counter = { count: 0 };
  const engine = await startFakeEngine({ synthesizeHandler: slowSynthesizeHandler(3000, counter) });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const outputPath = path.join(mcp.tmpRoot, "should-not-exist.wav");
  const controller = new AbortController();
  const callPromise = mcp.client.callTool(
    { name: "synthesize", arguments: { text: "こんにちは", outputPath } },
    undefined,
    { signal: controller.signal }
  );
  await waitForCount(counter, 1);
  const start = Date.now();
  controller.abort();

  await assert.rejects(callPromise);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1500, `expected cancellation to resolve quickly, took ${elapsed}ms (server delay was 3000ms)`);
  assert.equal(fs.existsSync(outputPath), false, "no partial file should be written after cancellation");
  assert.equal(counter.count, 1);
});

test("synthesize_script: MCP client-side cancellation stops later lines from being synthesized and leaves no output", async (t) => {
  const counter = { count: 0 };
  const engine = await startFakeEngine({ synthesizeHandler: slowSynthesizeHandler(3000, counter) });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const outputDir = path.join(mcp.tmpRoot, "cancelled-script-dir");
  const controller = new AbortController();
  const callPromise = mcp.client.callTool(
    {
      name: "synthesize_script",
      arguments: { script: "テスト話者A,一行目\nテスト話者B,二行目\nテスト話者A,三行目", outputDir },
    },
    undefined,
    { signal: controller.signal }
  );
  await waitForCount(counter, 1);
  controller.abort();

  await assert.rejects(callPromise);
  // サーバー側の後始末(ステージングディレクトリ削除等)が終わるのを待つ
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(counter.count, 1, "only the in-flight line's synthesis request should have been sent");
  assert.equal(fs.existsSync(outputDir), false, "outputDir must never be created for a cancelled call");
});

test("speak (wait:true): MCP client-side cancellation stops synthesizing further segments", async (t) => {
  const counter = { count: 0 };
  const engine = await startFakeEngine({ synthesizeHandler: slowSynthesizeHandler(3000, counter) });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const controller = new AbortController();
  const callPromise = mcp.client.callTool(
    { name: "speak", arguments: { text: "一文目です。二文目です。三文目です。" } },
    undefined,
    { signal: controller.signal }
  );
  await waitForCount(counter, 1);
  controller.abort();

  await assert.rejects(callPromise);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(counter.count, 1, "only the in-flight segment's synthesis request should have been sent");
});

test("speak (wait:true): MCP client-side cancellation kills the currently-playing segment immediately instead of letting it (and any already-enqueued segments) play out naturally and block the next speak call (タスク5)", async (t) => {
  let callCount = 0;
  const engine = await startFakeEngine({
    synthesizeHandler: (req, res) => {
      callCount++;
      res.writeHead(200, { "Content-Type": "audio/wav" });
      // 2〜4回目(キャンセル対象のspeak呼び出しの3断片)だけ3秒相当の無音WAV。合成自体には
      // 遅延を入れないので、cancelする頃には3断片とも既に合成・enqueue済み(1断片目は再生中、
      // 2・3断片目はキュー待ち)になっているはず。baseline計測用(1回目)と後続speak(5回目)は
      // ほぼ無音の最小WAV。
      const isCancelledCallSegment = callCount >= 2 && callCount <= 4;
      res.end(buildMinimalWav(isCancelledCallSegment ? Math.round(44100 * 2 * 3) : 100));
    },
  });
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  // PowerShell起動オーバーヘッドは環境依存のため、絶対閾値ではなく単発呼び出し1回分を
  // 基準にした相対閾値にする(タスク4で確立した方針)。
  const baselineStart = Date.now();
  await mcp.client.callTool({ name: "speak", arguments: { text: "準備運転です。" } });
  const baselineElapsed = Date.now() - baselineStart;

  const controller = new AbortController();
  const callPromise = mcp.client.callTool(
    { name: "speak", arguments: { text: "一文目です。二文目です。三文目です。" } },
    undefined,
    { signal: controller.signal }
  );
  // 1断片目の再生(3秒)が確実に始まっているタイミングでキャンセルする。固定sleepだと、
  // 高負荷/低速な環境でPowerShellの起動自体がまだ終わっていないうちにcancelしてしまい、
  // 「再生中の中断」ではなく「enqueue直後・再生開始前の中断」という別の(既にカバー済みの)
  // 経路を検証してしまう恐れがある(実装直後のCodex stop-time reviewの指摘。実測でも、この
  // 環境でbaseline(単発呼び出し1回分、PowerShell起動+短い再生+応答返却までを含む)が
  // 固定400msを上回るケース(628ms)を確認しており、固定400msでは不十分だった)。
  // baselineを基準にした待機時間にすることで、環境の速度に関わらず1断片目の再生開始後に
  // 確実にキャンセルしつつ、3秒の再生時間に対しては十分な余裕を残す。
  await new Promise((r) => setTimeout(r, baselineElapsed + 800));
  controller.abort();
  await assert.rejects(callPromise);

  const followUpStart = Date.now();
  await mcp.client.callTool({ name: "speak", arguments: { text: "後続の発話です。" } });
  const followUpElapsed = Date.now() - followUpStart;
  // 修正前はrequestSignalがenqueuePlaybackへ届かず、1〜3断片目の再生(合計約6秒)が自然完了
  // するまで再生キューが解放されなかった。baseline+余裕を閾値にすることで、その退行
  // (約4〜6秒の上乗せ)は確実に検出しつつ、PowerShell起動オーバーヘッド自体の環境差では
  // 誤検知しない。
  assert.ok(
    followUpElapsed < baselineElapsed + 1200,
    `expected the follow-up speak call to start close to baseline (${baselineElapsed}ms) once cancellation interrupts playback, took ${followUpElapsed}ms`
  );
});
