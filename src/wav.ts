/**
 * RIFF/WAVEヘッダをパースして再生時間(秒)を返す。synthesize_scriptのマニフェスト向け。
 * COEIROINK/VOICEVOXはいずれも非圧縮PCM(fmtチャンクのAudioFormat=1)のWAVを返す前提。
 */
export function getWavDurationSeconds(buf: Buffer): number {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("有効なWAVファイルではありません(RIFF/WAVEヘッダが見つかりません)");
  }

  let offset = 12;
  let sampleRate: number | undefined;
  let numChannels: number | undefined;
  let bitsPerSample: number | undefined;
  let dataSize: number | undefined;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === "fmt ") {
      numChannels = buf.readUInt16LE(chunkStart + 2);
      sampleRate = buf.readUInt32LE(chunkStart + 4);
      bitsPerSample = buf.readUInt16LE(chunkStart + 14);
    } else if (chunkId === "data") {
      dataSize = chunkSize;
    }
    // チャンクは偶数バイトにパディングされる
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (sampleRate === undefined || numChannels === undefined || bitsPerSample === undefined || dataSize === undefined) {
    throw new Error("WAVファイルにfmt/dataチャンクが見つかりません");
  }
  const bytesPerSecond = sampleRate * numChannels * (bitsPerSample / 8);
  if (bytesPerSecond <= 0) throw new Error("WAVファイルのfmtチャンクが不正です(サンプリングレート/ビット深度が0)");
  return dataSize / bytesPerSecond;
}
