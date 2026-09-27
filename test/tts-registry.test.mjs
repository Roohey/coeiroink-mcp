import { test } from "node:test";
import assert from "node:assert/strict";
import { getEngineClient } from "../dist/tts-registry.js";

test("getEngineClient: throws a named error for an unknown engine instead of returning undefined", () => {
  assert.throws(() => getEngineClient("bogus"), /bogus/);
});

test("getEngineClient: still resolves known engines normally", () => {
  assert.equal(typeof getEngineClient("coeiroink").synthesize, "function");
  assert.equal(typeof getEngineClient("voicevox").synthesize, "function");
});
