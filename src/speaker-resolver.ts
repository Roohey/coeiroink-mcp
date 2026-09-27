import type { Speaker, SpeakerStyle, TtsEngineClient } from "./tts-engine.js";

/** speakersからname完全一致の話者を1件だけ探す。0件/複数件は利用可能な選択肢を添えてエラーにする。 */
export function findSpeakerByName(speakers: Speaker[], speakerName: string): Speaker {
  const matches = speakers.filter((s) => s.name === speakerName);
  if (matches.length === 0) {
    const names = speakers.map((s) => s.name).join(", ") || "(話者が1件もありません)";
    throw new Error(`話者「${speakerName}」が見つかりません。利用可能な話者: ${names}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `話者「${speakerName}」に一致する話者が複数見つかりました(uuid: ${matches.map((m) => m.uuid).join(", ")})。speakerUuidで直接指定してください。`
    );
  }
  return matches[0];
}

/**
 * 話者内のスタイルをname完全一致で探す。styleName省略時はその話者の最初のスタイルを既定として返す
 * (COEIROINK/VOICEVOXともstyles[0]がその話者の基本スタイルであることが多いため)。
 */
export function resolveStyle(speaker: Speaker, styleName?: string): SpeakerStyle {
  if (styleName === undefined) {
    if (speaker.styles.length === 0) throw new Error(`話者「${speaker.name}」にスタイルが登録されていません。`);
    return speaker.styles[0];
  }
  const matches = speaker.styles.filter((st) => st.name === styleName);
  if (matches.length === 0) {
    const names = speaker.styles.map((st) => st.name).join(", ") || "(スタイルが1件もありません)";
    throw new Error(`話者「${speaker.name}」にスタイル「${styleName}」が見つかりません。利用可能なスタイル: ${names}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `話者「${speaker.name}」のスタイル「${styleName}」に一致するものが複数見つかりました(id: ${matches.map((m) => m.id).join(", ")})。styleIdで直接指定してください。`
    );
  }
  return matches[0];
}

/**
 * speak/synthesize向け: speakerName/styleNameからspeakerUuid/styleIdを解決する。
 * speakerName省略時はfallbackSpeakerUuid(呼び出し時点の実効設定の話者)を基準にstyleNameだけ解決する。
 */
export async function resolveNamedSpeaker(
  client: TtsEngineClient,
  url: string,
  fallbackSpeakerUuid: string,
  speakerName: string | undefined,
  styleName: string | undefined
): Promise<{ speakerUuid: string; styleId: number }> {
  const speakers = await client.listSpeakers(url);
  const speaker =
    speakerName !== undefined ? findSpeakerByName(speakers, speakerName) : speakers.find((s) => s.uuid === fallbackSpeakerUuid);
  if (!speaker) {
    throw new Error(
      `現在の既定話者(uuid: ${fallbackSpeakerUuid})がエンジンの話者一覧に見つかりません。styleNameを使う場合はspeakerNameも指定してください。`
    );
  }
  const style = resolveStyle(speaker, styleName);
  return { speakerUuid: speaker.uuid, styleId: style.id };
}
