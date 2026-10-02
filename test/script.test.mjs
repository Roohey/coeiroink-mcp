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

// ---- scriptFormat (Issue #1: 行ごとのスタイル指定) ----

test("parseScript: an explicit 'legacy' format behaves exactly like the default", () => {
  const script = "# c\n話者A,げんき,こんにちは\n\n話者B,本文";
  assert.deepEqual(parseScript(script, "legacy"), parseScript(script));
});

test("parseScript (legacy): a 3-field-looking line keeps everything after the first comma as text (no style)", () => {
  const lines = parseScript("話者A,げんき,こんにちは");
  assert.deepEqual(lines, [{ lineNumber: 1, speakerName: "話者A", text: "げんき,こんにちは" }]);
  assert.equal("styleName" in lines[0], false);
});

test("parseScript (styled): splits speaker, style, and text on the first two commas", () => {
  const lines = parseScript("話者A,げんき,こんにちは", "styled");
  assert.deepEqual(lines, [{ lineNumber: 1, speakerName: "話者A", styleName: "げんき", text: "こんにちは" }]);
});

test("parseScript (styled): an empty style field means 'first style' (no styleName property)", () => {
  const lines = parseScript("話者A,,こんにちは", "styled");
  assert.deepEqual(lines, [{ lineNumber: 1, speakerName: "話者A", text: "こんにちは" }]);
});

test("parseScript (styled): a whitespace-only style field is treated the same as an empty one", () => {
  const lines = parseScript("話者A,  　 ,こんにちは", "styled");
  assert.deepEqual(lines, [{ lineNumber: 1, speakerName: "話者A", text: "こんにちは" }]);
});

test("parseScript (styled): trims surrounding whitespace on every field", () => {
  const lines = parseScript("  話者A  ,  げんき  ,  こんにちは  ", "styled");
  assert.deepEqual(lines, [{ lineNumber: 1, speakerName: "話者A", styleName: "げんき", text: "こんにちは" }]);
});

test("parseScript (styled): commas after the second one stay in the text", () => {
  const lines = parseScript("話者A,げんき,はい,どうぞ", "styled");
  assert.equal(lines[0].styleName, "げんき");
  assert.equal(lines[0].text, "はい,どうぞ");
});

test("parseScript (styled): quotes are ordinary characters (no CSV quoting/escaping)", () => {
  const lines = parseScript('話者A,げんき,"こんにちは"', "styled");
  assert.equal(lines[0].text, '"こんにちは"');
  const quotedComma = parseScript('話者A,げんき,"はい,どうぞ"', "styled");
  assert.equal(quotedComma[0].text, '"はい,どうぞ"');
});

test("parseScript (styled): a line with only one comma is rejected (not enough separators), with its line number", () => {
  assert.throws(() => parseScript("話者A,げんき,ok\n話者A,こんにちは", "styled"), /2行目.*カンマが2つ必要です/s);
});

test("parseScript (styled): a line with no comma is rejected", () => {
  assert.throws(() => parseScript("カンマのない行", "styled"), /1行目.*カンマが2つ必要です/s);
});

test("parseScript (styled): rejects an empty speaker name", () => {
  assert.throws(() => parseScript(",げんき,本文", "styled"), /話者名が空です/);
  assert.throws(() => parseScript("  ,,本文", "styled"), /話者名が空です/);
});

test("parseScript (styled): rejects empty or whitespace-only text", () => {
  assert.throws(() => parseScript("話者A,げんき,", "styled"), /セリフが空です/);
  assert.throws(() => parseScript("話者A,げんき,   ", "styled"), /セリフが空です/);
  assert.throws(() => parseScript("話者A,,", "styled"), /セリフが空です/);
});

test("parseScript (styled): ignores blank/#-comment lines but keeps original line numbers (including in errors)", () => {
  const lines = parseScript("# コメント\n\n話者A,げんき,本文\n   # 字下げコメント\n話者B,,二つ目", "styled");
  assert.deepEqual(
    lines.map((l) => [l.lineNumber, l.speakerName, l.styleName, l.text]),
    [
      [3, "話者A", "げんき", "本文"],
      [5, "話者B", undefined, "二つ目"],
    ]
  );
  assert.throws(() => parseScript("# c\n\n話者A,区切り不足", "styled"), /3行目/);
});

test("parseScript (styled): collects all line errors into a single error", () => {
  assert.throws(() => parseScript("話者A,げんき,ok\n区切り不足,x\n,,本文\n話者A,げんき,", "styled"), (e) => {
    assert.match(e.message, /2行目/);
    assert.match(e.message, /3行目/);
    assert.match(e.message, /4行目/);
    assert.doesNotMatch(e.message, /1行目/);
    return true;
  });
});

test("parseScript (styled): keeps the MAX_SCRIPT_LINES limit", () => {
  const atLimit = Array.from({ length: MAX_SCRIPT_LINES }, (_, i) => `話者A,げんき,${i}`).join("\n");
  assert.equal(parseScript(atLimit, "styled").length, MAX_SCRIPT_LINES);
  const overLimit = Array.from({ length: MAX_SCRIPT_LINES + 1 }, (_, i) => `話者A,げんき,${i}`).join("\n");
  assert.throws(() => parseScript(overLimit, "styled"), /行数が多すぎます/);
});

test("parseScript (styled): MAX_SCRIPT_TOTAL_CHARS counts only the text (not speaker/style names)", () => {
  const atLimit = `話者A,げんき,${"あ".repeat(MAX_SCRIPT_TOTAL_CHARS)}`;
  assert.equal(parseScript(atLimit, "styled")[0].text.length, MAX_SCRIPT_TOTAL_CHARS);
  const overLimit = `話者A,げんき,${"あ".repeat(MAX_SCRIPT_TOTAL_CHARS + 1)}`;
  assert.throws(() => parseScript(overLimit, "styled"), /合計文字数が多すぎます/);
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
