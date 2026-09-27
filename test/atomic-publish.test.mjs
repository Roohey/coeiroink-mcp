import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { ConcurrentPublishError, publishStagingDirectory } from "../dist/atomic-publish.js";

const raceWorkerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "atomic-publish-race-worker.mjs");

// EXDEV (cross-volume rename) can't be triggered on demand without a real second volume/mount,
// so we fault-inject it: force the very first rename attempt (stagingDir -> finalDir) to fail with
// EXDEV, while letting every other fs.promises call run for real. Since atomic-publish.ts does
// `import { promises as fs } from "node:fs"` and calls `fs.rename(...)` via property access, mocking
// the `rename` property on this same shared promises object (fsp here) is visible to it.
function forceExdevOnce(t, stagingDir) {
  const originalRename = fsp.rename.bind(fsp);
  t.mock.method(fsp, "rename", async (src, dest) => {
    if (src === stagingDir) {
      throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
    }
    return originalRename(src, dest);
  });
}

function makeStagingDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-staging-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test("publishStagingDirectory: publishes into a fresh (non-existent) target via a single rename", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staging = makeStagingDir({ "a.wav": "aaa", "manifest.json": "{}" });
  const finalDir = path.join(root, "brand-new");

  await publishStagingDirectory(staging, finalDir);

  assert.deepEqual(fs.readdirSync(finalDir).sort(), ["a.wav", "manifest.json"]);
  assert.equal(fs.readFileSync(path.join(finalDir, "a.wav"), "utf8"), "aaa");
  assert.equal(fs.existsSync(staging), false, "the staging directory itself should no longer exist (it became finalDir)");
});

test("publishStagingDirectory: publishes into an existing EMPTY target (rmdir+retry path)", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staging = makeStagingDir({ "b.wav": "bbb" });
  const finalDir = path.join(root, "existing-empty");
  fs.mkdirSync(finalDir);

  await publishStagingDirectory(staging, finalDir);

  assert.deepEqual(fs.readdirSync(finalDir), ["b.wav"]);
  assert.equal(fs.existsSync(staging), false);
});

test("publishStagingDirectory: refuses to touch an existing NON-EMPTY target — no files are deleted or overwritten, staging is left intact", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staging = makeStagingDir({ "c.wav": "ccc" });
  const finalDir = path.join(root, "existing-non-empty");
  fs.mkdirSync(finalDir);
  fs.writeFileSync(path.join(finalDir, "someone-elses-file.txt"), "do not touch me");

  await assert.rejects(
    publishStagingDirectory(staging, finalDir),
    (e) => e instanceof ConcurrentPublishError && e.cause?.code === "ENOTEMPTY" && e.message.includes(staging),
    "a non-empty finalDir is indistinguishable from a peer's already-published result, so it must be reported as ConcurrentPublishError (with the staging path in the message), not a generic rejection"
  );

  assert.deepEqual(fs.readdirSync(finalDir), ["someone-elses-file.txt"], "the pre-existing content must be untouched");
  assert.equal(
    fs.readFileSync(path.join(finalDir, "someone-elses-file.txt"), "utf8"),
    "do not touch me",
    "must not have been overwritten"
  );
  assert.deepEqual(fs.readdirSync(staging), ["c.wav"], "staging directory must still hold its original content for the caller to clean up or retry");
});

test("publishStagingDirectory: creates the parent chain implicitly via rename (nested path whose immediate parent already exists)", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staging = makeStagingDir({ "d.wav": "ddd" });
  const finalDir = path.join(root, "nested-target");

  await publishStagingDirectory(staging, finalDir);

  assert.deepEqual(fs.readdirSync(finalDir), ["d.wav"]);
});

test("publishStagingDirectory: refuses to replace an existing REGULAR FILE at finalDir — file survives byte-for-byte, staging is left intact", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staging = makeStagingDir({ "e.wav": "eee" });
  const finalDir = path.join(root, "existing-regular-file");
  fs.writeFileSync(finalDir, "sentinel-user-data");

  await assert.rejects(publishStagingDirectory(staging, finalDir));

  assert.equal(fs.lstatSync(finalDir).isDirectory(), false, "must still be a regular file, not replaced by a directory");
  assert.equal(fs.readFileSync(finalDir, "utf8"), "sentinel-user-data", "file content must be untouched");
  assert.deepEqual(fs.readdirSync(staging), ["e.wav"], "staging directory must still hold its original content");
});

