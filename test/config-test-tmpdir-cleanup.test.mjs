import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// config.test.mjs creates its module-scope mkdtempSync tmpRoot as a side effect of merely being
// loaded (it must exist before the dynamic import of dist/config.js). To verify it cleans up after
// itself without polluting this process's own real OS temp directory, run it as an isolated child
// process whose temp directory env vars point at a throwaway directory we fully control and can
// inspect afterwards.
const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const configTestFile = path.join(projectRoot, "test", "config.test.mjs");

test("config.test.mjs removes its module-scope mkdtempSync tmpRoot after the file's tests finish (旧N8)", (t) => {
  const isolatedTemp = fs.mkdtempSync(path.join(os.tmpdir(), "coeiroink-mcp-tmp-leak-check-"));
  t.after(() => fs.rmSync(isolatedTemp, { recursive: true, force: true }));

  // This test file is itself run under `node --test`, which sets NODE_TEST_CONTEXT/
  // NODE_TEST_WORKER_ID for the current worker. Naively inheriting process.env into the spawned
  // child makes the child's own `node --test` believe it is a nested test worker invocation and
  // skip running the file entirely (a silent "recursively within a test file" no-op, not a real
  // run) — so those two vars must be stripped for the child to actually execute config.test.mjs.
  // os.tmpdir() checks TMPDIR before TMP/TEMP on POSIX (Windows ignores TMPDIR entirely and only
  // looks at TEMP/TMP). All three must be overridden, or an inherited TMPDIR (routinely pre-set by
  // the OS on macOS, and sometimes on Linux) would make the child ignore our TEMP/TMP override and
  // write its real tmpRoot outside isolatedTemp — leaving the leftover check below unable to ever
  // find anything, a false pass regardless of whether the underlying leak is actually fixed.
  const childEnv = { ...process.env, TMPDIR: isolatedTemp, TEMP: isolatedTemp, TMP: isolatedTemp };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;

  const result = spawnSync(process.execPath, ["--test", configTestFile], {
    cwd: projectRoot,
    env: childEnv,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, `config.test.mjs itself must still pass; stderr:\n${result.stderr}`);
  const leftovers = fs.readdirSync(isolatedTemp).filter((name) => name.startsWith("coeiroink-mcp-test-"));
  assert.deepEqual(
    leftovers,
    [],
    "the mkdtempSync tmpRoot created when config.test.mjs is loaded must not remain in the OS temp directory afterwards"
  );
});
