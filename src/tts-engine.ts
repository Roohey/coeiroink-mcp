export class EngineConnectionError extends Error {}

export interface SpeakerStyle {
  id: number;
  name: string;
}

export interface Speaker {
  name: string;
  uuid: string;
  styles: SpeakerStyle[];
}

export interface SynthesisParams {
  speakerUuid: string;
  styleId: number;
  text: string;
  speedScale: number;
  volumeScale: number;
  pitchScale: number;
  intonationScale: number;
  prePhonemeLength: number;
  postPhonemeLength: number;
  outputSamplingRate: number;
}

/**
 * TTSエンジンに求める最小限の操作。COEIROINK/VOICEVOX(及びそのAPI互換エンジン)の
 * 実装がこのインターフェースを満たす。呼び出し側(index.ts)はこのインターフェース越しに
 * のみエンジン機能を使う。
 */
export interface TtsEngineClient {
  checkStatus(baseUrl: string): Promise<{ reachable: boolean; engineInfo?: unknown }>;
  listSpeakers(baseUrl: string): Promise<Speaker[]>;
  /** signalを渡すと、合成中のHTTPリクエストをその外部シグナルでも中断できるようになる(stop_speaking向け)。 */
  synthesize(baseUrl: string, params: SynthesisParams, signal?: AbortSignal): Promise<Buffer>;
}

export type TtsEngineName = "coeiroink" | "voicevox";

export const TTS_ENGINE_NAMES = ["coeiroink", "voicevox"] as const satisfies readonly TtsEngineName[];

// "AbortError"はここでは接続失敗扱いにしない: stop_speaking/MCPクライアント側キャンセルによる
// 意図的な中断もAbortErrorとして現れるため、「エンジンが起動していません」は不正確な誤報になる。
// これらの呼び出し元(speak/synthesize_script)はgeneration/signal.abortedを見て中断として扱うので、
// AbortErrorは変換せずそのまま伝播させる。
function isConnectionRefusal(e: unknown): boolean {
  const err = e as { cause?: { code?: string } };
  return (
    err?.cause?.code === "ECONNREFUSED" || err?.cause?.code === "ENOTFOUND" || err?.cause?.code === "ECONNRESET"
  );
}

// AbortSignal.timeout()が実際に発火した場合はDOMExceptionのnameが"TimeoutError"になり、
// combineSignalsで他のシグナルと結合してもreasonとして伝播するため、外部からのAbort(name無し
// またはAbortError)と確実に区別できる。エンジンは起動しているが応答が遅い/固まっているケースであり、
// 「起動していません」は誤解を招くため別メッセージにする。
function isRequestTimeout(e: unknown): boolean {
  const err = e as { name?: string };
  return err?.name === "TimeoutError";
}

function connectionErrorMessage(engineLabel: string, url: string): string {
  return `${engineLabel}エンジンが起動していません。${engineLabel}を起動してから再試行してください。(接続先: ${url})`;
}

function timeoutErrorMessage(engineLabel: string, url: string): string {
  return `${engineLabel}へのリクエストがタイムアウトしました。エンジンは起動していますが応答がありません(処理が重い、フリーズしている等)。(接続先: ${url})`;
}

/**
 * 接続失敗・タイムアウトを EngineConnectionError に変換した上でfetchする共通ヘルパー。各エンジンクライアントから使う。
 * 呼び出し元による意図的なAbort(stop_speaking/MCPクライアント側キャンセル)はここでは変換せず、
 * そのまま呼び出し元に伝える(呼び出し元がgeneration/signal.abortedを見て中断として扱う)。
 */
export async function guardedFetch(
  engineLabel: string,
  url: string,
  init: RequestInit,
  baseUrl: string
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (isConnectionRefusal(e)) throw new EngineConnectionError(connectionErrorMessage(engineLabel, baseUrl));
    if (isRequestTimeout(e)) throw new EngineConnectionError(timeoutErrorMessage(engineLabel, baseUrl));
    throw e;
  }
}

export async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "(no body)";
  }
}

// 単発の合成応答(WAV)サイズに対する安全弁。話速設定等の影響で異常に長い音声が返ってきても
// ヒープ枯渇に至らないよう歯止めをかける。エンジン未接続のため一次防御としての広め値、将来実機で
// 確認したら調整可(overridesSchemaの数値上限と同じ方針)。
export const MAX_SYNTHESIS_RESPONSE_BYTES = 100 * 1024 * 1024; // 100MiB

/**
 * レスポンスボディをストリーミングで読みながら上限バイト数を監視し、超過した時点で即座に
 * 読み取りを中断してエラーを投げる(res.arrayBuffer()のように本文を全量読み終えてから
 * 事後チェックすると、チェックの時点で既に巨大なバッファがメモリに確保済みになってしまい、
 * 上限を設けた意味がなくなるため)。
 */
export async function readBodyWithLimit(res: Response, maxBytes: number, engineLabel: string): Promise<Buffer> {
  const body = res.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel(`response exceeds ${maxBytes} byte limit`).catch(() => {});
      throw new Error(
        `${engineLabel}からの応答サイズが上限(${maxBytes}バイト)を超えたため読み取りを中断しました。テキストを分割するか話速を上げるなどして再試行してください。`
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/**
 * 2つのAbortSignalのどちらかがabortしたら発火する結合シグナルを作る。
 * (Node 18系との互換性のため、AbortSignal.anyには依存せず自前で実装する)
 *
 * bには呼び出しごとにgetStopSignal()等の長寿命なシグナルが渡されうる。片方がabortした
 * 時点で{once:true}により発火した側のリスナーは自動で外れるが、abortしなかった側の
 * リスナーはそのシグナルに残り続けてしまう。特にbが長寿命だと、リクエストのたびに
 * リスナーが積み上がるリークになるため、呼び出し元はリクエスト完了後に必ずdispose()を
 * 呼んでリスナーを外すこと(早期returnの2ケースはリスナーを付けていないのでdisposeは空関数)。
 */
export function combineSignals(a: AbortSignal, b: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  if (a.aborted) return { signal: a, dispose: () => {} };
  if (b.aborted) return { signal: b, dispose: () => {} };
  const controller = new AbortController();
  const onAbortA = () => controller.abort(a.reason);
  const onAbortB = () => controller.abort(b.reason);
  a.addEventListener("abort", onAbortA, { once: true });
  b.addEventListener("abort", onAbortB, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      a.removeEventListener("abort", onAbortA);
      b.removeEventListener("abort", onAbortB);
    },
  };
}
