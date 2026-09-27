import { test } from "node:test";
import assert from "node:assert/strict";
import { splitIntoSegments, MAX_SPEAK_SEGMENTS } from "../dist/segment.js";

test("short text stays a single segment", () => {
  assert.deepEqual(splitIntoSegments("短いテキストです"), ["短いテキストです"]);
});

test("splits on halfwidth/fullwidth punctuation and newlines", () => {
  assert.deepEqual(splitIntoSegments("こんにちは。今日は良い天気ですね!散歩に行きませんか?"), [
    "こんにちは。",
    "今日は良い天気ですね!",
    "散歩に行きませんか?",
  ]);
  assert.deepEqual(splitIntoSegments("こんにちは！元気ですか？はい、元気です。"), [
    "こんにちは！",
    "元気ですか？",
    "はい、元気です。",
  ]);
  assert.deepEqual(splitIntoSegments("改行を含む\nテキストの\nテストです"), [
    "改行を含む",
    "テキストの",
    "テストです",
  ]);
});

test("chunks a sentence longer than maxLength", () => {
  const long = "あ".repeat(200);
  const segments = splitIntoSegments(long, 80);
  assert.deepEqual(
    segments.map((s) => s.length),
    [80, 80, 40]
  );
  assert.equal(segments.join(""), long);
});

test("consecutive punctuation marks each become their own segment (no empty segments)", () => {
  // 区切り文字が連続すると1文字だけの断片が並ぶ(空文字列の断片は出ない)
  assert.deepEqual(splitIntoSegments("わあ!!!すごい。。。"), ["わあ!", "!", "!", "すごい。", "。", "。"]);
});

test("accepts a text whose segment count is exactly at MAX_SPEAK_SEGMENTS", () => {
  const text = "あ。".repeat(MAX_SPEAK_SEGMENTS);
  const segments = splitIntoSegments(text);
  assert.equal(segments.length, MAX_SPEAK_SEGMENTS);
});

test("rejects a text that would split into more than MAX_SPEAK_SEGMENTS segments", () => {
  const text = "あ。".repeat(MAX_SPEAK_SEGMENTS + 1);
  assert.throws(() => splitIntoSegments(text), /断片数が多すぎます/);
});

test("whitespace-only input (including U+3000 full-width space) splits into zero segments", () => {
  // z.string().min(1)は通過するが、これがspeak/synthesizeの入口で無警告の"再生なし"に
  // 化けていた根本原因(旧N6)。index.ts側のrefine()で入口拒否するようになったため、
  // ここでは「トリムすると空になる入力は0断片になる」という前提条件だけを確認する。
  assert.deepEqual(splitIntoSegments("　  　"), []);
  assert.deepEqual(splitIntoSegments("   \n\t  "), []);
});