test("publishStagingDirectory: refuses to replace an existing SYMLINK at finalDir — link and its target survive untouched", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const linkTarget = path.join(root, "link-target.txt");
  fs.writeFileSync(linkTarget, "sentinel-link-target");
  const finalDir = path.join(root, "existing-symlink");
  try {
    fs.symlinkSync(linkTarget, finalDir, "file");
  } catch (e) {
    t.skip(`symlink creation unsupported in this environment: ${e.code ?? e.message}`);
    return;
  }

  const staging = makeStagingDir({ "f.wav": "fff" });

  await assert.rejects(publishStagingDirectory(staging, finalDir));

  assert.equal(fs.lstatSync(finalDir).isSymbolicLink(), true, "must still be a symlink, not replaced by a directory");
  assert.equal(fs.readFileSync(linkTarget, "utf8"), "sentinel-link-target", "link target content must be untouched");
  assert.deepEqual(fs.readdirSync(staging), ["f.wav"], "staging directory must still hold its original content");
});

test("publishStagingDirectory: EXDEV (cross-volume) fallback — finalDir does not exist, publishes via same-volume sibling copy+rename", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staging = makeStagingDir({ "g.wav": "ggg" });
  const finalDir = path.join(root, "exdev-brand-new");
  forceExdevOnce(t, staging);

  await publishStagingDirectory(staging, finalDir);

  assert.deepEqual(fs.readdirSync(finalDir), ["g.wav"]);
  assert.equal(fs.readFileSync(path.join(finalDir, "g.wav"), "utf8"), "ggg");
  assert.equal(fs.existsSync(staging), false, "staging directory should be fully consumed");
  const leftovers = fs.readdirSync(root).filter((name) => name !== "exdev-brand-new");
  assert.deepEqual(leftovers, [], "no sibling temp directory should remain after a successful publish");
});

test("publishStagingDirectory: EXDEV fallback — finalDir exists and is EMPTY, publishes via sibling copy + rmdir/retry", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staging = makeStagingDir({ "h.wav": "hhh" });
  const finalDir = path.join(root, "exdev-existing-empty");
  fs.mkdirSync(finalDir);
  forceExdevOnce(t, staging);

  await publishStagingDirectory(staging, finalDir);

  assert.deepEqual(fs.readdirSync(finalDir), ["h.wav"]);
  assert.equal(fs.existsSync(staging), false, "staging directory should be fully consumed");
  const leftovers = fs.readdirSync(root).filter((name) => name !== "exdev-existing-empty");
  assert.deepEqual(leftovers, [], "no sibling temp directory should remain after a successful publish");
});

test("publishStagingDirectory: EXDEV fallback — finalDir exists and is NON-EMPTY, refuses without touching anything", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staging = makeStagingDir({ "i.wav": "iii" });
  const finalDir = path.join(root, "exdev-existing-non-empty");
  fs.mkdirSync(finalDir);
  fs.writeFileSync(path.join(finalDir, "someone-elses-file.txt"), "do not touch me");
  forceExdevOnce(t, staging);

  await assert.rejects(
    publishStagingDirectory(staging, finalDir),
    (e) => e instanceof ConcurrentPublishError && e.cause?.code === "ENOTEMPTY",
    "must fail because finalDir is non-empty (ENOTEMPTY, surfaced as ConcurrentPublishError), not because of the forced EXDEV itself leaking through unhandled"
  );

  assert.deepEqual(fs.readdirSync(finalDir), ["someone-elses-file.txt"], "pre-existing content must be untouched");
  assert.equal(
    fs.readFileSync(path.join(finalDir, "someone-elses-file.txt"), "utf8"),
    "do not touch me",
    "must not have been overwritten"
  );
  assert.deepEqual(fs.readdirSync(staging), ["i.wav"], "staging directory must still hold its original content");
  const leftovers = fs.readdirSync(root).filter((name) => name !== "exdev-existing-non-empty");
  assert.deepEqual(leftovers, [], "the temporary sibling copy must be cleaned up even on failure");
});

