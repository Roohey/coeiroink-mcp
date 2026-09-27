import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { getEventListeners } from "node:events";
import { combineSignals, guardedFetch } from "../dist/tts-engine.js";
import { synthesize as coeiroinkSynthesize } from "../dist/coeiroink-client.js";

test("combineSignals: aborts when either input signal aborts", () => {
  const a = new AbortController();
  const b = new AbortController();
  const { signal, dispose } = combineSignals(a.signal, b.signal);
  assert.equal(signal.aborted, false);
  b.abort("b-reason");
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason, "b-reason");
  dispose();
});

test("combineSignals: returns the already-aborted signal immediately if either is pre-aborted", () => {
  const a = new AbortController();
  a.abort("already");
  const b = new AbortController();
  const { signal, dispose } = combineSignals(a.signal, b.signal);
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason, "already");
  dispose(); // 早期returnケースはリスナーを付けていないので、no-opであるべき
});

test("combineSignals: dispose() removes both listeners so a long-lived signal does not accumulate them", () => {
  // getStopSignal()相当の、リクエストをまたいで使い回される長寿命シグナルを模す
  const longLived = new AbortController();
  assert.equal(getEventListeners(longLived.signal, "abort").length, 0);

  const combos = [];
  for (let i = 0; i < 5; i++) {
    const perRequest = new AbortController(); // timeoutSignal相当。毎回新規
    combos.push(combineSignals(perRequest.signal, longLived.signal));
  }
  // dispose前は、5回分のリスナーがlongLivedに積み上がっているはず
  assert.equal(getEventListeners(longLived.signal, "abort").length, 5);

  for (const { dispose } of combos) dispose();

  // 全リクエストが完了してdispose済みなら、長寿命シグナル側にリスナーは残らない
  assert.equal(getEventListeners(longLived.signal, "abort").length, 0);
});

function startSlowSynthesisServer(delayMs) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith("/v1/synthesis")) {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "audio/wav" });
          res.end(Buffer.from("fake-wav-bytes"));
        }, delayMs);
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const DUMMY_PARAMS = {
  text: "テスト",
  speakerUuid: "dummy",
  styleId: 0,
  speedScale: 1,
  volumeScale: 1,
  pitchScale: 0,
  intonationScale: 1,
  prePhonemeLength: 0.1,
  postPhonemeLength: 0.1,
  outputSamplingRate: 44100,
};

test("synthesize: an externally-aborted signal cancels the in-flight request before the slow server responds", async () => {
  const server = await startSlowSynthesisServer(2000);
  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const controller = new AbortController();

    const promise = coeiroinkSynthesize(baseUrl, DUMMY_PARAMS, controller.signal);
    setTimeout(() => controller.abort(), 50);

    const start = Date.now();
    await assert.rejects(promise);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `expected to abort quickly, took ${elapsed}ms (server delay was 2000ms)`);
  } finally {
    server.close();
  }
});

test("synthesize: succeeds normally when the signal is never aborted", async () => {
  const server = await startSlowSynthesisServer(10);
  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const controller = new AbortController();
    const wav = await coeiroinkSynthesize(baseUrl, DUMMY_PARAMS, controller.signal);
    assert.ok(Buffer.isBuffer(wav));
    assert.ok(wav.length > 0);
  } finally {
    server.close();
  }
});

async function getClosedPort() {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

test("guardedFetch: a request-timeout abort (AbortSignal.timeout firing) produces a timeout message, not a 'not running' message", async () => {
  const server = await startSlowSynthesisServer(5000);
  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    await assert.rejects(guardedFetch("COEIROINK", `${baseUrl}/v1/synthesis`, { signal: AbortSignal.timeout(50) }, baseUrl), (e) => {
      assert.match(e.message, /タイムアウトしました/);
      assert.doesNotMatch(e.message, /起動していません/);
      return true;
    });
  } finally {
    server.close();
  }
});

test("guardedFetch: connection refusal (ECONNREFUSED) produces the 'engine not running' message", async () => {
  const port = await getClosedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  await assert.rejects(guardedFetch("COEIROINK", baseUrl, {}, baseUrl), (e) => {
    assert.match(e.message, /起動していません/);
    return true;
  });
});

test("guardedFetch: an externally-aborted (non-timeout) signal is not mislabeled as a connection failure", async () => {
  const server = await startSlowSynthesisServer(5000);
  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(guardedFetch("COEIROINK", `${baseUrl}/v1/synthesis`, { signal: controller.signal }, baseUrl), (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      assert.doesNotMatch(msg, /起動していません/);
      assert.doesNotMatch(msg, /タイムアウトしました/);
      return true;
    });
  } finally {
    server.close();
  }
});
