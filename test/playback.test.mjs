import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as m from "../dist/playback.js";

async function waitUntil(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** execFileの代わりに使う、テストから完了タイミングを制御できる偽のspawn実装。 */
function createControllableSpawn() {
  const created = [];
  function fakeSpawn(_command, _args, _options, callback) {
    let killed = false;
    const child = {
      get killed() {
        return killed;
      },
      kill() {
        killed = true;
      },
    };
    created.push({ child, fire: (err) => callback(err ?? null) });
    return child;
  }
  return { fakeSpawn, created };
}

beforeEach(() => {
  m.stopPlayback(); // 前のテストの再生キュー/ロックを必ず空の状態にリセットする
});

afterEach(() => {
  m.setSpawnImplForTesting(null);
});

test("runExclusive serializes concurrent calls (B does not start until A fully resolves)", async () => {
  const events = [];
  const task = (name, delayMs) => () =>
    m.runExclusive(async () => {
      events.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, delayMs));
      events.push(`${name}:end`);
      return name;
    });
  const [a, b] = await Promise.all([task("A", 30)(), task("B", 5)()]);
  assert.deepEqual(events, ["A:start", "A:end", "B:start", "B:end"]);
  assert.deepEqual([a, b], ["A", "B"]);
});

test("stopPlayback increments the generation counter", () => {
  const before = m.getGeneration();
  m.stopPlayback();
  assert.equal(m.getGeneration(), before + 1);
});

test("stopPlayback resets pipelineLock so new work does not wait for a stale in-flight call", async () => {
  const events = [];
  const slow = m.runExclusive(async () => {
    events.push("slow:start");
    await new Promise((r) => setTimeout(r, 500));
    events.push("slow:end");
  });
  await waitUntil(() => events.includes("slow:start"));

  m.stopPlayback();

  const fastStart = Date.now();
  await m.runExclusive(async () => {
    events.push(`fast:start(${Date.now() - fastStart}ms)`);
  });
  const fastElapsed = Date.now() - fastStart;
  assert.ok(fastElapsed < 200, `expected near-instant, got ${fastElapsed}ms`);

  await slow; // クリーンアップのため待つ
});

test("getStopSignal(): a signal obtained before stopPlayback aborts; one obtained after does not", () => {
  const before = m.getStopSignal();
  assert.equal(before.aborted, false);
  m.stopPlayback();
  assert.equal(before.aborted, true, "signal obtained before stop must be aborted");

  const after = m.getStopSignal();
  assert.equal(after.aborted, false, "signal obtained after stop must be fresh");
});

test("enqueuePlayback: a job whose generation is stale by the time it runs is skipped (player never invoked)", async () => {
  const { fakeSpawn, created } = createControllableSpawn();
  m.setSpawnImplForTesting(fakeSpawn);

  // 直前のジョブが再生中でキューが詰まっている状況を作り、その裏でstopPlaybackする
  const blocking = m.enqueuePlayback(Buffer.from("blocking"));
  await waitUntil(() => created.length === 1);

  const staleJob = m.enqueuePlayback(Buffer.from("stale")); // このジョブの世代はここで確定する
  m.stopPlayback(); // stopPlayback後の世代になるので、staleJobは実行時にスキップされるはず
  created[0].fire(null); // blocking側の再生を完了させ、キューを進める

  const staleResult = await staleJob; // スキップされて即resolveするはず
  await blocking;

  assert.equal(created.length, 1, "the stale job must never reach the player");
  assert.equal(staleResult, "skipped", "a generation-stale job must resolve as 'skipped', not indistinguishable from a completed playback");
});

test("enqueuePlayback: a normally finished playback resolves to 'completed'", async () => {
  const { fakeSpawn, created } = createControllableSpawn();
  m.setSpawnImplForTesting(fakeSpawn);

  const job = m.enqueuePlayback(Buffer.from("normal"));
  await waitUntil(() => created.length === 1);
  created[0].fire(null); // 正常終了

  const result = await job;
  assert.equal(result, "completed");
});

test("enqueuePlayback: a job whose player is killed by stop_speaking mid-playback resolves to 'interrupted', not 'completed'", async () => {
  const { fakeSpawn, created } = createControllableSpawn();
  m.setSpawnImplForTesting(fakeSpawn);

  const job = m.enqueuePlayback(Buffer.from("killed"));
  await waitUntil(() => created.length === 1);

  m.stopPlayback(); // currentChild.kill()を呼ぶ
  assert.equal(created[0].child.killed, true);
  // execFileの実挙動どおり、killされた場合もコールバックはerr付きで発火する
  created[0].fire(new Error("killed"));

  const result = await job;
  assert.equal(
    result,
    "interrupted",
    "a killed playback must be reported as 'interrupted', not conflated with a normal 'completed' finish"
  );
});

