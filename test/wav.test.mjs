import { test } from "node:test";
import assert from "node:assert/strict";
import { getWavDurationSeconds } from "../dist/wav.js";

/** テスト用の最小限のPCM WAVバッファを組み立てる。 */
function buildWav({ sampleRate = 44100, numChannels = 1, bitsPerSample = 16, dataSize = 0, extraChunk } = {}) {
  const fmtChunk = Buffer.alloc(24);
  fmtChunk.write("fmt ", 0, "ascii");
  fmtChunk.writeUInt32LE(16, 4); // subchunk1Size
  fmtChunk.writeUInt16LE(1, 8); // audioFormat: PCM
  fmtChunk.writeUInt16LE(numChannels, 10);
  fmtChunk.writeUInt32LE(sampleRate, 12);
  fmtChunk.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 16); // byteRate
  fmtChunk.writeUInt16LE(numChannels * (bitsPerSample / 8), 20); // blockAlign
  fmtChunk.writeUInt16LE(bitsPerSample, 22);

  const dataChunk = Buffer.alloc(8 + dataSize);
  dataChunk.write("data", 0, "ascii");
  dataChunk.writeUInt32LE(dataSize, 4);

  const pieces = [extraChunk ?? Buffer.alloc(0), fmtChunk, dataChunk];
  const body = Buffer.concat(pieces);

  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + body.length, 4);
  header.write("WAVE", 8, "ascii");

  return Buffer.concat([header, body]);
}

test("getWavDurationSeconds: computes duration from fmt/data chunks (16bit mono)", () => {
  // 44100Hz, mono, 16bit -> 1秒 = 88200バイト
  const wav = buildWav({ sampleRate: 44100, numChannels: 1, bitsPerSample: 16, dataSize: 88200 });
  assert.equal(getWavDurationSeconds(wav), 1);
});

test("getWavDurationSeconds: accounts for channel count and bit depth", () => {
  // 22050Hz, stereo, 16bit -> 1バイト/サンプル/ch * 2ch * 2byte = 4byte/フレーム, 0.5秒分
  const wav = buildWav({ sampleRate: 22050, numChannels: 2, bitsPerSample: 16, dataSize: 22050 * 2 * 2 * 0.5 });
  assert.equal(getWavDurationSeconds(wav), 0.5);
});

test("getWavDurationSeconds: skips unrelated chunks with odd-length padding correctly", () => {
  // fmt/dataの前に奇数長のLISTチャンクを挟み、パディング計算がずれないことを確認する
  // (RIFF仕様上、奇数長チャンクの直後には実ファイル上にも1バイトのパディングが入る)
  const oddPayload = Buffer.from("abc"); // 3バイト(奇数)
  const listChunk = Buffer.concat([Buffer.from("LIST"), Buffer.alloc(4), oddPayload, Buffer.alloc(1)]);
  listChunk.writeUInt32LE(oddPayload.length, 4);
  const wav = buildWav({ sampleRate: 44100, numChannels: 1, bitsPerSample: 16, dataSize: 88200, extraChunk: listChunk });
  assert.equal(getWavDurationSeconds(wav), 1);
});

test("getWavDurationSeconds: throws on non-WAV input", () => {
  assert.throws(() => getWavDurationSeconds(Buffer.from("not a wav file at all")), /RIFF\/WAVE/);
});

test("getWavDurationSeconds: throws when fmt/data chunks are missing", () => {
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4, 4);
  header.write("WAVE", 8, "ascii");
  assert.throws(() => getWavDurationSeconds(header), /fmt\/data/);
});
