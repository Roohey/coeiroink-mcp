import {
  combineSignals,
  guardedFetch,
  MAX_SYNTHESIS_RESPONSE_BYTES,
  readBodyWithLimit,
  safeText,
  type Speaker,
  type SynthesisParams,
  type TtsEngineClient,
} from "./tts-engine.js";

const ENGINE_LABEL = "VOICEVOX";

/** /version への到達可否だけを見る。例外を投げず常に結果を返す(check_statusツール向け)。 */
export async function checkStatus(baseUrl: string): Promise<{ reachable: boolean; engineInfo?: unknown }> {
  try {
    const res = await fetch(`${baseUrl}/version`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { reachable: false };
    return { reachable: true, engineInfo: await res.json().catch(() => undefined) };
  } catch {
    return { reachable: false };
  }
}

export async function listSpeakers(baseUrl: string): Promise<Speaker[]> {
  const res = await guardedFetch(ENGINE_LABEL, `${baseUrl}/speakers`, { signal: AbortSignal.timeout(8000) }, baseUrl);
  if (!res.ok) throw new Error(`VOICEVOX /speakers HTTP ${res.status}: ${await safeText(res)}`);
  const list = (await res.json()) as {
    name: string;
    speaker_uuid: string;
    styles?: { name: string; id: number }[];
  }[];
  return list.map((sp) => ({
    name: sp.name,
    uuid: sp.speaker_uuid,
    styles: (sp.styles ?? []).map((st) => ({ id: st.id, name: st.name })),
  }));
}

/**
 * VOICEVOXは /audio_query でテキスト・話者から音声合成用クエリを生成し、
 * そのクエリに話速等を上書きした上で /synthesis に渡す2段階のAPI。
 * params.styleId を VOICEVOX の "speaker" (話者+スタイルを一体で表す番号) として使う。
 * params.speakerUuid は VOICEVOX の合成APIでは使わない(list_speakers表示用)。
 */
export async function synthesize(baseUrl: string, params: SynthesisParams, signal?: AbortSignal): Promise<Buffer> {
  const speaker = params.styleId;

  const queryUrl = new URL(`${baseUrl}/audio_query`);
  queryUrl.searchParams.set("text", params.text);
  queryUrl.searchParams.set("speaker", String(speaker));
  const queryTimeoutSignal = AbortSignal.timeout(15000);
  const combinedQuery = signal
    ? combineSignals(queryTimeoutSignal, signal)
    : { signal: queryTimeoutSignal, dispose: () => {} };
  let query: Record<string, unknown>;
  try {
    const queryRes = await guardedFetch(
      ENGINE_LABEL,
      queryUrl.toString(),
      { method: "POST", signal: combinedQuery.signal },
      baseUrl
    );
    if (!queryRes.ok) throw new Error(`VOICEVOX /audio_query HTTP ${queryRes.status}: ${await safeText(queryRes)}`);
    query = (await queryRes.json()) as Record<string, unknown>;
  } finally {
    combinedQuery.dispose();
  }
  query.speedScale = params.speedScale;
  query.volumeScale = params.volumeScale;
  query.pitchScale = params.pitchScale;
  query.intonationScale = params.intonationScale;
  query.prePhonemeLength = params.prePhonemeLength;
  query.postPhonemeLength = params.postPhonemeLength;
  query.outputSamplingRate = params.outputSamplingRate;

  const synthUrl = new URL(`${baseUrl}/synthesis`);
  synthUrl.searchParams.set("speaker", String(speaker));
  const synthTimeoutSignal = AbortSignal.timeout(60000);
  const combinedSynth = signal
    ? combineSignals(synthTimeoutSignal, signal)
    : { signal: synthTimeoutSignal, dispose: () => {} };
  try {
    const synthRes = await guardedFetch(
      ENGINE_LABEL,
      synthUrl.toString(),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/wav" },
        body: JSON.stringify(query),
        signal: combinedSynth.signal,
      },
      baseUrl
    );
    if (!synthRes.ok) throw new Error(`VOICEVOX /synthesis HTTP ${synthRes.status}: ${await safeText(synthRes)}`);
    return readBodyWithLimit(synthRes, MAX_SYNTHESIS_RESPONSE_BYTES, ENGINE_LABEL);
  } finally {
    combinedSynth.dispose();
  }
}

export const voicevoxClient: TtsEngineClient = { checkStatus, listSpeakers, synthesize };