test("currentChild race: a stale kill-callback for an old child must not clear the handle of a newer one", async () => {
  const { fakeSpawn, created } = createControllableSpawn();
  m.setSpawnImplForTesting(fakeSpawn);

  m.enqueuePlayback(Buffer.from("a"));
  await waitUntil(() => created.length === 1);

  m.stopPlayback(); // childAをkillする(が、コールバック発火はまだ; createControllableSpawnはfire()するまで発火しない)

  // stopPlaybackはqueueをリセットするので、次のジョブはchildAのコールバックを待たずにすぐ始まる
  m.enqueuePlayback(Buffer.from("b"));
  await waitUntil(() => created.length === 2);

  // ここでchildAの(killによる)古いコールバックが遅れて発火したとする
  created[0].fire(new Error("killed"));

  // currentChildがchildBのままなら、ここでのstopPlaybackがchildBを正しくkillできるはず
  m.stopPlayback();
  assert.equal(created[1].child.killed, true, "currentChild must still reference the newer child, not be wiped by the stale callback");

  created[1].fire(new Error("killed"));
});

test("enqueuePlayback: an already-aborted requestSignal resolves to 'skipped' without ever invoking the player (タスク5)", async () => {
  const { fakeSpawn, created } = createControllableSpawn();
  m.setSpawnImplForTesting(fakeSpawn);

  const controller = new AbortController();
  controller.abort();

  // pre-fix動作(signalを無視する実装)ではプレイヤーが実際に起動されfire()されるまで
  // resolveしないため、有限時間で解決しなければ無限ハングではなく明確な失敗にする。
  const result = await Promise.race([
    m.enqueuePlayback(Buffer.from("aborted"), controller.signal),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("enqueuePlayback did not resolve within 2000ms — did it invoke the player despite an already-aborted signal?")),
        2000
      )
    ),
  ]);
  assert.equal(result, "skipped");
  assert.equal(created.length, 0, "the player must never be invoked for a job whose requestSignal was already aborted");
});

test("enqueuePlayback: aborting requestSignal mid-playback kills only that job's own child process and resolves to 'interrupted' (タスク5)", async () => {
  const { fakeSpawn, created } = createControllableSpawn();
  m.setSpawnImplForTesting(fakeSpawn);

  const controllerA = new AbortController();
  const jobA = m.enqueuePlayback(Buffer.from("a"), controllerA.signal);
  await waitUntil(() => created.length === 1);

  // Bはsignalなしで同時にキューへ積んでおく。Aのabortに巻き添えにならないことを確認するため。
  const jobB = m.enqueuePlayback(Buffer.from("b"));

  controllerA.abort();
  await waitUntil(() => created[0].child.killed === true);
  assert.equal(created.length, 1, "job B must still be queued behind A, not started yet");
  created[0].fire(new Error("killed")); // execFileの実挙動どおり、killされた場合もerr付きで発火する

  const resultA = await jobA;
  assert.equal(resultA, "interrupted", "a job whose requestSignal fired mid-playback must resolve as 'interrupted', not 'completed'");

  await waitUntil(() => created.length === 2);
  assert.equal(created[1].child.killed, false, "job B's own child must not be killed by job A's requestSignal");
  created[1].fire(null);
  const resultB = await jobB;
  assert.equal(resultB, "completed");
});

test("cancelOwner: returns false for an id that was never created (タスク6)", () => {
  assert.equal(m.cancelOwner("nonexistent-id"), false);
});

test("createPlaybackOwner/cancelOwner: cancel() aborts the owner's own signal and reason() reports 'stop_speaking' (タスク6)", () => {
  const owner = m.createPlaybackOwner();
  assert.equal(owner.signal.aborted, false);
  assert.equal(owner.reason(), null);

  const found = m.cancelOwner(owner.id);
  assert.equal(found, true);
  assert.equal(owner.signal.aborted, true);
  assert.equal(owner.reason(), "stop_speaking");
});

test("createPlaybackOwner: an externally-passed requestSignal aborting the owner's signal reports reason() 'cancel', not 'stop_speaking' (タスク6)", () => {
  const controller = new AbortController();
  const owner = m.createPlaybackOwner(controller.signal);
  assert.equal(owner.reason(), null);

  controller.abort();
  assert.equal(owner.signal.aborted, true);
  assert.equal(owner.reason(), "cancel");
});

