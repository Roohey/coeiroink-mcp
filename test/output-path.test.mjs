import { test } from "node:test";
import assert from "node:assert/strict";
import { validateOutputPath, InvalidOutputPathError } from "../dist/output-path.js";

test("accepts an absolute path and returns it normalized", () => {
  assert.equal(validateOutputPath("C:\\Users\\someone\\out.wav"), "C:\\Users\\someone\\out.wav");
});

test("collapses .. within an already-absolute path (normalization, not a traversal)", () => {
  assert.equal(validateOutputPath("C:\\foo\\bar\\..\\baz.wav"), "C:\\foo\\baz.wav");
});

test("rejects a bare relative path", () => {
  assert.throws(() => validateOutputPath("notes.txt"), InvalidOutputPathError);
  assert.throws(() => validateOutputPath("package.json"), InvalidOutputPathError);
});

test("rejects a relative path attempting to escape cwd with ../", () => {
  assert.throws(() => validateOutputPath("../../escape.wav"), InvalidOutputPathError);
});

test("rejects a UNC path", () => {
  assert.throws(() => validateOutputPath("\\\\127.0.0.1\\share$\\x.wav"), InvalidOutputPathError);
  assert.throws(() => validateOutputPath("//127.0.0.1/share$/x.wav"), InvalidOutputPathError);
});

test("rejects a \\\\?\\ extended-length path", () => {
  assert.throws(() => validateOutputPath("\\\\?\\C:\\Windows\\Temp\\weird.wav"), InvalidOutputPathError);
  assert.throws(() => validateOutputPath("//?/C:/Windows/Temp/weird.wav"), InvalidOutputPathError);
});

test("rejects a Windows root-relative path lacking a drive letter (depends on the current drive at runtime)", () => {
  assert.throws(() => validateOutputPath("\\foo\\bar.wav"), InvalidOutputPathError);
  assert.throws(() => validateOutputPath("/foo/bar.wav"), InvalidOutputPathError);
});
