import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let queue: Promise<void> = Promise.resolve();
let currentChild: ChildProcess | undefined;
// stopPlaybackが呼ばれるたびに増やす。キュー投入時の世代と食い違うジョブは実行時にスキップする。
let generation = 0;

// execFileそのものをテストから差し替えられるようにする(実際にPowerShell/SoundPlayerを
// 起動せずに、playWavFile/enqueuePlayback/currentChildの排他ロジックを検証するため)。
// シグネチャはnode:child_processのexecFileに合わせてあるので、既定実装は挙動を変えない。
type SpawnFn = typeof execFile;
let spawnImpl: SpawnFn = execFile;

export function setSpawnImplForTesting(fn: SpawnFn | null): void {
  spawnImpl = fn ?? execFile;
}

/** enqueue時点で既にstopPlaybackされプレイヤーへ一度も渡らなかった(skipped)場合も含めた判別可能な結果。 */
export type EnqueueOutcome = "completed" | "interrupted" | "skipped";

function playWavFile(filePath: string, signal?: AbortSignal): Promise<void> {
  const escaped = filePath.replace(/'/g, "''");
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      "powershell",
      ["-NoProfile", "-Command", `(New-Object Media.SoundPlayer '${escaped}').PlaySync()`],
      { windowsHide: true },
      (err) => {
        // killされた旧プロセスのコールバックが後から発火し、既に始まっている新しい
        // 再生のcurrentChildを誤って消さないよう、自分がまだ「現在の子プロセス」である場合のみ解除する
        if (currentChild === child) currentChild = undefined;
        signal?.removeEventListener("abort", onAbort);
        // child.killedは「.kill()を呼んだ」事実しか示すだけで、実際に中断が原因で終了したかの
        // 判定には使わない(自然終了直後に空振りのkill()が呼ばれるレースを拾ってしまう恐れがある)。
        // ここでは成否だけを解決し、中断判定はenqueuePlayback側で世代番号/signalの変化から行う。
        if (!err || child.killed) {
          resolve();
        } else {
          reject(err);
        }
      }
    );
    currentChild = child;
    // requestSignal(MCPリクエストのキャンセル)がこのジョブの再生中に発火した場合、
    // グローバルなcurrentChildではなく、このクロージャが直接持つchildだけをkillする。
    // これにより、以後に始まった別ジョブの再生を誤ってkillすることがない。
    function onAbort() {
      if (!child.killed) child.kill();
    }
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * WAVバッファを再生キューに追加する。合成→再生は逐次実行され、発話は重ならない。
 * このジョブ自体の結果は返り値のPromiseで呼び出し元(MCPツール)に伝わり、
 * 「実際に最後まで再生できた(completed)」「stop_speaking/requestSignalで中断された(interrupted)」
 * 「enqueue時点で既に中断済みでプレイヤーへ渡らなかった(skipped)」を判別できる。
 * キュー自体は失敗しても止めない(次の呼び出しが詰まらないようにする)。
 *
 * signal(MCPリクエストのrequestSignal)を渡すと、stopPlaybackの世代番号と同じ扱いで
 * このジョブに中断を伝えられる。既にabort済みならenqueue時点でskippedとして即終了し、
 * 再生中にabortされれば自分の子プロセスだけをkillしてinterruptedとして解決する
 * (タスク5: 従来はgenerationしか見ておらず、requestSignalのキャンセルはenqueue済みの
 * 再生に届かず孤立再生として後続speakをブロックし続けていた)。
 */
export function enqueuePlayback(wav: Buffer, signal?: AbortSignal): Promise<EnqueueOutcome> {
  const myGeneration = generation;
  const job = queue.then(async (): Promise<EnqueueOutcome> => {
    if (myGeneration !== generation || signal?.aborted) return "skipped"; // stopPlayback/キャンセルで破棄済み
    const file = path.join(
      os.tmpdir(),
      `coeiroink-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
    );
    await fs.writeFile(file, wav);
    try {
      if (myGeneration !== generation || signal?.aborted) return "skipped"; // 書き込み中に中断された場合も再生しない
      // 「自分がabortを観測したか」をクロージャ内のフラグで直接追跡する(child.killedのような
      // 事後的なプロセス状態ではなく、意図的なイベントそのものを見る。タスク3で確立した方針)。
      let interruptedBySignal = false;
      const onAbort = () => {
        interruptedBySignal = true;
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await playWavFile(file, signal);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      // 再生はqueueにより直列化されており、この時点で同時に走っている再生はこのジョブ自身だけ。
      // よってenqueue時点からここまでの間に世代番号が変わっていれば、それは他ならぬこの再生が
      // stopPlaybackによって中断されたことを意味する(child.killedのような、実行中のプロセスに
      // 対する事後的なフラグではなく、「stop_speakingが呼ばれた」という事実そのものを見ている)。
      return myGeneration === generation && !interruptedBySignal ? "completed" : "interrupted";
    } finally {
      await fs.unlink(file).catch(() => {});
    }
  });
  queue = job.then(
    () => undefined,
    () => undefined
  );
  return job;
}

let pipelineLock: Promise<void> = Promise.resolve();
// stopPlaybackで中断された際、進行中の合成リクエスト(coeiroink-client/voicevox-clientの
// fetch呼び出し)にも中断を伝えるためのシグナル。stopPlaybackのたびに新しいcontrollerに
// 差し替えるので、以後に開始する合成は(次のstopまで)このシグナルの影響を受けない。
let stopController = new AbortController();

/**
 * 再生待ちのキューをすべて破棄し、現在再生中の音声があれば中断する。
 * 合成の直列化ロック(pipelineLock)もリセットする: そうしないと、中断された呼び出しが
 * まだ合成リクエスト(COEIROINKへのHTTP呼び出し、最大60秒)を待っている間、新しいspeak
 * 呼び出しがそのロックの解放を待たされてしまう(中断された呼び出し自身はgeneration不一致で
 * 検知して再生キューには載らないため、ロックを先に明け渡しても安全)。
 * 合わせて getStopSignal() が返すシグナルをabortし、進行中の合成HTTPリクエストも中断する
 * (中断しないとエンジン側のCPUを最大60秒無駄に使い続けるため)。
 */
export function stopPlayback(): void {
  generation++;
  queue = Promise.resolve();
  pipelineLock = Promise.resolve();
  stopController.abort();
  stopController = new AbortController();
  if (currentChild && !currentChild.killed) {
    currentChild.kill();
  }
}

/** 現在の世代番号。speak呼び出し側がstopPlaybackによる中断を検知するために使う。 */
export function getGeneration(): number {
  return generation;
}

/**
 * 呼び出し時点の中断シグナルを返す。speak呼び出しは合成リクエストごとにこれを取得して渡す。
 * stopPlaybackが呼ばれると、その時点で取得済みのシグナルがabortされる
 * (stopPlayback以降に新しく取得したシグナルは影響を受けない、次のstopまでは有効)。
 */
export function getStopSignal(): AbortSignal {
  return stopController.signal;
}

/**
 * speak呼び出し1回分の「合成→enqueuePlayback」ループを排他的に実行する。
 * 複数のspeak呼び出しが同時に進行すると(wait:falseで特に起こりうる)、各々の断片が
 * 合成完了順に共有の再生キューへ積まれてしまい、発話が入り混じる恐れがあるため、
 * enqueueまでの処理は呼び出し単位で直列化する(実際の再生完了までは待たないので、
 * 前の呼び出しの再生中に次の呼び出しの合成を先読みすることは引き続き可能)。
 */
export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = pipelineLock.then(fn, fn);
  pipelineLock = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** speak呼び出し単位の中断がどちらの経路で発生したかを表す(interruptedByの一部として使う)。 */
export type OwnerCancelReason = "stop_speaking" | "cancel";

/**
 * speak応答/get_speak_statusのinterruptedByが取りうる値。「自分の失敗」(synthesis-error/
 * playback-error)「他者のstop_speaking({speakId})」(stop_speaking)「MCPクライアント側キャンセル」
 * (cancel)「中断なし」(null)を1つに区別する(タスク6)。index.tsとplayback.tsの両方で
 * 同じ語彙を使うため、ここで一元的にexportする。
 */
export type InterruptedBy = "synthesis-error" | "playback-error" | "stop_speaking" | "cancel" | null;

/**
 * 1回のspeak呼び出しに紐づく再生所有権。idはそのままspeakIdとして呼び出し元へ返す。
 * signalはenqueuePlayback/synthesis中断に渡す専用シグナルで、以下のいずれかでabortする:
 * - cancel()の明示呼び出し(stop_speaking({speakId})経由)→ reason()は"stop_speaking"
 * - コンストラクタに渡したrequestSignal(MCPクライアント側のキャンセル)の発火 → reason()は"cancel"
 * stopPlayback()(引数なし・全域停止)による中断はgenerationの変化で別途検知するため、
 * このsignal自体はabortしない(呼び出し元がgetGeneration()を見て判定する)。
 */
export interface PlaybackOwner {
  readonly id: string;
  readonly signal: AbortSignal;
  cancel(): void;
  reason(): OwnerCancelReason | null;
}

const activeOwners = new Map<string, PlaybackOwner>();

/**
 * 呼び出し単位の再生所有権を作成し、activeOwnersへ登録する。requestSignalを渡すと、
 * それが発火した場合もこのownerのsignalへ伝播し、reason()が"cancel"を返すようになる
 * (タスク5で確立した「requestSignalをenqueuePlaybackへ伝播する」機構を、呼び出しグローバルの
 * requestSignalではなく呼び出し単位のownerへ一本化する)。
 * 呼び出し元(speakハンドラ)は、run()完了後に必ずreleaseOwner(id)を呼んでMapから取り除くこと
 * (無制限に溜め込まないため)。
 */
export function createPlaybackOwner(requestSignal?: AbortSignal): PlaybackOwner {
  const id = randomUUID();
  const controller = new AbortController();
  let cancelReason: OwnerCancelReason | null = null;
  const onRequestAbort = () => {
    if (cancelReason === null) cancelReason = "cancel";
    controller.abort();
  };
  if (requestSignal) {
    if (requestSignal.aborted) onRequestAbort();
    else requestSignal.addEventListener("abort", onRequestAbort, { once: true });
  }
  const owner: PlaybackOwner = {
    id,
    signal: controller.signal,
    cancel() {
      if (cancelReason === null) cancelReason = "stop_speaking";
      controller.abort();
    },
    reason() {
      return cancelReason;
    },
  };
  activeOwners.set(id, owner);
  return owner;
}

/** speakハンドラのrun()完了後に必ず呼ぶ。呼び出しが終わった所有者を無制限に溜め込まないため。 */
export function releaseOwner(id: string): void {
  activeOwners.delete(id);
}

/**
 * stop_speaking({speakId})から呼ばれる。該当する所有者が見つかればcancel()してtrueを、
 * 既に終了済み/存在しないidならfalseを返す(呼び出し元はfoundとして応答に含める)。
 */
export function cancelOwner(id: string): boolean {
  const owner = activeOwners.get(id);
  if (!owner) return false;
  owner.cancel();
  return true;
}

/**
 * wait:falseで即座に返した呼び出しの実行結果を、後からget_speak_statusで引けるようにするための
 * 記録。wait:trueの応答は呼び出し自体が結果を持ち帰るためこの記録は必須ではないが、区別せず
 * 両方とも記録する(get_speak_statusはwait問わず使える)。
 */
export interface SpeakStatusRecord {
  readonly speakId: string;
  readonly startedAt: number;
  finishedAt: number | null;
  state: "running" | "completed" | "failed";
  error?: string;
  errorKind?: "synthesis" | "playback";
  readonly characters: number;
  readonly segments: number;
  segmentsPlayed: number;
  interruptedBy: InterruptedBy;
}

// 無制限に溜め込まない有限のリングバッファ(タスク7)。MapはキーのSetメソッドの挿入順序を
// 保持する(既存キーへのsetは順序を変えない)ため、「開始が古い順」の追い出しと「直近の呼び出し」
// の取得(最後のvalue)の両方をこの性質だけで実現できる。
const MAX_SPEAK_STATUS_RECORDS = 16;
const speakStatusRecords = new Map<string, SpeakStatusRecord>();

/** speakハンドラの冒頭(owner作成直後)で1回だけ呼ぶ。record自体はrun()完了までstate:"running"のまま。 */
export function recordSpeakStart(speakId: string, characters: number, segments: number): void {
  speakStatusRecords.set(speakId, {
    speakId,
    startedAt: Date.now(),
    finishedAt: null,
    state: "running",
    characters,
    segments,
    segmentsPlayed: 0,
    interruptedBy: null,
  });
  while (speakStatusRecords.size > MAX_SPEAK_STATUS_RECORDS) {
    const oldestKey = speakStatusRecords.keys().next().value;
    if (oldestKey === undefined) break;
    speakStatusRecords.delete(oldestKey);
  }
}

/**
 * speakハンドラのrun()完了時に1回だけ呼ぶ。既にリングバッファの容量超過で追い出されている
 * (recordSpeakStartからこの呼び出しまでの間に16件以上の新規speakが発行された)場合は無視する
 * ——追い出された記録を復活させると、追い出し順序(開始が古い順)の前提が崩れるため。
 */
export function recordSpeakFinish(
  speakId: string,
  patch: {
    state: "completed" | "failed";
    error?: string;
    errorKind?: "synthesis" | "playback";
    segmentsPlayed: number;
    interruptedBy: InterruptedBy;
  }
): void {
  const existing = speakStatusRecords.get(speakId);
  if (!existing) return;
  speakStatusRecords.set(speakId, { ...existing, ...patch, finishedAt: Date.now() });
}

/** get_speak_statusから呼ばれる。speakId省略時は最後に開始された呼び出しの記録を返す。 */
export function getSpeakStatus(speakId?: string): SpeakStatusRecord | undefined {
  if (speakId !== undefined) return speakStatusRecords.get(speakId);
  let latest: SpeakStatusRecord | undefined;
  for (const record of speakStatusRecords.values()) latest = record;
  return latest;
}