test("publishStagingDirectory: EXDEV fallback — copy to the same-volume sibling fails (e.g. ENOSPC), finalDir (pre-existing, empty) is restored and staging is left untouched", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staging = makeStagingDir({ "j.wav": "jjj" });
  const finalDir = path.join(root, "exdev-copy-failure");
  fs.mkdirSync(finalDir);
  forceExdevOnce(t, staging);
  t.mock.method(fsp, "cp", async () => {
    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  });

  await assert.rejects(
    publishStagingDirectory(staging, finalDir),
    (e) => e.code === "ENOSPC",
    "must fail with the copy's own error (ENOSPC), not because of the forced EXDEV itself leaking through unhandled"
  );

  // renameOnto always does rmdir(finalDir) before attempting rename (task 8, window (a) fix), so
  // by the time the EXDEV-triggered sibling-copy fallback's own `fs.cp` step fails (as forced
  // here), our rmdir has already removed the pre-existing empty finalDir. Task 9 restores it: since
  // reserveFinalDirAsDirectory reports it did NOT create finalDir (it pre-existed), the failure
  // path recreates it via a plain fs.mkdir so the caller observes the same "finalDir exists and is
  // empty" state as before the call, exactly as if nothing had been attempted.
  assert.equal(fs.existsSync(finalDir), true, "finalDir must be restored on failure (task 9)");
  assert.deepEqual(fs.readdirSync(finalDir), [], "restored finalDir must be empty, matching its pre-call state");
  assert.deepEqual(fs.readdirSync(staging), ["j.wav"], "staging directory must still hold its original content");
  const leftovers = fs.readdirSync(root).filter((name) => name !== "exdev-copy-failure");
  assert.deepEqual(leftovers, [], "no partial sibling copy should remain after a failed cp");
});

test("publishStagingDirectory: EXDEV fallback — copy to the same-volume sibling fails (e.g. ENOSPC), finalDir did NOT exist before the call (we created it ourselves) — it is left absent, matching its pre-call state, not recreated as a leftover empty directory", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staging = makeStagingDir({ "j2.wav": "jjj2" });
  const finalDir = path.join(root, "exdev-copy-failure-brand-new");
  // finalDir intentionally NOT pre-created here: reserveFinalDirAsDirectory will mkdir it itself
  // (created:true), so the correct rollback on failure is "leave it absent", not "recreate empty".
  forceExdevOnce(t, staging);
  t.mock.method(fsp, "cp", async () => {
    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  });

  await assert.rejects(
    publishStagingDirectory(staging, finalDir),
    (e) => e.code === "ENOSPC",
    "must fail with the copy's own error (ENOSPC), not because of the forced EXDEV itself leaking through unhandled"
  );

  assert.equal(fs.existsSync(finalDir), false, "finalDir must be left absent — it never existed before this call, so there is nothing to restore");
  assert.deepEqual(fs.readdirSync(staging), ["j2.wav"], "staging directory must still hold its original content");
  const leftovers = fs.readdirSync(root).filter((name) => name !== "exdev-copy-failure-brand-new");
  assert.deepEqual(leftovers, [], "no partial sibling copy or leftover empty finalDir should remain after a failed cp");
});

test("publishStagingDirectory: rollback restoration also covers the ENOENT-rescue path — our own rmdir(finalDir) itself observes ENOENT (as if a peer already removed the pre-existing empty finalDir), the rescue rename hits EXDEV, and the sibling-copy fallback then fails too — finalDir (pre-existing, empty) must still be restored, not left missing", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staging = makeStagingDir({ "j3.wav": "jjj3" });
  const finalDir = path.join(root, "exdev-copy-failure-enoent-rescue");
  fs.mkdirSync(finalDir); // pre-existing, empty

  // Simulate the losing side of a race for who gets to remove the pre-existing finalDir: our own
  // rmdir(finalDir) call physically removes it (so lstat afterwards genuinely finds nothing) but
  // reports ENOENT to us, exactly as the "zero-winner rescue" test above does. This routes us
  // through renameOnto's ENOENT branch, where we retry via a direct rescue rename rather than via
  // the primary "rmdir succeeded" branch that normally sets finalDirRemoved.
  const originalRmdir = fsp.rmdir.bind(fsp);
  t.mock.method(fsp, "rmdir", async (p) => {
    if (p === finalDir) {
      await originalRmdir(p);
      throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    }
    return originalRmdir(p);
  });
  // The rescue rename (fs.rename(stagingDir, finalDir), same src as the primary path) then hits
  // EXDEV, forcing the sibling-copy fallback, whose own fs.cp then fails with ENOSPC.
  forceExdevOnce(t, staging);
  t.mock.method(fsp, "cp", async () => {
    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  });

  await assert.rejects(
    publishStagingDirectory(staging, finalDir),
    (e) => e.code === "ENOSPC",
    "must fail with the copy's own error (ENOSPC), not because of the forced EXDEV or ENOENT leaking through unhandled"
  );

  assert.equal(fs.existsSync(finalDir), true, "finalDir must be restored on failure even when it went missing via the ENOENT-rescue path, not just the primary rmdir-succeeded path");
  assert.deepEqual(fs.readdirSync(finalDir), [], "restored finalDir must be empty, matching its pre-call state");
  assert.deepEqual(fs.readdirSync(staging), ["j3.wav"], "staging directory must still hold its original content");
  const leftovers = fs.readdirSync(root).filter((name) => name !== "exdev-copy-failure-enoent-rescue");
  assert.deepEqual(leftovers, [], "no partial sibling copy should remain after a failed cp");
});

