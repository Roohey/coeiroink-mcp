/**
 * 台本の行形式。呼び出し全体に適用し、自動判定はしない。
 * - legacy: 「話者名,セリフ」(最初の半角カンマで区切る。既定)
 * - styled: 「話者名,スタイル名,セリフ」(最初の2つの半角カンマで区切る)
 */
export const SCRIPT_FORMATS = ["legacy", "styled"] as const;
export type ScriptFormat = (typeof SCRIPT_FORMATS)[number];

export interface ScriptLine {
  lineNumber: number;
  speakerName: string;
  /**
   * styled形式で指定されたスタイル名。legacy形式の行と、styled形式でスタイル欄が空(空白のみを含む)の
   * 行ではプロパティ自体を持たない(=その話者の最初のスタイル)。
   */
  styleName?: string;
  text: string;
}

// synthesize_scriptは全行のWAVを合成完了までメモリ(Buffer)に保持する設計のため、台本サイズを
// 際限なく受け入れるとMCPサーバープロセスがヒープ枯渇で落ちうる。行数・合計文字数に上限を設けて
// 合成開始前に早期リジェクトする。
export const MAX_SCRIPT_LINES = 500;
export const MAX_SCRIPT_TOTAL_CHARS = 50_000;

/**
 * 台本をパースする。formatは呼び出し全体に適用する(既定はlegacy)。空行・#始まりの行は無視し、
 * 元の行番号を保持する。不正な行はまとめてエラー報告する。引用符は通常の文字として扱い、
 * CSVの引用・エスケープ処理はしない(セリフ内の半角カンマは区切り以降ならそのまま残る)。
 */
export function parseScript(script: string, format: ScriptFormat = "legacy"): ScriptLine[] {
  const lines: ScriptLine[] = [];
  const errors: string[] = [];
  script.split(/\r\n|\r|\n/).forEach((raw, i) => {
    const lineNumber = i + 1;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const firstComma = trimmed.indexOf(",");
    let speakerName: string;
    let styleName: string | undefined;
    let text: string;
    if (format === "styled") {
      const secondComma = firstComma === -1 ? -1 : trimmed.indexOf(",", firstComma + 1);
      if (secondComma === -1) {
        errors.push(
          `${lineNumber}行目: 「話者名,スタイル名,セリフ」の形式ではありません(カンマが2つ必要です。スタイルを省略する場合は「話者名,,セリフ」): ${trimmed}`
        );
        return;
      }
      speakerName = trimmed.slice(0, firstComma).trim();
      // 空(空白のみを含む)のスタイル欄は省略扱い。""のままresolveStyleへ渡すと実在しない名前として
      // 検索されてしまうため、ここでundefinedに正規化する。
      styleName = trimmed.slice(firstComma + 1, secondComma).trim() || undefined;
      text = trimmed.slice(secondComma + 1).trim();
    } else {
      if (firstComma === -1) {
        errors.push(`${lineNumber}行目: 「話者名,セリフ」の形式ではありません(カンマがありません): ${trimmed}`);
        return;
      }
      speakerName = trimmed.slice(0, firstComma).trim();
      text = trimmed.slice(firstComma + 1).trim();
    }
    if (!speakerName) {
      errors.push(`${lineNumber}行目: 話者名が空です: ${trimmed}`);
      return;
    }
    if (!text) {
      errors.push(`${lineNumber}行目: セリフが空です: ${trimmed}`);
      return;
    }
    lines.push(styleName === undefined ? { lineNumber, speakerName, text } : { lineNumber, speakerName, styleName, text });
  });
  if (errors.length > 0) throw new Error(`台本の解析に失敗しました:\n${errors.join("\n")}`);
  if (lines.length === 0) throw new Error("台本に有効な行が1つもありません。");
  if (lines.length > MAX_SCRIPT_LINES) {
    throw new Error(`台本の行数が多すぎます(${lines.length}行 > 上限${MAX_SCRIPT_LINES}行)。台本を分割して実行してください。`);
  }
  const totalChars = lines.reduce((sum, l) => sum + l.text.length, 0);
  if (totalChars > MAX_SCRIPT_TOTAL_CHARS) {
    throw new Error(
      `台本の合計文字数が多すぎます(${totalChars}文字 > 上限${MAX_SCRIPT_TOTAL_CHARS}文字)。台本を分割して実行してください。`
    );
  }
  return lines;
}

/** WAVファイル名に使えない文字を置換する(Windowsの禁則文字: \ / : * ? " < > |)。 */
export function sanitizeFileNamePart(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
}
