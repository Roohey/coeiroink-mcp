import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * finalPathと同じディレクトリの一時ファイルへ書き込み、fsyncしてからrenameで置換する。
 * 書き込み・fsync・renameのいずれかで失敗した場合は一時ファイルを削除し、最終ファイルには
 * 一切触れない(最終パスへ直接writeFileSyncする実装だと、書き込み途中の障害(ディスクフル等)で
 * 最終ファイルがパース不能な断片に化けて既存設定を失いうる)。
 */
export function writeFileAtomic(finalPath, data) {
  const dir = path.dirname(finalPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `${path.basename(finalPath)}.tmp-${randomUUID()}`);
  let fd;
  try {
    fd = fs.openSync(tmpPath, "w");
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, finalPath);
  } catch (e) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // 既に閉じている等、後始末の失敗は無視(元ファイルの保護が優先)
      }
    }
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // 後始末の失敗は無視(元ファイルの保護が優先)
    }
    throw e;
  }
}
