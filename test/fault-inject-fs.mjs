// テスト専用のpreloadモジュール。`node --import <このファイルのfile://URL> <対象スクリプト>`
// として使う(本番の install:codex / uninstall:codex では読み込まれない)。
// COEIROINK_MCP_TEST_FAULT_INJECT_STEP に "write"|"fsync"|"rename" を設定すると、
// fs.writeFileSync/fsyncSync/renameSyncのうち該当する1つだけを合成エラーで置き換える。
// scripts/atomic-write-file.mjs のwriteFileAtomicはこの3関数だけを使うため、
// install-codex.mjs/uninstall-codex.mjsをsubprocessとして起動したまま(モック不可能な
// プロセス境界を越えて)、一時ファイル書き込み・fsync・rename各段階の障害注入を
// 実スクリプト経由で検証できる。未設定時は何もしない。
import fs from "node:fs";

const step = process.env.COEIROINK_MCP_TEST_FAULT_INJECT_STEP;
if (step) {
  const makeError = () => Object.assign(new Error(`injected test fault at step=${step}`), { code: "ETESTFAULT" });
  if (step === "write") {
    fs.writeFileSync = () => {
      throw makeError();
    };
  } else if (step === "fsync") {
    fs.fsyncSync = () => {
      throw makeError();
    };
  } else if (step === "rename") {
    fs.renameSync = () => {
      throw makeError();
    };
  } else {
    throw new Error(`unknown COEIROINK_MCP_TEST_FAULT_INJECT_STEP: ${step}`);
  }
}
