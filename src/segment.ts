// 句点等の直後で分割する(区切り文字自体は前の断片に残す)
const SENTENCE_BOUNDARY = /(?<=[。！？!?\n])/;
const DEFAULT_MAX_SEGMENT_LENGTH = 80;

// speakは断片ごとに1回の合成HTTPリクエストを発行する。句読点が極端に密な入力
// (例: 1〜2文字ごとに句点が入る)では、入力文字数の上限(MAX_SPEAK_TEXT_CHARS、src/index.ts)
// だけでは断片数を抑えきれない(200,000文字が7msで2,500断片としてqueueされることを確認済み)。
// そのため断片数にも独立した上限を設け、合成を始める前に早期リジェクトする。
export const MAX_SPEAK_SEGMENTS = 500;

/**
 * テキストを「。」「!」「?」(全角/半角)・改行、および最大文字数で分割する。
 * speakツールの疑似ストリーミング再生向け: 先頭の断片から順に合成→再生することで、
 * 全文の合成完了を待たずに再生を開始できるようにする。
 */
export function splitIntoSegments(text: string, maxLength = DEFAULT_MAX_SEGMENT_LENGTH): string[] {
  const sentences = text
    .split(SENTENCE_BOUNDARY)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const segments: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxLength) {
      segments.push(sentence);
      continue;
    }
    for (let i = 0; i < sentence.length; i += maxLength) {
      segments.push(sentence.slice(i, i + maxLength));
    }
  }
  if (segments.length > MAX_SPEAK_SEGMENTS) {
    throw new Error(
      `テキストの分割後の断片数が多すぎます(${segments.length}断片 > 上限${MAX_SPEAK_SEGMENTS}断片)。テキストを分割して実行してください。`
    );
  }
  return segments;
}