test("publishStagingDirectory: reserveFinalDirAsDirectory retries past a spurious EPERM from a concurrent mkdir race (observed under heavy N-way contention: Windows can return EPERM instead of EEXIST when another call is mkdir/rmdir-ing the same name concurrently), instead of leaking a raw EPERM (which would make the caller discard staging)", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staging = makeStagingDir({ "q.wav": "qqq" });
  const finalDir = path.join(root, "mkdir-eperm-race");

  // Force our very first mkdir(finalDir) to report EPERM instead of the expected EEXIST/success.
  // This was discovered as a genuine flake (not a hypothetical): closing window (a) makes
  // renameOnto call rmdir(finalDir) unconditionally and immediately (rather than only after a
  // failed speculative rename), which raises contention between concurrent mkdir (reservation) and
  // rmdir (publish) calls on the same finalDir name enough that Node.js/Windows occasionally
  // surfaces EPERM from fs.mkdir instead of EEXIST for a losing racer (reproduced directly against
  // the N-way concurrent test in this file without this fix).
  const originalMkdir = fsp.mkdir.bind(fsp);
  let mkdirCalls = 0;
  t.mock.method(fsp, "mkdir", async (p, ...rest) => {
    if (p === finalDir) {
      mkdirCalls++;
      if (mkdirCalls === 1) {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }
    }
    return originalMkdir(p, ...rest);
  });

  await publishStagingDirectory(staging, finalDir);

  assert.deepEqual(fs.readdirSync(finalDir), ["q.wav"], "must have recovered from the transient EPERM and actually published");
  assert.equal(fs.existsSync(staging), false, "staging directory should be fully consumed on success");
});

test("publishStagingDirectory: mkdir-contention at the very entry — our lstat (right after mkdir's EEXIST) races a peer's rmdir and observes ENOENT; must retry the reservation instead of leaking a raw ENOENT (which would make the caller discard staging)", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staging = makeStagingDir({ "n.wav": "nnn" });
  const finalDir = path.join(root, "mkdir-contention-entry");
  fs.mkdirSync(finalDir); // pre-existing directory — our own mkdir() will observe EEXIST

  // Force our very first lstat(finalDir) call (the one reserveFinalDirAsDirectory makes right
  // after seeing mkdir's EEXIST) to report ENOENT, as if a peer's rmdir(finalDir) raced into the
  // gap between our failed mkdir and our lstat and briefly won. finalDir is left physically
  // untouched, so the reservation retry's second mkdir attempt should simply see it again.
  const originalLstat = fsp.lstat.bind(fsp);
  let lstatCalls = 0;
  t.mock.method(fsp, "lstat", async (p) => {
    if (p === finalDir) {
      lstatCalls++;
      if (lstatCalls === 1) {
        throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
      }
    }
    return originalLstat(p);
  });

  await publishStagingDirectory(staging, finalDir);

  assert.deepEqual(fs.readdirSync(finalDir), ["n.wav"], "must have recovered from the transient ENOENT and actually published");
  assert.equal(fs.existsSync(staging), false, "staging directory should be fully consumed on success");
});