test("createPlaybackOwner: an already-aborted requestSignal is reflected immediately (owner.signal starts aborted, reason() is 'cancel')", () => {
  const controller = new AbortController();
  controller.abort();
  const owner = m.createPlaybackOwner(controller.signal);
  assert.equal(owner.signal.aborted, true);
  assert.equal(owner.reason(), "cancel");
});

test("cancelOwner: cancelling one owner must not affect a different owner's signal (isolation, タスク6の必須回帰テスト)", () => {
  const ownerA = m.createPlaybackOwner();
  const ownerB = m.createPlaybackOwner();

  const found = m.cancelOwner(ownerA.id);
  assert.equal(found, true);
  assert.equal(ownerA.signal.aborted, true);
  assert.equal(ownerB.signal.aborted, false, "cancelling owner A must not touch owner B's signal");
  assert.equal(ownerB.reason(), null);
});

test("releaseOwner: removes the entry so a later cancelOwner for the same id returns false (found:false semantics) (タスク6)", () => {
  const owner = m.createPlaybackOwner();
  m.releaseOwner(owner.id);
  assert.equal(m.cancelOwner(owner.id), false, "a released owner must no longer be findable");
  // releaseOwner自体はowner.signalには触れない(既にenqueue済みのジョブはそのまま完了できる)
  assert.equal(owner.signal.aborted, false);
});

test("recordSpeakStart/getSpeakStatus: a freshly started record reports state:'running' with finishedAt:null (タスク7)", () => {
  const id = "status-basic";
  m.recordSpeakStart(id, 10, 2);
  const running = m.getSpeakStatus(id);
  assert.equal(running.state, "running");
  assert.equal(running.finishedAt, null);
  assert.equal(running.characters, 10);
  assert.equal(running.segments, 2);
  assert.equal(running.segmentsPlayed, 0);
  assert.equal(running.interruptedBy, null);
});

test("recordSpeakFinish: updates the existing record in place instead of creating a new one (タスク7)", () => {
  const id = "status-finish";
  m.recordSpeakStart(id, 10, 2);
  m.recordSpeakFinish(id, { state: "completed", segmentsPlayed: 2, interruptedBy: null });
  const finished = m.getSpeakStatus(id);
  assert.equal(finished.state, "completed");
  assert.equal(finished.segmentsPlayed, 2);
  assert.notEqual(finished.finishedAt, null);
});

test("recordSpeakFinish: an id that was never started (e.g. already evicted) is a no-op, not a crash (タスク7)", () => {
  assert.doesNotThrow(() => m.recordSpeakFinish("never-started", { state: "completed", segmentsPlayed: 0, interruptedBy: null }));
  assert.equal(m.getSpeakStatus("never-started"), undefined);
});

test("getSpeakStatus: omitting speakId returns the most recently started record (タスク7)", () => {
  m.recordSpeakStart("older-record-for-latest-test", 1, 1);
  m.recordSpeakStart("newer-record-for-latest-test", 1, 1);
  const latest = m.getSpeakStatus();
  assert.equal(latest.speakId, "newer-record-for-latest-test");
});

test("getSpeakStatus: an id that was never recorded returns undefined (found:false semantics), not a throw (タスク7)", () => {
  assert.equal(m.getSpeakStatus("no-such-speak-id-ever"), undefined);
});

test("recordSpeakStart: exceeding the ring buffer capacity evicts the oldest record so memory stays bounded (タスク7)", () => {
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const id = `ring-buffer-${i}`;
    ids.push(id);
    m.recordSpeakStart(id, 5, 1);
  }
  // 容量(16)を超えて挿入したので、このテスト内で最も古い4件は必ず追い出されているはず
  // (このプロセス内で以前のテストが挿入した記録がいくつ残っていたとしても、この20件は
  // それら全てより新しいので、この20件のうち最古4件が追い出されることに変わりはない)
  assert.equal(m.getSpeakStatus(ids[0]), undefined, "the oldest record beyond capacity must have been evicted");
  assert.equal(m.getSpeakStatus(ids[3]), undefined, "the 4th-oldest record beyond capacity must have been evicted too");
  assert.notEqual(m.getSpeakStatus(ids[4]), undefined, "the 5th record (oldest surviving, given capacity 16) must remain");
  assert.notEqual(m.getSpeakStatus(ids[19]), undefined, "the most recently started record must always survive");
  let survivingCount = 0;
  for (const id of ids) {
    if (m.getSpeakStatus(id) !== undefined) survivingCount++;
  }
  assert.ok(
    survivingCount <= 16,
    `at most 16 records may survive regardless of how many speak calls occurred, but ${survivingCount} did`
  );
});
