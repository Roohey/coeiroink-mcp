import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScript, sanitizeFileNamePart, MAX_SCRIPT_LINES, MAX_SCRIPT_TOTAL_CHARS } from "../dist/script.js";

test("parseScript: parses a single valid line", () => {
  const lines = parseScript("つくよみちゃん,こんにちは");
  assert.deepEqual(lines, [{ lineNumber: 1, speakerName: "つくよみちゃん", text: "こんにちは" }]);
});

test("parseScript: parses multiple lines and preserves order/line numbers", () => {
  const lines = parseScript("話者A,一行目\n話者B,二行目\n話者A,三行目");
  assert.deepEqual(
    lines.map((l) => [l.lineNumber, l.speakerName, l.text]),
    [
      [1, "話者A", "一行目"],
      [2, "話者B", "二行目"],
      [3, "話者A", "三行目"],
    ]
  );
});

test("parseScript: ignores blank lines and #-comment lines, but keeps original line numbers", () => {
  const lines = parseScript("# コメント\n\n話者A,本文\n   \n# もう一つのコメント\n話者B,二つ目");
  assert.deepEqual(
    lines.map((l) => [l.lineNumber, l.speakerName, l.text]),
    [
      [3, "話者A", "本文"],
      [6, "話者B", "二つ目"],
    ]
  );
});

test("parseScript: trims surrounding whitespace on speaker name and text", () => {
  const lines = parseScript("  話者A  ,   本文です   ");
  assert.deepEqual(lines, [{ lineNumber: 1, speakerName: "話者A", text: "本文です" }]);
});

test("parseScript: only the first comma separates speaker from text (text may itself contain commas)", () => {
  const lines = parseScript("話者A,こんにちは、元気ですか、はい");
  assert.equal(lines[0].text, "こんにちは、元気ですか、はい");
});

test("parseScript: handles CRLF, CR, and LF line endings uniformly", () => {
  assert.equal(parseScript("話者A,一\r\n話者A,二").length, 2);
  assert.equal(parseScript("話者A,一\r話者A,二").length, 2);
  assert.equal(parseScript("話者A,一\n話者A,二").length, 2);
});

test("parseScript: rejects a line with no comma, reporting the 1-based line number", () => {
  assert.throws(() => parseScript("話者A,ok\nこれはカンマがない行"), /2行目.*カンマがありません/s);
});

test("parseScript: rejects an empty speaker name", () => {
  assert.throws(() => parseScript(",本文だけ"), /話者名が空です/);
});

test("parseScript: rejects empty text (speaker name with nothing after the comma)", () => {
  assert.throws(() => parseScript("話者A,"), /セリフが空です/);
});

test("parseScript: collects all line errors into a single error instead of stopping at the first", () => {
  assert.throws(() => parseScript("話者A,ok\n不正な行\n,本文だけ"), (e) => {
    assert.match(e.message, /2行目/);
    assert.match(e.message, /3行目/);
    return true;
  });
});

test("parseScript: rejects a script with zero valid lines (all blank/comments)", () => {
  assert.throws(() => parseScript("# only a comment\n\n   "), /有効な行が1つもありません/);
});

test("parseScript: rejects a script exceeding MAX_SCRIPT_LINES", () => {
  const script = Array.from({ length: MAX_SCRIPT_LINES + 1 }, (_, i) => `話者A,${i}`).join("\n");
  assert.throws(() => parseScript(script), /行数が多すぎます/);
});

test("parseScript: accepts a script at exactly MAX_SCRIPT_LINES", () => {
  const script = Array.from({ length: MAX_SCRIPT_LINES }, (_, i) => `話者A,${i}`).join("\n");
  assert.equal(parseScript(script).length, MAX_SCRIPT_LINES);
});

test("parseScript: rejects a script exceeding MAX_SCRIPT_TOTAL_CHARS even with few lines", () => {
  const script = `話者A,${"あ".repeat(MAX_SCRIPT_TOTAL_CHARS + 1)}`;
  assert.throws(() => parseScript(script), /合計文字数が多すぎます/);
});

test("parseScript: accepts a script at exactly MAX_SCRIPT_TOTAL_CHARS", () => {
  const script = `話者A,${"あ".repeat(MAX_SCRIPT_TOTAL_CHARS)}`;
  assert.equal(parseScript(script)[0].text.length, MAX_SCRIPT_TOTAL_CHARS);
});

test("sanitizeFileNamePart: replaces Windows-illegal filename characters with underscores", () => {
  assert.equal(sanitizeFileNamePart('a\\b/c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
});

test("sanitizeFileNamePart: leaves normal (including Japanese) characters untouched", () => {
  assert.equal(sanitizeFileNamePart("つくよみちゃん"), "つくよみちゃん");
});

test("sanitizeFileNamePart: truncates to 40 characters", () => {
  const long = "a".repeat(60);
  assert.equal(sanitizeFileNamePart(long), "a".repeat(40));
});
