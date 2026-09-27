export interface ScriptLine {
  lineNumber: number;
  speakerName: string;
  text: string;
}

// synthesize_scriptは全行のWAVを合成完了までメモリ(Buffer)に保持する設計のため、台本サイズを
// 際限なく受け入れるとMCPサーバープロセスがヒープ枯渇で落ちうる。行数・合計文字数に上限を設けて
// 合成開始前に早期リジェクトする。
export const MAX_SCRIPT_LINES = 500;
export const MAX_SCRIPT_TOTAL_CHARS = 50_000;

/** 「話者名,セリフ」形式の台本をパースする。空行・#始まりの行は無視。不正な行はまとめてエラー報告する。 */
export function parseScript(script: string): ScriptLine[] {
  const lines: ScriptLine[] = [];
  const errors: string[] = [];
  script.split(/\r\n|\r|\n/).forEach((raw, i) => {
    const lineNumber = i + 1;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const commaIndex = trimmed.indexOf(",");
    if (commaIndex === -1) {
      errors.push(`${lineNumber}行目: 「話者名,セリフ」の形式ではありません(カンマがありません): ${trimmed}`);
      return;
    }
    const speakerName = trimmed.slice(0, commaIndex).trim();
    const text = trimmed.slice(commaIndex + 1).trim();
    if (!speakerName) {
      errors.push(`${lineNumber}行目: 話者名が空です: ${trimmed}`);
      return;
    }
    if (!text) {
      errors.push(`${lineNumber}行目: セリフが空です: ${trimmed}`);
      return;
    }
    lines.push({ lineNumber, speakerName, text });
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