test("publishStagingDirectory: zero-winner rescue — our rmdir races another rmdir on the same target and observes ENOENT after it is genuinely gone, retries once and succeeds", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staging = makeStagingDir({ "k.wav": "kkk" });
  const finalDir = path.join(root, "zero-winner-rescue");
  fs.mkdirSync(finalDir); // pre-existing, empty — as if reserved earlier by a peer

  // Two concurrent publishers' rmdir(finalDir) calls race on the same directory: on real NTFS,
  // exactly one succeeds and the other observes ENOENT once the directory is already gone (not
  // ENOTEMPTY, since the directory really is empty and really does disappear). We simulate the
  // "losing" side of that race: physically remove finalDir for real, but report ENOENT to the
  // caller instead of success, so the caller must recover via the ENOENT/lstat rescue path rather
  // than via its own successful rmdir return value.
  const originalRmdir = fsp.rmdir.bind(fsp);
  let rmdirCalls = 0;
  t.mock.method(fsp, "rmdir", async (p) => {
    rmdirCalls++;
    if (p === finalDir && rmdirCalls === 1) {
      await originalRmdir(p);
      throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    }
    return originalRmdir(p);
  });

  await publishStagingDirectory(staging, finalDir);

  assert.deepEqual(fs.readdirSync(finalDir), ["k.wav"], "the rescued retry must have actually published the staged content");
  assert.equal(fs.existsSync(staging), false, "staging directory should be fully consumed on success");
});

test("publishStagingDirectory: a peer recreates finalDir as a directory between our rmdir and our retry rename — ConcurrentPublishError, nothing touched", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staging = makeStagingDir({ "l.wav": "lll" });
  const finalDir = path.join(root, "peer-recreated-as-dir");
  fs.mkdirSync(finalDir);
  fs.writeFileSync(path.join(finalDir, "peer-content.txt"), "published by a peer");

  // Force our own rmdir to report ENOENT even though finalDir still physically exists (and is
  // still a directory) — modeling the case where OUR rmdir call itself raced and lost against a
  // peer that had already emptied+republished finalDir by the time we look again via lstat.
  t.mock.method(fsp, "rmdir", async () => {
    throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
  });

  await assert.rejects(
    publishStagingDirectory(staging, finalDir),
    (e) => e instanceof ConcurrentPublishError && e.message.includes(staging),
    "must be reported as ConcurrentPublishError since finalDir turned out to already be an occupied directory again"
  );

  assert.deepEqual(fs.readdirSync(finalDir), ["peer-content.txt"], "the peer's published content must be untouched");
  assert.equal(fs.readFileSync(path.join(finalDir, "peer-content.txt"), "utf8"), "published by a peer");
  assert.deepEqual(fs.readdirSync(staging), ["l.wav"], "our own staging directory must still hold its original content");
});

test("publishStagingDirectory: rmdir observes ENOENT because finalDir was actually replaced by a regular file — non-directory guard rejects, file survives byte-for-byte (no rename is attempted)", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staging = makeStagingDir({ "m.wav": "mmm" });
  const finalDir = path.join(root, "enoent-but-actually-a-file");
  fs.mkdirSync(finalDir);

  // Windows' fs.rmdir reports ENOENT (not ENOTDIR) both when the target is genuinely gone AND
  // when the target exists but is not a directory. Simulate the latter: swap the directory for a
  // regular file, and have rmdir report ENOENT for it — this must NOT be treated as "the name is
  // free, retry rename", because rename would then destroy the file that raced it into place.
  t.mock.method(fsp, "rmdir", async (p) => {
    if (p === finalDir) {
      fs.rmdirSync(finalDir);
      fs.writeFileSync(finalDir, "sentinel-user-data-raced-in-as-a-file");
      throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    }
    throw new Error(`unexpected rmdir(${p})`);
  });

  await assert.rejects(
    publishStagingDirectory(staging, finalDir),
    /ディレクトリ以外/,
    "must be rejected by the non-directory guard, not treated as a free name"
  );

  assert.equal(fs.lstatSync(finalDir).isDirectory(), false, "must still be the regular file, not replaced by a directory");
  assert.equal(fs.readFileSync(finalDir, "utf8"), "sentinel-user-data-raced-in-as-a-file", "file content must be untouched");
  assert.deepEqual(fs.readdirSync(staging), ["m.wav"], "staging directory must still hold its original content");
});

