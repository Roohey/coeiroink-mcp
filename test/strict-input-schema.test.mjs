// 全ツールのinputSchemaが未知キー(typo引数)を黙って無視せず拒否することを確認する(旧N4)。
// 以前はraw shapeがSDK内部で非strictなz.object()へ変換されていたため、例えば
// speedScaleのtypoである"speed"のような余分な引数が黙って無視され、意図しない既定値のまま
// 「成功」してしまっていた。この検証はスキーマ層(validateToolInput)でハンドラ実行前に
// 行われるため、実TTSエンジンやfakeEngineの応答内容には依存しない。
//
// 各ケースは「未知キー以外は正当な(旧コードなら成功したはずの)呼び出し」にすること。
// 例えばdelete_profile/use_profileは対象プロファイルが実在しないだけでも旧コードで
// isError:trueになってしまい、未知キー拒否の検証として意味をなさない(実装時に実際に
// 遭遇した誤検証)。そのため事前にsave_profileで対象プロファイルを作成してから呼ぶ。
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeEngine, startMcpServer } from "./mcp-client-helper.mjs";

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  return { isError: result.isError === true, text };
}

const UNKNOWN_KEY_CASES = [
  { name: "check_status", args: { foo: "bar" } },
  { name: "list_speakers", args: { foo: "bar" } },
  { name: "speak", args: { text: "こんにちは", speed: 1.5 } },
  { name: "synthesize", args: { text: "こんにちは", speed: 1.5 } },
  { name: "synthesize_script", args: { script: "テスト話者A,こんにちは", speed: 1.5 } },
  { name: "get_current_settings", args: { foo: "bar" } },
  { name: "set_default_speaker", args: { styleId: 5, speed: 1.5 } },
  { name: "list_profiles", args: { foo: "bar" } },
  { name: "save_profile", args: { name: "work", styleId: 5, speed: 1.5 } },
  { name: "stop_speaking", args: { foo: "bar" } },
  { name: "get_speak_status", args: { foo: "bar" } },
];

for (const { name, args } of UNKNOWN_KEY_CASES) {
  test(`${name}: rejects an unrecognized key (typo argument) instead of silently ignoring it`, async (t) => {
    const engine = await startFakeEngine();
    const mcp = await startMcpServer(engine.baseUrl);
    t.after(async () => {
      await mcp.close();
      await engine.close();
    });

    const res = await callTool(mcp.client, name, args);

    assert.equal(res.isError, true, `expected an error for unknown key, got: ${res.text}`);
  });
}

// delete_profile/use_profileはnameだけの単純なスキーマのため、対象プロファイルが実在しないと
// (未知キーの有無に関わらず)旧コードでもisError:trueになってしまい、上のテーブル方式では
// 未知キー拒否を正しく検証できない。対象プロファイルを事前に作成してから検証する。
test("delete_profile: rejects an unrecognized key even when the target profile legitimately exists", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const saved = await callTool(mcp.client, "save_profile", { name: "temp-delete-target", styleId: 5 });
  assert.equal(saved.isError, false, saved.text);

  const res = await callTool(mcp.client, "delete_profile", { name: "temp-delete-target", foo: "bar" });
  assert.equal(res.isError, true, `expected an error for unknown key, got: ${res.text}`);
});

test("use_profile: rejects an unrecognized key even when the target profile legitimately exists", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const saved = await callTool(mcp.client, "save_profile", { name: "temp-use-target", styleId: 5 });
  assert.equal(saved.isError, false, saved.text);

  const res = await callTool(mcp.client, "use_profile", { name: "temp-use-target", foo: "bar" });
  assert.equal(res.isError, true, `expected an error for unknown key, got: ${res.text}`);
});

test("speak: a normal call with only known keys still succeeds (no false positives from .strict())", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const res = await callTool(mcp.client, "speak", { text: "こんにちは", wait: true });

  assert.equal(res.isError, false, res.text);
});

test("save_profile: a normal call with only known keys still succeeds (no false positives from .strict())", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const res = await callTool(mcp.client, "save_profile", { name: "work", styleId: 5 });

  assert.equal(res.isError, false, res.text);
});

test("stop_speaking: a call with speakId (known key) is accepted by the schema, not rejected as unknown (no false positives from .strict()) (タスク6)", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const res = await callTool(mcp.client, "stop_speaking", { speakId: "some-id" });

  assert.equal(res.isError, false, res.text);
  assert.deepEqual(JSON.parse(res.text), { stopped: false, scope: "call", found: false });
});

test("get_speak_status: a call with speakId (known key) is accepted by the schema, not rejected as unknown (no false positives from .strict()) (タスク7)", async (t) => {
  const engine = await startFakeEngine();
  const mcp = await startMcpServer(engine.baseUrl);
  t.after(async () => {
    await mcp.close();
    await engine.close();
  });

  const res = await callTool(mcp.client, "get_speak_status", { speakId: "some-id" });

  assert.equal(res.isError, false, res.text);
  assert.deepEqual(JSON.parse(res.text), { found: false });
});
