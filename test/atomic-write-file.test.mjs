import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../scripts/atomic-write-file.mjs";

function listTmpLeftovers(dir, baseName) {
  return fs.readdirSync(dir).filter((name) => name.startsWith(`${baseName}.tmp-`));
}

test("writeFileAtomic: creates the file with the given content on first write, no leftover tmp file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "config.toml");

  writeFileAtomic(target, "hello world");

  assert.equal(fs.readFileSync(target, "utf8"), "hello world");
  assert.deepEqual(listTmpLeftovers(dir, "config.toml"), []);
});

test("writeFileAtomic: creates missing parent directories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "nested", "dir", "config.toml");

  writeFileAtomic(target, "content");

  assert.equal(fs.readFileSync(target, "utf8"), "content");
});

test("writeFileAtomic: a normal overwrite replaces the previous content and leaves no leftover tmp file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "config.toml");

  writeFileAtomic(target, "first version");
  writeFileAtomic(target, "second version");

  assert.equal(fs.readFileSync(target, "utf8"), "second version");
  assert.deepEqual(listTmpLeftovers(dir, "config.toml"), []);
});

test("writeFileAtomic: a failure while writing the temp file leaves the existing target byte-for-byte untouched, and no tmp file behind", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "config.toml");
  writeFileAtomic(target, "precious existing content");

  const err = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  t.mock.method(fs, "writeFileSync", () => {
    throw err;
  });

  assert.throws(() => writeFileAtomic(target, "new content that never lands"), (e) => e.code === "ENOSPC");

  t.mock.restoreAll();
  assert.equal(fs.readFileSync(target, "utf8"), "precious existing content");
  assert.deepEqual(listTmpLeftovers(dir, "config.toml"), []);
});

test("writeFileAtomic: a failure during fsync leaves the existing target byte-for-byte untouched, and no tmp file behind", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "config.toml");
  writeFileAtomic(target, "precious existing content");

  const err = Object.assign(new Error("io error"), { code: "EIO" });
  t.mock.method(fs, "fsyncSync", () => {
    throw err;
  });

  assert.throws(() => writeFileAtomic(target, "new content that never lands"), (e) => e.code === "EIO");

  t.mock.restoreAll();
  assert.equal(fs.readFileSync(target, "utf8"), "precious existing content");
  assert.deepEqual(listTmpLeftovers(dir, "config.toml"), []);
});

test("writeFileAtomic: a failure during rename leaves the existing target byte-for-byte untouched (tmp file is best-effort cleaned up)", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "config.toml");
  writeFileAtomic(target, "precious existing content");

  const err = Object.assign(new Error("permission denied"), { code: "EPERM" });
  t.mock.method(fs, "renameSync", () => {
    throw err;
  });

  assert.throws(() => writeFileAtomic(target, "new content that never lands"), (e) => e.code === "EPERM");

  t.mock.restoreAll();
  assert.equal(fs.readFileSync(target, "utf8"), "precious existing content");
  assert.deepEqual(listTmpLeftovers(dir, "config.toml"), []);
});
