// publishStagingDirectoryへの実プロセス間の同時公開を再現するための使い捨てワーカー。
// test/atomic-publish.test.mjsから、node <このファイル> stagingDir finalDir readyFile goFile
// resultFile として子プロセス起動される。他プロセス(親・もう一方のワーカー)がreadyFileの
// 出現をポーリングしてバリア同期を行い、goFileが出現するまで両者を足止めしてからほぼ同時に
// publishStagingDirectoryを呼び出すことで、単一プロセス内のPromise.allSettledでは保証できない
// 実際のOSレベルの競合を検証する。
//
// このファイルは`test/`配下にあるため`npm test`(引数なしのnode --test)の既定探索パターン
// (`**/test/**/*.?(c|m)js`、ファイル名に関わらずtestディレクトリ配下の全jsファイルを対象にする)
// にも拾われてしまう。その際に想定引数なしで直接実行されても副作用(fs.writeFileSync等)が
// 起きないよう、想定される引数が揃っている場合だけ実処理を行う(test/fault-inject-fs.mjsと
// 同じ「トリガー条件が無ければ何もしないモジュール」という方針)。
import fs from "node:fs";

async function main(stagingDir, finalDir, readyFile, goFile, resultFile) {
  const { publishStagingDirectory } = await import("../dist/atomic-publish.js");

  fs.writeFileSync(readyFile, "ready");

  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(goFile)) {
    if (Date.now() > deadline) {
      fs.writeFileSync(resultFile, JSON.stringify({ ok: false, name: "TimeoutWaitingForGoFile" }));
      process.exit(1);
    }
  }

  try {
    await publishStagingDirectory(stagingDir, finalDir);
    fs.writeFileSync(resultFile, JSON.stringify({ ok: true }));
  } catch (e) {
    fs.writeFileSync(resultFile, JSON.stringify({ ok: false, name: e.name, message: e.message }));
  }
}

const [, , stagingDir, finalDir, readyFile, goFile, resultFile] = process.argv;
if (resultFile) {
  await main(stagingDir, finalDir, readyFile, goFile, resultFile);
}
