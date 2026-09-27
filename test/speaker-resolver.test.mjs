import { test } from "node:test";
import assert from "node:assert/strict";
import { findSpeakerByName, resolveStyle, resolveNamedSpeaker } from "../dist/speaker-resolver.js";

const SPEAKERS = [
  {
    name: "つくよみちゃん",
    uuid: "uuid-1",
    styles: [
      { id: 0, name: "れいせい" },
      { id: 1, name: "げんき" },
    ],
  },
  { name: "AIあいちゃん", uuid: "uuid-2", styles: [{ id: 10, name: "ノーマル" }] },
  { name: "スタイルなし", uuid: "uuid-3", styles: [] },
];

test("findSpeakerByName: finds an exact match", () => {
  const speaker = findSpeakerByName(SPEAKERS, "AIあいちゃん");
  assert.equal(speaker.uuid, "uuid-2");
});

test("findSpeakerByName: throws with the list of available names when not found", () => {
  assert.throws(() => findSpeakerByName(SPEAKERS, "存在しない話者"), /つくよみちゃん.*AIあいちゃん/s);
});

test("findSpeakerByName: throws when the name matches more than one speaker", () => {
  const dup = [...SPEAKERS, { name: "AIあいちゃん", uuid: "uuid-2b", styles: [] }];
  assert.throws(() => findSpeakerByName(dup, "AIあいちゃん"), /複数見つかりました/);
});

test("resolveStyle: defaults to the speaker's first style when styleName is omitted", () => {
  const style = resolveStyle(SPEAKERS[0]);
  assert.deepEqual(style, { id: 0, name: "れいせい" });
});

test("resolveStyle: resolves an exact styleName match", () => {
  const style = resolveStyle(SPEAKERS[0], "げんき");
  assert.deepEqual(style, { id: 1, name: "げんき" });
});

test("resolveStyle: throws listing available styles when styleName does not match", () => {
  assert.throws(() => resolveStyle(SPEAKERS[0], "存在しないスタイル"), /れいせい.*げんき/s);
});

test("resolveStyle: throws when the speaker has no styles and styleName is omitted", () => {
  assert.throws(() => resolveStyle(SPEAKERS[2]), /スタイルが登録されていません/);
});

test("resolveStyle: an empty styleName is treated as a real (non-matching) name, not as omitted", () => {
  // ""はundefinedではないので、最初のスタイルへの暗黙フォールバックではなく
  // 通常の不一致エラーになるべき(空文字列を"styleNameを指定していない"と混同しない)
  assert.throws(() => resolveStyle(SPEAKERS[0], ""), /れいせい.*げんき/s);
});

test("resolveStyle: throws when the styleName matches more than one style of the speaker", () => {
  const dupStyles = { name: "重複", uuid: "uuid-dup", styles: [{ id: 5, name: "げんき" }, { id: 6, name: "げんき" }] };
  assert.throws(() => resolveStyle(dupStyles, "げんき"), /複数見つかりました.*5, 6/s);
});

test("resolveStyle: throws when the speaker has no styles and a styleName is given", () => {
  assert.throws(() => resolveStyle(SPEAKERS[2], "げんき"), /スタイル「げんき」が見つかりません/);
});

test("resolveStyle: matching is exact (no trimming, no partial or case-insensitive match)", () => {
  assert.throws(() => resolveStyle(SPEAKERS[0], "げん"), /見つかりません/);
  assert.throws(() => resolveStyle(SPEAKERS[0], " げんき"), /見つかりません/);
  assert.throws(() => resolveStyle(SPEAKERS[1], "のーまる"), /見つかりません/);
});

function fakeClient() {
  return { listSpeakers: async () => SPEAKERS };
}

test("resolveNamedSpeaker: speakerName only resolves to that speaker's first style", async () => {
  const result = await resolveNamedSpeaker(fakeClient(), "http://dummy", "uuid-1", "AIあいちゃん", undefined);
  assert.deepEqual(result, { speakerUuid: "uuid-2", styleId: 10 });
});

test("resolveNamedSpeaker: speakerName + styleName resolves both", async () => {
  const result = await resolveNamedSpeaker(fakeClient(), "http://dummy", "uuid-1", "つくよみちゃん", "げんき");
  assert.deepEqual(result, { speakerUuid: "uuid-1", styleId: 1 });
});

test("resolveNamedSpeaker: styleName only resolves against the fallback speaker", async () => {
  const result = await resolveNamedSpeaker(fakeClient(), "http://dummy", "uuid-1", undefined, "げんき");
  assert.deepEqual(result, { speakerUuid: "uuid-1", styleId: 1 });
});

test("resolveNamedSpeaker: throws when the fallback speaker is not in the engine's speaker list", async () => {
  await assert.rejects(
    resolveNamedSpeaker(fakeClient(), "http://dummy", "uuid-does-not-exist", undefined, "げんき"),
    /エンジンの話者一覧に見つかりません/
  );
});

test("resolveNamedSpeaker: an empty speakerName is treated as a real (non-matching) name, not as omitted", async () => {
  // ""はundefinedではないので、fallbackSpeakerUuidへの暗黙フォールバックではなく
  // 通常の「見つかりません」エラーになるべき
  await assert.rejects(
    resolveNamedSpeaker(fakeClient(), "http://dummy", "uuid-1", "", undefined),
    /話者「」が見つかりません/
  );
});
