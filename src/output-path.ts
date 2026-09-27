import path from "node:path";

/** synthesize/synthesize_scriptの出力先パス検証エラー。呼び出し元(MCPツール)へそのままエラーメッセージとして返る。 */
export class InvalidOutputPathError extends Error {}

// Windowsでは"/foo/bar"や"\foo\bar"のようなドライブレターを持たない「ルート相対」パスも
// path.isAbsoluteはtrueを返すが、実際にはプロセスの「カレントドライブ」に依存して解決される
// (例: cwdがC:\...ならC:\foo\barになる)。cwd相対パスと同様、呼び出し元が制御できない実行時の
// 状態に依存するため、Windowsではドライブレター付きの完全修飾パスのみを受け付ける。
const WINDOWS_DRIVE_ABSOLUTE = /^[a-zA-Z]:[\\/]/;

/**
 * synthesize/synthesize_scriptの出力先パスを検証し、正規化済みの絶対パスを返す。
 *
 * 相対パスはこのMCPサーバープロセスのcwd(呼び出し元エージェントのプロジェクトディレクトリで
 * あることが多い)を基準に解決されてしまうため、一語の相対パス(例: "package.json"や"../../escape.wav")で
 * プロジェクト内外の任意ファイルを書き換え・破壊できてしまう。絶対パスのみを許可し、cwd相対の
 * 解決が一切発生しないようにする。Windowsではさらに、ドライブレターを持たないルート相対パスも
 * 実行時のカレントドライブに依存するため拒否し、ドライブレター付きの完全修飾パスのみを許可する。
 *
 * UNCパス(\\host\share\...)と\\?\プレフィックス(Windows拡張長パス)も、意図しないネットワーク共有・
 * 特殊デバイスへの書き込み経路になりうるため拒否する。
 */
export function validateOutputPath(p: string): string {
  if (p.startsWith("\\\\?\\") || p.startsWith("//?/")) {
    throw new InvalidOutputPathError(`\\\\?\\形式の拡張長パスは指定できません: ${JSON.stringify(p)}`);
  }
  if (/^\\\\/.test(p) || /^\/\//.test(p)) {
    throw new InvalidOutputPathError(`UNCパス(ネットワーク共有)は指定できません: ${JSON.stringify(p)}`);
  }
  if (!path.isAbsolute(p)) {
    throw new InvalidOutputPathError(`出力先パスは絶対パスで指定してください(相対パスは不可): ${JSON.stringify(p)}`);
  }
  if (process.platform === "win32" && !WINDOWS_DRIVE_ABSOLUTE.test(p)) {
    throw new InvalidOutputPathError(
      `出力先パスはドライブレターを含む絶対パス(例: "C:\\Users\\...\\out.wav")で指定してください。` +
        `先頭が"\\"や"/"だけのパスは実行時のカレントドライブに依存するため使用できません: ${JSON.stringify(p)}`
    );
  }
  return path.resolve(p);
}
