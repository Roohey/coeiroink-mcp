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

const ENGINE_LABEL = "COEIROINK";

/** engine_info への到達可否だけを見る。例外を投げず常に結果を返す(check_statusツール向け)。 */
export async function checkStatus(baseUrl: string): Promise<{ reachable: boolean; engineInfo?: unknown }> {
  try {
    const res = await fetch(`${baseUrl}/v1/engine_info`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { reachable: false };
    return { reachable: true, engineInfo: await res.json().catch(() => undefined) };
  } catch {
    return { reachable: false };
  }
}

export async function listSpeakers(baseUrl: string): Promise<Speaker[]> {
  const res = await guardedFetch(
    ENGINE_LABEL,
    `${baseUrl}/v1/speakers`,
    { signal: AbortSignal.timeout(8000) },
    baseUrl
  );
  if (!res.ok) throw new Error(`COEIROINK /v1/speakers HTTP ${res.status}: ${await safeText(res)}`);
  const list = (await res.json()) as {
    speakerName: string;
    speakerUuid: string;
    styles?: { styleName: string; styleId: number }[];
  }[];
  return list.map((sp) => ({
    name: sp.speakerName,
    uuid: sp.speakerUuid,
    styles: (sp.styles ?? []).map((st) => ({ id: st.styleId, name: st.styleName })),
  }));
}

export async function synthesize(baseUrl: string, params: SynthesisParams, signal?: AbortSignal): Promise<Buffer> {
  const timeoutSignal = AbortSignal.timeout(60000);
  const combined = signal ? combineSignals(timeoutSignal, signal) : { signal: timeoutSignal, dispose: () => {} };
  try {
    const res = await guardedFetch(
      ENGINE_LABEL,
      `${baseUrl}/v1/synthesis`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: combined.signal,
      },
      baseUrl
    );
    if (!res.ok) throw new Error(`COEIROINK /v1/synthesis HTTP ${res.status}: ${await safeText(res)}`);
    return readBodyWithLimit(res, MAX_SYNTHESIS_RESPONSE_BYTES, ENGINE_LABEL);
  } finally {
    combined.dispose();
  }
}

export const coeiroinkClient: TtsEngineClient = { checkStatus, listSpeakers, synthesize };
