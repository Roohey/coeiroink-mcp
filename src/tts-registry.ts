import { coeiroinkClient } from "./coeiroink-client.js";
import { voicevoxClient } from "./voicevox-client.js";
import { TTS_ENGINE_NAMES, type TtsEngineClient, type TtsEngineName } from "./tts-engine.js";

export const engineClients: Record<TtsEngineName, TtsEngineClient> = {
  coeiroink: coeiroinkClient,
  voicevox: voicevoxClient,
};

/**
 * 型上はTtsEngineNameに絞られているが、profiles等ファイル由来の値が検証をすり抜けた場合に
 * 備え、実行時にも未知のengine名を明示的なエラーにする(素通りさせるとsynthesize呼び出しが
 * "Cannot read properties of undefined"のような無関係なエラーに化けてしまうため)。
 */
export function getEngineClient(engine: TtsEngineName): TtsEngineClient {
  if (!Object.hasOwn(engineClients, engine)) {
    throw new Error(
      `不明なTTSエンジンです: "${engine}"。${TTS_ENGINE_NAMES.map((n) => `"${n}"`).join("/")}のいずれかを指定してください。`
    );
  }
  return engineClients[engine];
}
