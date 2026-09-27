import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// config.tsはモジュール読み込み時にCOEIROINK_MCP_CONFIG_DIR/COEIROINK_MCP_REPO_CONFIG_PATHを
// 読むため、staticインポートより前(=importの巻き上げより前)に環境変数を設定する必要がある。
// そのため動的import()を使い、実行順序を保証する。
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-test-"));
const userConfigDir = path.join(tmpRoot, "user");
const repoConfigPath = path.join(tmpRoot, "repo-config.json");
process.env.COEIROINK_MCP_CONFIG_DIR = userConfigDir;
process.env.COEIROINK_MCP_REPO_CONFIG_PATH = repoConfigPath;

const m = await import("../dist/config.js");
const userConfigPath = path.join(userConfigDir, "config.json");

function writeRepoConfig(obj) {
  fs.writeFileSync(repoConfigPath, JSON.stringify(obj));
}
function writeUserConfig(obj) {
  fs.mkdirSync(userConfigDir, { recursive: true });
  fs.writeFileSync(userConfigPath, JSON.stringify(obj));
}
function clearFiles() {
  fs.rmSync(repoConfigPath, { force: true });
  fs.rmSync(userConfigDir, { recursive: true, force: true });
}

beforeEach(() => {
  clearFiles();
  m.resetStateForTesting();
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("falls back to hardcoded defaults when no config files exist", () => {
  const cfg = m.loadConfig();
  assert.equal(cfg.engine, "coeiroink");
  assert.equal(cfg.coeiroinkUrl, "http://127.0.0.1:50032");
  assert.equal(cfg.voicevoxUrl, "http://127.0.0.1:50021");
});

test("repoFile overrides hardcoded defaults", () => {
  writeRepoConfig({ speedScale: 2.0 });
  assert.equal(m.loadConfig().speedScale, 2.0);
});

test("userFile overrides repoFile", () => {
  writeRepoConfig({ speedScale: 2.0 });
  writeUserConfig({ speedScale: 3.0 });
  assert.equal(m.loadConfig().speedScale, 3.0);
});

test("session override (persist:false) beats userFile but is not written to disk", () => {
  writeUserConfig({ styleId: 5 });
  const updated = m.setDefaultSpeaker({ styleId: 99 }, false);
  assert.equal(updated.styleId, 99);
  assert.equal(JSON.parse(fs.readFileSync(userConfigPath, "utf8")).styleId, 5, "file must be untouched");
});

test("setDefaultSpeaker persist:true writes to the user file and clears any conflicting session override", () => {
  m.setDefaultSpeaker({ styleId: 111 }, false); // セッション上書き
  m.setDefaultSpeaker({ styleId: 222 }, true); // 永続化。セッション側の同項目は解除されるはず
  const values = m.loadConfig();
  assert.equal(values.styleId, 222);
  assert.equal(JSON.parse(fs.readFileSync(userConfigPath, "utf8")).styleId, 222);
});

test("describeCurrentSettings: values and sources are always derived from the same snapshot", () => {
  writeRepoConfig({ volumeScale: 0.5 });
  m.loadConfig(); // キャッシュを温める
  // 別プロセスがファイルを書き換えたことを想定(このプロセスのキャッシュはまだ古いまま)
  writeRepoConfig({ volumeScale: 0.9 });
  const { values, sources } = m.describeCurrentSettings();
  // 古いキャッシュのままでも、valuesとsourcesは矛盾しない(両方とも同じスナップショット由来)
  assert.equal(values.volumeScale, 0.5);
  assert.equal(sources.volumeScale, "repoFile");
});

test("profiles: save, list, use, and resolution priority (activeProfile beats session)", () => {
  m.saveProfile("test-a", { styleId: 111, speedScale: 1.5 });
  assert.deepEqual(m.listProfiles()["test-a"], { styleId: 111, speedScale: 1.5 });

  m.setDefaultSpeaker({ styleId: 222 }, false);
  m.useProfile("test-a");
  assert.equal(m.resolveEffectiveSettings().styleId, 111, "active profile should win over session default");

  m.useProfile(null);
  assert.equal(m.resolveEffectiveSettings().styleId, 222, "falls back to session default once profile deactivated");
});

test("resolveEffectiveSettings priority: callOverrides > profile arg > activeProfile > session/file", () => {
  m.saveProfile("active", { styleId: 1 });
  m.saveProfile("call-arg", { styleId: 2 });
  m.useProfile("active");
  m.setDefaultSpeaker({ styleId: 3 }, false);

  assert.equal(m.resolveEffectiveSettings({}, "call-arg").styleId, 2, "profile arg beats active profile");
  assert.equal(m.resolveEffectiveSettings({ styleId: 4 }, "call-arg").styleId, 4, "explicit override wins over everything");
});

test("profile resolution rejects Object.prototype-inherited names (toString/constructor)", () => {
  for (const fake of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
    assert.throws(() => m.useProfile(fake), /見つかりません/);
    assert.throws(() => m.resolveEffectiveSettings({}, fake), /見つかりません/);
    assert.equal(m.deleteProfile(fake), false);
  }
});

test("saved profile named like a prototype property still works when actually saved", () => {
  m.saveProfile("constructor", { styleId: 77 });
  m.useProfile("constructor"); // 例外を投げないはず
  assert.equal(m.resolveEffectiveSettings().styleId, 77);
  assert.equal(m.deleteProfile("constructor"), true);
});

test("a profile literally named __proto__ survives save/list/use instead of silently vanishing into the object's own prototype", () => {
  m.saveProfile("__proto__", { styleId: 88 });
  assert.deepEqual(m.listProfiles()["__proto__"], { styleId: 88 }, "must be a real own entry, not lost via the __proto__ setter");
  m.useProfile("__proto__");
  assert.equal(m.resolveEffectiveSettings().styleId, 88);
  assert.equal(m.deleteProfile("__proto__"), true);
});

test("profiles metadata never leaks into resolved config values", () => {
  m.saveProfile("leak-test", { styleId: 9 });
  const values = m.loadConfig();
  assert.equal(Object.hasOwn(values, "profiles"), false);
  const effective = m.resolveEffectiveSettings();
  assert.equal(Object.hasOwn(effective, "profiles"), false);
});

test("legacy 'url' field migrates to coeiroinkUrl when coeiroinkUrl is absent", () => {
  writeUserConfig({ url: "http://127.0.0.1:12345" });
  const cfg = m.loadConfig();
  assert.equal(cfg.coeiroinkUrl, "http://127.0.0.1:12345");
  assert.equal(cfg.voicevoxUrl, "http://127.0.0.1:50021", "voicevoxUrl must be untouched");
});

test("legacy 'url' migration: describeCurrentSettings reports the correct source, not 'default'", () => {
  writeUserConfig({ url: "http://127.0.0.1:12345" });
  const { values, sources } = m.describeCurrentSettings();
  assert.equal(values.coeiroinkUrl, "http://127.0.0.1:12345");
  assert.equal(sources.coeiroinkUrl, "userFile", "the migrated value came from the user file, not the default");
});

test("legacy 'url' is ignored when coeiroinkUrl is explicitly present", () => {
  writeUserConfig({ url: "http://127.0.0.1:11111", coeiroinkUrl: "http://127.0.0.1:22222" });
  assert.equal(m.loadConfig().coeiroinkUrl, "http://127.0.0.1:22222");
});

test("user-layer legacy url overrides repo-layer new coeiroinkUrl", () => {
  writeRepoConfig({ coeiroinkUrl: "http://127.0.0.1:50032" });
  writeUserConfig({ url: "http://127.0.0.1:33333" });
  assert.equal(m.loadConfig().coeiroinkUrl, "http://127.0.0.1:33333");
});

function writeCorruptUserConfig() {
  fs.mkdirSync(userConfigDir, { recursive: true });
  fs.writeFileSync(userConfigPath, "{ this is not valid json,}");
}

test("corrupt userFile: read paths (loadConfig/listProfiles) fall back to defaults instead of throwing", () => {
  writeCorruptUserConfig();
  const cfg = m.loadConfig();
  assert.equal(cfg.speedScale, 1.2, "should fall back to hardcoded default, not crash");
  assert.deepEqual(m.listProfiles(), {});
});

test("corrupt userFile: saveProfile refuses to overwrite it (throws instead of silently discarding existing data)", () => {
  m.saveProfile("precious", { styleId: 11 });
  writeCorruptUserConfig();
  assert.throws(() => m.saveProfile("new-one", { styleId: 22 }), /解析に失敗/);
  // ファイルは書き換えられていない(壊れたままである)ことを確認: 例外前に書き込みが起きていない
  assert.equal(fs.readFileSync(userConfigPath, "utf8"), "{ this is not valid json,}");
});

test("corrupt userFile: setDefaultSpeaker(persist:true) throws instead of discarding existing profiles", () => {
  m.saveProfile("precious", { styleId: 11 });
  writeCorruptUserConfig();
  assert.throws(() => m.setDefaultSpeaker({ styleId: 99 }, true), /解析に失敗/);
});

test("corrupt userFile: deleteProfile throws instead of silently treating it as having no profiles", () => {
  m.saveProfile("precious", { styleId: 11 });
  writeCorruptUserConfig();
  assert.throws(() => m.deleteProfile("precious"), /解析に失敗/);
});

test("corrupt repoFile: read paths fall back to defaults (repoFile is share-only, never written by this process)", () => {
  fs.writeFileSync(repoConfigPath, "{ not json");
  const cfg = m.loadConfig();
  assert.equal(cfg.speedScale, 1.2);
});

test("invalid engine value (typo) is ignored, falls back to default instead of producing a broken config", () => {
  writeUserConfig({ engine: "voicevoxx" });
  assert.equal(m.loadConfig().engine, "coeiroink");
});

test("wrong-type numeric field (string instead of number) is ignored, falls back to default", () => {
  writeUserConfig({ styleId: "131" });
  assert.equal(m.loadConfig().styleId, 131);
});

test("non-finite numeric field (NaN/Infinity via JSON round-trip edge cases) is ignored", () => {
  // JSON.parseはNaN/Infinityを生成しないが、他の不正値(nullや配列)でも同様に弾かれることを確認する
  writeUserConfig({ speedScale: null });
  assert.equal(m.loadConfig().speedScale, 1.2);
});

test("wrong-type string field (number instead of string) is ignored, falls back to default", () => {
  writeUserConfig({ coeiroinkUrl: 12345 });
  assert.equal(m.loadConfig().coeiroinkUrl, "http://127.0.0.1:50032");
});

test("malformed coeiroinkUrl (not a URL at all) is ignored, falls back to default, with a stderr warning", (t) => {
  const errorMock = t.mock.method(console, "error", () => {});
  writeUserConfig({ coeiroinkUrl: "definitely not a url" });
  assert.equal(m.loadConfig().coeiroinkUrl, "http://127.0.0.1:50032");
  assert.ok(
    errorMock.mock.calls.some((c) => /"coeiroinkUrl".*URL/.test(String(c.arguments[0]))),
    "must warn that coeiroinkUrl was rejected as an invalid URL, not just silently fall back"
  );
});

test("malformed voicevoxUrl (not a URL at all) is ignored, falls back to default, with a stderr warning", (t) => {
  const errorMock = t.mock.method(console, "error", () => {});
  writeUserConfig({ voicevoxUrl: "definitely not a url" });
  assert.equal(m.loadConfig().voicevoxUrl, "http://127.0.0.1:50021");
  assert.ok(
    errorMock.mock.calls.some((c) => /"voicevoxUrl".*URL/.test(String(c.arguments[0]))),
    "must warn that voicevoxUrl was rejected as an invalid URL, not just silently fall back"
  );
});

test("non-http(s) scheme URL (e.g. ftp:) is ignored, falls back to default, with a stderr warning", (t) => {
  const errorMock = t.mock.method(console, "error", () => {});
  writeUserConfig({ coeiroinkUrl: "ftp://127.0.0.1:50032" });
  assert.equal(m.loadConfig().coeiroinkUrl, "http://127.0.0.1:50032");
  assert.ok(
    errorMock.mock.calls.some((c) => /"coeiroinkUrl".*URL/.test(String(c.arguments[0]))),
    "a non-http(s) scheme must still be reported as an invalid URL, not accepted silently"
  );
});

test("valid coeiroinkUrl with a custom port is accepted without any warning", (t) => {
  const errorMock = t.mock.method(console, "error", () => {});
  writeUserConfig({ coeiroinkUrl: "http://127.0.0.1:59999" });
  assert.equal(m.loadConfig().coeiroinkUrl, "http://127.0.0.1:59999");
  assert.equal(errorMock.mock.calls.length, 0, "a valid URL must not trigger any warning");
});

test("legacy 'url' field with malformed value is not migrated to coeiroinkUrl, with a stderr warning", (t) => {
  const errorMock = t.mock.method(console, "error", () => {});
  writeUserConfig({ url: "definitely not a url" });
  assert.equal(m.loadConfig().coeiroinkUrl, "http://127.0.0.1:50032");
  assert.ok(
    errorMock.mock.calls.some((c) => /"url".*URL/.test(String(c.arguments[0]))),
    "must warn that the legacy url field was rejected as an invalid URL, not silently dropped"
  );
});

test("valid fields alongside an invalid one: only the invalid field falls back, the rest still apply", () => {
  writeUserConfig({ engine: "not-a-real-engine", speedScale: 1.8, styleId: 42 });
  const cfg = m.loadConfig();
  assert.equal(cfg.engine, "coeiroink", "invalid engine falls back to default");
  assert.equal(cfg.speedScale, 1.8, "valid sibling field is unaffected");
  assert.equal(cfg.styleId, 42, "valid sibling field is unaffected");
});

test("repoFile-layer valid value is not masked by a userFile-layer invalid value for the same key", () => {
  writeRepoConfig({ styleId: 7 });
  writeUserConfig({ styleId: "not-a-number" });
  // userFile側は不正なので無視され、repoFile側の値まで正しくフォールバックすることを確認する
  assert.equal(m.loadConfig().styleId, 7);
});

test("unreadable userFile (EBUSY, not ENOENT): write paths throw instead of treating it as absent", (t) => {
  m.saveProfile("precious", { styleId: 11 });
  const before = fs.readFileSync(userConfigPath, "utf8");

  const err = Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
  t.mock.method(fs, "readFileSync", () => {
    throw err;
  });

  assert.throws(() => m.saveProfile("new-one", { styleId: 22 }), /読み取りに失敗/);
  assert.throws(() => m.setDefaultSpeaker({ styleId: 99 }, true), /読み取りに失敗/);
  assert.throws(() => m.deleteProfile("precious"), /読み取りに失敗/);

  t.mock.restoreAll();
  assert.equal(fs.readFileSync(userConfigPath, "utf8"), before, "file must be byte-for-byte unchanged after all the throws above");
});

test("unreadable userFile (EACCES, not ENOENT): read-only path (loadConfig) still falls back to defaults instead of throwing", (t) => {
  m.saveProfile("precious", { styleId: 11 });

  const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
  t.mock.method(fs, "readFileSync", () => {
    throw err;
  });

  assert.doesNotThrow(() => m.loadConfig());
  assert.equal(m.loadConfig().speedScale, 1.2, "falls back to hardcoded default rather than crashing");
});

test("missing userFile (ENOENT) is still treated as absent, not as a read error", () => {
  // clearFiles() in beforeEach already removed the file; this documents the ENOENT path stays intact.
  assert.doesNotThrow(() => m.saveProfile("first", { styleId: 1 }));
  assert.deepEqual(m.listProfiles(), { first: { styleId: 1 } });
});

// ---- 設定ファイル書き込みの原子性(temp+fsync+rename、タスク8) ----

function listTmpLeftovers() {
  if (!fs.existsSync(userConfigDir)) return [];
  return fs.readdirSync(userConfigDir).filter((name) => name.startsWith("config.json.tmp-"));
}

test("successful writes leave no config.json.tmp-* leftover in the user config directory", () => {
  m.saveProfile("a", { styleId: 1 });
  m.setDefaultSpeaker({ styleId: 2 }, true);
  m.deleteProfile("a");
  assert.deepEqual(listTmpLeftovers(), []);
});

test("a failure while writing the temp file (e.g. ENOSPC) leaves the existing user config file byte-for-byte unchanged, and no tmp file behind", (t) => {
  m.saveProfile("precious", { styleId: 11 });
  const before = fs.readFileSync(userConfigPath, "utf8");

  const err = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  t.mock.method(fs, "writeFileSync", () => {
    throw err;
  });

  assert.throws(() => m.saveProfile("new-one", { styleId: 22 }), (e) => e.code === "ENOSPC");

  t.mock.restoreAll();
  assert.equal(fs.readFileSync(userConfigPath, "utf8"), before, "file must be byte-for-byte unchanged");
  assert.deepEqual(listTmpLeftovers(), [], "the failed temp file must not be left behind");
});

test("[reproduces the pre-fix corruption] a real mid-write flush (some bytes land, then the write throws) never truncates the actual user config file into an unparseable fragment", (t) => {
  m.saveProfile("work", { styleId: 1 });
  m.saveProfile("chill", { styleId: 2 });
  const before = fs.readFileSync(userConfigPath, "utf8");

  const origWriteFileSync = fs.writeFileSync;
  const err = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  // 実際のENOSPC同様、書き込み先(pre-fix実装なら本体パス、fix後ならtmpパスのfd)へ
  // 部分的にバイトが届いてから例外が飛ぶ、という状況を再現する。書き込み先自体は
  // 呼び出し元(実装)が決めるので、ここでは常に「渡された対象へ14バイトだけ書いて例外」
  // という現実的な障害を注入し、その対象がどこだったか(=本体かtmpか)で結果が分かれる。
  t.mock.method(fs, "writeFileSync", (target, data, ...rest) => {
    origWriteFileSync(target, String(data).slice(0, 14), ...rest);
    throw err;
  });

  assert.throws(() => m.saveProfile("new-one", { styleId: 99 }), (e) => e.code === "ENOSPC");

  t.mock.restoreAll();
  const after = fs.readFileSync(userConfigPath, "utf8");
  assert.equal(after, before, "the real user config file must be byte-for-byte unchanged despite the mid-write failure");
  assert.doesNotThrow(() => JSON.parse(after), "must still be valid JSON, not a 14-byte truncated fragment");
});

test("a failure during fsync leaves the existing user config file byte-for-byte unchanged, and no tmp file behind", (t) => {
  m.saveProfile("precious", { styleId: 11 });
  const before = fs.readFileSync(userConfigPath, "utf8");

  const err = Object.assign(new Error("io error"), { code: "EIO" });
  t.mock.method(fs, "fsyncSync", () => {
    throw err;
  });

  assert.throws(() => m.setDefaultSpeaker({ styleId: 99 }, true), (e) => e.code === "EIO");

  t.mock.restoreAll();
  assert.equal(fs.readFileSync(userConfigPath, "utf8"), before, "file must be byte-for-byte unchanged");
  assert.deepEqual(listTmpLeftovers(), [], "the failed temp file must not be left behind");
});

test("a failure during rename leaves the existing user config file byte-for-byte unchanged (tmp file is best-effort cleaned up)", (t) => {
  m.saveProfile("precious", { styleId: 11 });
  const before = fs.readFileSync(userConfigPath, "utf8");

  const err = Object.assign(new Error("permission denied"), { code: "EPERM" });
  t.mock.method(fs, "renameSync", () => {
    throw err;
  });

  assert.throws(() => m.deleteProfile("precious"), (e) => e.code === "EPERM");

  t.mock.restoreAll();
  assert.equal(fs.readFileSync(userConfigPath, "utf8"), before, "file must be byte-for-byte unchanged");
  assert.deepEqual(listTmpLeftovers(), [], "the failed temp file must not be left behind");
});

// ---- profiles / トップレベル設定の検証(旧K4 + N2) ----

test("scalar profiles container: read paths fall back to no profiles instead of crashing", () => {
  writeUserConfig({ profiles: "not-an-object" });
  assert.deepEqual(m.listProfiles(), {});
  assert.equal(m.loadConfig().speedScale, 1.2, "unrelated top-level fields still load normally");
});

test("array profiles container: read paths fall back to no profiles instead of corrupting output", () => {
  writeUserConfig({ profiles: ["a", "b"] });
  assert.deepEqual(m.listProfiles(), {}, "an array must not leak through as {0:'a',1:'b'}");
});

test("null profiles container: read paths fall back to no profiles", () => {
  writeUserConfig({ profiles: null });
  assert.deepEqual(m.listProfiles(), {});
});

test("scalar/array/null profiles container: write paths (saveProfile/deleteProfile) refuse instead of silently discarding the existing container", () => {
  for (const bogus of ["not-an-object", ["a", "b"], null]) {
    writeUserConfig({ profiles: bogus });
    assert.throws(() => m.saveProfile("new-one", { styleId: 1 }), /"profiles"/);
    assert.throws(() => m.deleteProfile("anything"), /"profiles"/);
    // 拒否した以上、ファイルは一切書き換えられていないはず
    assert.deepEqual(JSON.parse(fs.readFileSync(userConfigPath, "utf8")), { profiles: bogus });
  }
});

test("scalar individual profile entry: ignored with a warning, does not crash list_profiles/save_profile", () => {
  writeUserConfig({ profiles: { bogus: "not-an-object", ok: { styleId: 5 } } });
  assert.deepEqual(m.listProfiles(), { ok: { styleId: 5 } }, "the scalar entry must be dropped, the valid sibling kept");
  // save_profileは他の妥当なプロファイルには影響を与えず、壊れたエントリは以後の書き込みで自然に消える
  assert.doesNotThrow(() => m.saveProfile("another", { styleId: 6 }));
  const after = JSON.parse(fs.readFileSync(userConfigPath, "utf8"));
  assert.equal(Object.hasOwn(after.profiles, "bogus"), false);
  assert.deepEqual(after.profiles.ok, { styleId: 5 });
  assert.deepEqual(after.profiles.another, { styleId: 6 });
});

test("null individual profile entry: dropped so use_profile reports not-found instead of activating a broken profile", () => {
  writeUserConfig({ profiles: { broken: null } });
  assert.deepEqual(m.listProfiles(), {});
  assert.throws(() => m.useProfile("broken"), /見つかりません/);
});

test("profile with an invalid engine value: only that field is dropped, sibling fields survive", () => {
  writeUserConfig({ profiles: { p: { engine: "not-a-real-engine", styleId: 5 } } });
  assert.deepEqual(m.listProfiles().p, { styleId: 5 });
});

test("profile with a wrong-type numeric field (string instead of number): only that field is dropped", () => {
  writeUserConfig({ profiles: { p: { speedScale: "not-a-number", styleId: 5 } } });
  assert.deepEqual(m.listProfiles().p, { styleId: 5 });
});

test("profile with an unknown key: the unknown key is ignored, known fields still apply", () => {
  writeUserConfig({ profiles: { p: { styleId: 5, unexpectedKey: "leaks" } } });
  assert.deepEqual(m.listProfiles().p, { styleId: 5 });
});

test("profile with valid and invalid fields mixed: only the invalid field falls back, the rest apply", () => {
  writeUserConfig({ profiles: { p: { styleId: 5, speedScale: "bad", volumeScale: 0.7 } } });
  assert.deepEqual(m.listProfiles().p, { styleId: 5, volumeScale: 0.7 });
});

test("a null field inside a profile never reaches resolveEffectiveSettings once it is made active", () => {
  writeUserConfig({ profiles: { p: { styleId: 5, speedScale: null } } });
  m.useProfile("p");
  const effective = m.resolveEffectiveSettings();
  assert.equal(effective.styleId, 5);
  assert.equal(effective.speedScale, 1.2, "the null field must be dropped, not passed through to the engine as null");
});

test("top-level userFile that is a bare JSON string: write paths refuse instead of exploding it into indexed keys", () => {
  fs.mkdirSync(userConfigDir, { recursive: true });
  fs.writeFileSync(userConfigPath, JSON.stringify("hello"));
  assert.throws(() => m.setDefaultSpeaker({ styleId: 1 }, true), /オブジェクトではありません/);
  assert.throws(() => m.saveProfile("x", { styleId: 1 }), /オブジェクトではありません/);
  assert.throws(() => m.deleteProfile("x"), /オブジェクトではありません/);
  assert.equal(fs.readFileSync(userConfigPath, "utf8"), JSON.stringify("hello"), "file must be untouched");
});

test("top-level userFile that is a bare JSON string: read paths fall back to defaults instead of crashing", () => {
  fs.mkdirSync(userConfigDir, { recursive: true });
  fs.writeFileSync(userConfigPath, JSON.stringify("hello"));
  assert.doesNotThrow(() => m.loadConfig());
  assert.equal(m.loadConfig().speedScale, 1.2);
  assert.deepEqual(m.listProfiles(), {});
});