test("publishStagingDirectory: window (a) is closed — finalDir is swapped for a regular file right after reserveFinalDirAsDirectory's lstat confirms it's a directory; must not blindly rename onto it, file survives byte-for-byte", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staging = makeStagingDir({ "o.wav": "ooo" });
  const finalDir = path.join(root, "window-a-swap");
  fs.mkdirSync(finalDir); // pre-existing empty directory — our own mkdir() will observe EEXIST,
  // forcing reserveFinalDirAsDirectory to lstat it to confirm it's a directory before returning.

  // Simulate a peer replacing finalDir with a regular file in the window between
  // reserveFinalDirAsDirectory's confirming lstat ("it's a directory, proceed") and renameOnto's
  // subsequent rmdir/rename. Before the window-(a) fix, renameOnto's first move was a speculative
  // fs.rename(src, finalDir) — and on Windows a directory-onto-existing-regular-file rename
  // succeeds unconditionally, so this swap used to destroy the file silently (reproduced manually
  // against the pre-fix code before this change: publishStagingDirectory resolved with no
  // exception and finalDir ended up holding the staged content, sentinel gone without a trace).
  // After the fix, renameOnto always rmdir()s first, and rmdir against a regular file fails with
  // ENOENT without touching it, so the swap must be caught by the non-directory guard instead.
  const originalLstat = fsp.lstat.bind(fsp);
  let swapped = false;
  t.mock.method(fsp, "lstat", async (p) => {
    const result = await originalLstat(p);
    if (p === finalDir && !swapped) {
      swapped = true;
      fs.rmdirSync(finalDir);
      fs.writeFileSync(finalDir, "sentinel-user-data-window-a");
    }
    return result;
  });

  await assert.rejects(
    publishStagingDirectory(staging, finalDir),
    /ディレクトリ以外/,
    "must be rejected by the non-directory guard, not blindly renamed onto"
  );

  assert.equal(fs.lstatSync(finalDir).isDirectory(), false, "must still be the regular file, not replaced by a directory");
  assert.equal(fs.readFileSync(finalDir, "utf8"), "sentinel-user-data-window-a", "file content must be untouched");
  assert.deepEqual(fs.readdirSync(staging), ["o.wav"], "staging directory must still hold its original content");
});

test("publishStagingDirectory: window (b) — KNOWN, ACCEPTED LIMITATION — a peer swaps finalDir for a regular file between our successful rmdir and our rename; the file IS destroyed today. This pins down the current (unsafe) behavior rather than asserting a safety we don't have; flip it if a no-replace rename primitive is ever introduced (see doc comment on publishStagingDirectory, window (b))", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staging = makeStagingDir({ "p.wav": "ppp" });
  const finalDir = path.join(root, "window-b-swap");
  fs.mkdirSync(finalDir); // pre-existing empty directory

  // Simulate a peer replacing finalDir with a regular file in the window between our own
  // successful rmdir(finalDir) and the immediately-following rename(src, finalDir) — the one
  // TOCTOU window that closing window (a) does NOT close (Node's fs has no no-replace rename
  // primitive for directories).
  const originalRmdir = fsp.rmdir.bind(fsp);
  t.mock.method(fsp, "rmdir", async (p) => {
    const result = await originalRmdir(p);
    if (p === finalDir) {
      fs.writeFileSync(finalDir, "sentinel-user-data-window-b");
    }
    return result;
  });

  // On Windows, renaming a directory onto an existing regular file succeeds unconditionally, so
  // this currently destroys the sentinel file without any error — publishStagingDirectory resolves
  // as if nothing unusual happened.
  await publishStagingDirectory(staging, finalDir);

  assert.equal(fs.existsSync(staging), false, "staging is consumed — publishStagingDirectory believes it succeeded normally");
  assert.deepEqual(fs.readdirSync(finalDir), ["p.wav"], "finalDir now holds the staged content — the peer's sentinel file was silently destroyed by our rename (window (b), not yet closable)");
});

test("publishStagingDirectory: N-way same-process concurrent publish to the same fresh target — exactly one winner every trial, every loser gets ConcurrentPublishError with its staging intact", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // 試行回数はfs.mkdir/rename/rmdirの実syscallバーストを伴うため、大きくしすぎると(このテスト
  // 自体は毎回成功するとしても)同時に実行される他のテストファイルのタイミング前提を乱しうる
  // (実測で、20試行だとnpm test全体実行時にmcp-cancellation-integration.test.mjsの100ms猶予の
  // アサーションが不安定になることを確認した)。8試行×3並列でも「常に勝者1・敗者は
  // ConcurrentPublishError」という契約は十分に検証できる。
  const TRIALS = 8;
  const CONCURRENCY = 3;
  for (let trial = 0; trial < TRIALS; trial++) {
    const finalDir = path.join(root, `race-${trial}`);
    const stagings = Array.from({ length: CONCURRENCY }, (_, i) => makeStagingDir({ [`${trial}-${i}.wav`]: `content-${trial}-${i}` }));

    const results = await Promise.allSettled(stagings.map((s) => publishStagingDirectory(s, finalDir)));

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, `trial ${trial}: exactly one publisher must win, got ${fulfilled.length}`);
    assert.equal(rejected.length, CONCURRENCY - 1, `trial ${trial}: every other publisher must be rejected`);
    for (const r of rejected) {
      assert.ok(
        r.reason instanceof ConcurrentPublishError,
        `trial ${trial}: loser must reject with ConcurrentPublishError, got ${r.reason?.name}: ${r.reason?.message}`
      );
    }

    // exactly one staging directory was consumed (the winner's); the rest must survive untouched.
    const survivingStagings = stagings.filter((s) => fs.existsSync(s));
    assert.equal(survivingStagings.length, CONCURRENCY - 1, `trial ${trial}: exactly the losers' staging directories must survive`);
    for (const s of survivingStagings) {
      assert.equal(fs.readdirSync(s).length, 1, `trial ${trial}: surviving staging dir ${s} must still hold its original file`);
    }
  }
});

test("publishStagingDirectory: real cross-process concurrent publish (barrier-synchronized) — exactly one process wins, the loser reports ConcurrentPublishError with its staging intact", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-publish-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const finalDir = path.join(root, "cross-process-race");
  const stagingA = makeStagingDir({ "a.wav": "process-a" });
  const stagingB = makeStagingDir({ "b.wav": "process-b" });
  const readyA = path.join(root, "ready-a");
  const readyB = path.join(root, "ready-b");
  const goFile = path.join(root, "go");
  const resultA = path.join(root, "result-a.json");
  const resultB = path.join(root, "result-b.json");

  const spawnWorker = (stagingDir, readyFile, resultFile) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [raceWorkerPath, stagingDir, finalDir, readyFile, goFile, resultFile], {
        stdio: "ignore",
      });
      child.on("error", reject);
      child.on("exit", () => resolve());
    });

  const childA = spawnWorker(stagingA, readyA, resultA);
  const childB = spawnWorker(stagingB, readyB, resultB);

  // Barrier: wait for both workers to signal readiness before releasing them, so the two
  // publishStagingDirectory calls actually overlap in real OS-level time rather than merely being
  // scheduled close together.
  const deadline = Date.now() + 10_000;
  while (!(fs.existsSync(readyA) && fs.existsSync(readyB))) {
    if (Date.now() > deadline) throw new Error("timed out waiting for both race workers to become ready");
    await new Promise((r) => setTimeout(r, 5));
  }
  fs.writeFileSync(goFile, "go");

  await Promise.all([childA, childB]);

  const outcomeA = JSON.parse(fs.readFileSync(resultA, "utf8"));
  const outcomeB = JSON.parse(fs.readFileSync(resultB, "utf8"));
  const outcomes = [outcomeA, outcomeB];

  const winners = outcomes.filter((o) => o.ok);
  const losers = outcomes.filter((o) => !o.ok);
  assert.equal(winners.length, 1, `exactly one process must win, got: ${JSON.stringify(outcomes)}`);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].name, "ConcurrentPublishError", `loser must report ConcurrentPublishError, got: ${JSON.stringify(losers[0])}`);

  const survivingStaging = outcomeA.ok ? stagingB : stagingA;
  assert.equal(fs.existsSync(survivingStaging), true, "the losing process's staging directory must survive untouched");
  assert.equal(fs.readdirSync(survivingStaging).length, 1);
});
